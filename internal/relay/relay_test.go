package relay_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"capybrowserrelay/internal/fakeext"
	"capybrowserrelay/internal/relay"
)

type env struct {
	t     *testing.T
	srv   *relay.Server
	ts    *httptest.Server
	owner string
	tid   string
	now   time.Time
	mu    sync.Mutex
}

func (e *env) clock() time.Time        { e.mu.Lock(); defer e.mu.Unlock(); return e.now }
func (e *env) advance(d time.Duration) { e.mu.Lock(); e.now = e.now.Add(d); e.mu.Unlock() }

func newEnv(t *testing.T, mod func(*relay.Config)) *env {
	e := &env{t: t, now: time.Now()}
	cfg := relay.Config{AdminToken: "adm", Now: e.clock}
	if mod != nil {
		mod(&cfg)
	}
	srv, err := relay.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	e.srv, e.ts = srv, httptest.NewServer(srv.Handler())
	t.Cleanup(e.ts.Close)
	e.owner, e.tid = e.newTenant("acme")
	return e
}

func (e *env) do(method, path, token string, body any) (int, map[string]any) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, e.ts.URL+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (e *env) newTenant(name string) (string, string) {
	c, out := e.do("POST", "/admin/tenants", "adm", map[string]string{"name": name})
	if c != 201 {
		e.t.Fatalf("tenant: %d %v", c, out)
	}
	return out["owner_token"].(string), out["tenant_id"].(string)
}

func (e *env) code(owner string) string {
	c, out := e.do("POST", "/v1/owner/pair-codes", owner, nil)
	if c != 201 {
		e.t.Fatalf("code: %d", c)
	}
	return out["code"].(string)
}

// device pairs and connects a fake extension for the given owner.
func (e *env) device(owner, name string) *fakeext.Client {
	x := fakeext.New(e.ts.URL)
	if c, _ := x.Pair(e.code(owner), name); c != 201 {
		e.t.Fatalf("pair: %d", c)
	}
	if err := x.Connect(); err != nil {
		e.t.Fatal(err)
	}
	e.t.Cleanup(x.Disconnect)
	waitOnline(e.t, e.srv, x.DeviceID)
	return x
}

func waitOnline(t *testing.T, s *relay.Server, id string) {
	for i := 0; i < 200; i++ {
		if s.Hub.Online(id) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("device never became online")
}

func (e *env) agent(owner string, scopes, domains []string, extra map[string]any) string {
	body := map[string]any{"name": "agent", "scopes": scopes, "domains": domains}
	for k, v := range extra {
		body[k] = v
	}
	c, out := e.do("POST", "/v1/owner/agents", owner, body)
	if c != 201 {
		e.t.Fatalf("agent: %d %v", c, out)
	}
	return out["token"].(string)
}

// mcp sends one JSON-RPC request and returns the "result" object.
func (e *env) mcp(token, method string, params any) (int, map[string]any) {
	body := map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
	code, out := e.do("POST", "/mcp", token, body)
	if r, ok := out["result"].(map[string]any); ok {
		return code, r
	}
	return code, out
}

func (e *env) tool(token, name string, args map[string]any) (bool, string) {
	_, r := e.mcp(token, "tools/call", map[string]any{"name": name, "arguments": args})
	content, _ := r["content"].([]any)
	if len(content) == 0 {
		e.t.Fatalf("no content: %v", r)
	}
	c := content[0].(map[string]any)
	txt, _ := c["text"].(string)
	if c["type"] == "image" {
		txt = "image:" + c["data"].(string)
	}
	isErr, _ := r["isError"].(bool)
	return isErr, txt
}

func code(txt string) string {
	var v struct {
		Code string `json:"code"`
	}
	json.Unmarshal([]byte(txt), &v)
	return v.Code
}

var all = []string{"read", "act", "upload", "record"}

// ---------- pairing ----------

func TestPairingSingleUseAndExpiry(t *testing.T) {
	e := newEnv(t, nil)
	c := e.code(e.owner)
	x1, x2 := fakeext.New(e.ts.URL), fakeext.New(e.ts.URL)
	if s, _ := x1.Pair(c, "laptop"); s != 201 {
		t.Fatalf("first use: %d", s)
	}
	if s, _ := x2.Pair(c, "second"); s != 403 {
		t.Fatalf("code reused: %d", s)
	}
	c2 := e.code(e.owner)
	e.advance(5*time.Minute + time.Second)
	if s, _ := x2.Pair(c2, "late"); s != 403 {
		t.Fatalf("expired code accepted: %d", s)
	}
	c3 := e.code(e.owner)
	e.advance(4*time.Minute + 59*time.Second)
	if s, _ := x2.Pair(c3, "justintime"); s != 201 {
		t.Fatalf("code within 5 min refused: %d", s)
	}
}

func TestPairingBruteForceLimit(t *testing.T) {
	e := newEnv(t, nil)
	good := e.code(e.owner)
	x := fakeext.New(e.ts.URL)
	for i := 0; i < 10; i++ {
		if s, _ := x.Pair("WRONGCOD", "d"); s != 403 {
			t.Fatalf("attempt %d: %d", i, s)
		}
	}
	if s, _ := x.Pair(good, "d"); s != 429 {
		t.Fatalf("not rate limited: %d", s)
	}
	e.advance(6 * time.Minute)
	if s, _ := x.Pair(good, "d"); s == 429 {
		t.Fatal("limit did not reset")
	}
}

func TestHashedAtRest(t *testing.T) {
	dir := t.TempDir()
	e := newEnv(t, func(c *relay.Config) { c.DataDir = dir })
	x := e.device(e.owner, "laptop")
	tok := e.agent(e.owner, all, []string{"example.com"}, nil)
	e.do("POST", "/v1/owner/pair-codes", e.owner, nil)
	for _, secret := range []string{x.Token, tok, e.owner} {
		for _, f := range []string{"state.json", "audit.log"} {
			b, _ := readFile(dir + "/" + f)
			if strings.Contains(string(b), secret) {
				t.Fatalf("secret stored in clear in %s", f)
			}
		}
	}
}

// ---------- tokens, scopes, allowlist ----------

func TestScopes(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	tab := x.AddTab("https://example.com/", "Ex", "hello world")
	ro := e.agent(e.owner, []string{"read"}, []string{"example.com"}, nil)

	isErr, txt := e.tool(ro, "browser_read_page", map[string]any{"tab_id": tab})
	if isErr || !strings.Contains(txt, "hello world") {
		t.Fatalf("read: %v %s", isErr, txt)
	}
	isErr, txt = e.tool(ro, "browser_click", map[string]any{"tab_id": tab, "selector": "#go"})
	if !isErr || code(txt) != "scope_denied" {
		t.Fatalf("click with read scope: %s", txt)
	}
	// tools/list shows only what the scopes allow
	_, r := e.mcp(ro, "tools/list", nil)
	for _, tl := range r["tools"].([]any) {
		n := tl.(map[string]any)["name"].(string)
		if n == "browser_click" || n == "browser_navigate" {
			t.Fatalf("read-only agent sees %s", n)
		}
	}
	if len(x.Commands()) != 1 {
		t.Fatalf("denied call reached the browser: %v", x.Commands())
	}
}

func TestTokenIsolationDeviceVsAgent(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	// a device token must not work as an agent token, an agent token not as owner
	if c, _ := e.mcp(x.Token, "tools/list", nil); c != 401 {
		t.Fatalf("device token on /mcp: %d", c)
	}
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	if c, _ := e.do("POST", "/v1/owner/pair-codes", ag, nil); c != 401 {
		t.Fatalf("agent token as owner: %d", c)
	}
	if c, _ := e.mcp("", "tools/list", nil); c != 401 {
		t.Fatalf("no token: %d", c)
	}
}

func TestAgentExpiry(t *testing.T) {
	e := newEnv(t, nil)
	e.device(e.owner, "laptop")
	ag := e.agent(e.owner, all, []string{"example.com"}, map[string]any{"ttl_seconds": 60})
	if c, _ := e.mcp(ag, "tools/list", nil); c != 200 {
		t.Fatalf("before expiry: %d", c)
	}
	e.advance(61 * time.Second)
	if c, _ := e.mcp(ag, "tools/list", nil); c != 401 {
		t.Fatalf("after expiry: %d", c)
	}
}

func TestDomainAllowlist(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	good := x.AddTab("https://app.example.com/x", "ok", "secret-ok")
	bad := x.AddTab("https://evil.test/", "bad", "secret-bad")
	bank := x.AddTab("https://online.sberbank.ru/", "bank", "money")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)

	// tabs_list hides everything outside the allowlist (and the always-denied hosts)
	_, txt := e.tool(ag, "browser_tabs_list", nil)
	if !strings.Contains(txt, "app.example.com") || strings.Contains(txt, "evil.test") || strings.Contains(txt, "sberbank") {
		t.Fatalf("tabs_list leaked: %s", txt)
	}
	// relay refuses navigation outside the list before the browser sees it
	n := len(x.Commands())
	isErr, txt := e.tool(ag, "browser_navigate", map[string]any{"tab_id": good, "url": "https://evil.test/"})
	if !isErr || code(txt) != "domain_denied" || len(x.Commands()) != n {
		t.Fatalf("navigate outside list: %s", txt)
	}
	// extension-side check
	isErr, txt = e.tool(ag, "browser_read_page", map[string]any{"tab_id": bad})
	if !isErr || code(txt) != "domain_denied" || strings.Contains(txt, "secret-bad") {
		t.Fatalf("read outside list: %s", txt)
	}
	isErr, txt = e.tool(ag, "browser_read_page", map[string]any{"tab_id": bank})
	if !isErr || code(txt) != "domain_denied" {
		t.Fatalf("bank: %s", txt)
	}
	// a compromised extension that skips its own check is still caught by the relay
	x.Misbehave = true
	isErr, txt = e.tool(ag, "browser_read_page", map[string]any{"tab_id": bad})
	if !isErr || code(txt) != "domain_denied" || strings.Contains(txt, "secret-bad") {
		t.Fatalf("relay-side filter: %s", txt)
	}
	// empty allowlist means nothing at all
	none := e.agent(e.owner, all, nil, nil)
	isErr, txt = e.tool(none, "browser_tabs_open", map[string]any{"url": "https://example.com/"})
	if !isErr || code(txt) != "domain_denied" {
		t.Fatalf("empty allowlist: %s", txt)
	}
	// non-http schemes never pass
	for _, u := range []string{"chrome://settings", "file:///etc/passwd", "https://chrome.google.com/webstore/x"} {
		if relay.DomainAllowed([]string{"example.com", "chrome.google.com", "settings"}, u) {
			t.Fatalf("%s allowed", u)
		}
	}
}

// ---------- revocation ----------

func TestRevokeDeviceUnder2s(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	start := time.Now()
	if c, _ := e.do("DELETE", "/v1/owner/devices/"+x.DeviceID, e.owner, nil); c != 200 {
		t.Fatalf("revoke: %d", c)
	}
	select {
	case <-x.Closed():
	case <-time.After(2 * time.Second):
		t.Fatal("socket still open after 2 s")
	}
	t.Logf("device socket closed %v after revoke", time.Since(start))
	if err := x.Connect(); err == nil {
		t.Fatal("revoked device token accepted")
	}
}

func TestRevokeAgentImmediate(t *testing.T) {
	e := newEnv(t, nil)
	e.device(e.owner, "laptop")
	c, out := e.do("POST", "/v1/owner/agents", e.owner, map[string]any{"name": "a", "scopes": all, "domains": []string{"example.com"}})
	if c != 201 {
		t.Fatal(c)
	}
	tok, id := out["token"].(string), out["agent_id"].(string)
	if cc, _ := e.mcp(tok, "tools/list", nil); cc != 200 {
		t.Fatal(cc)
	}
	e.do("DELETE", "/v1/owner/agents/"+id, e.owner, nil)
	if cc, _ := e.mcp(tok, "tools/list", nil); cc != 401 {
		t.Fatalf("revoked agent still works: %d", cc)
	}
}

func TestKillSwitch(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	e.do("POST", "/v1/owner/kill", e.owner, nil)
	select {
	case <-x.Closed():
	case <-time.After(2 * time.Second):
		t.Fatal("kill did not close the socket")
	}
	if c, _ := e.mcp(ag, "tools/list", nil); c != 401 {
		t.Fatalf("agent survives kill: %d", c)
	}
}

// ---------- tenants ----------

func TestTenantIsolation(t *testing.T) {
	e := newEnv(t, nil)
	owner2, _ := e.newTenant("other")
	x1 := e.device(e.owner, "laptop-1")
	x2 := e.device(owner2, "laptop-2")
	t1 := x1.AddTab("https://example.com/", "one", "tenant-one")
	x2.AddTab("https://example.com/", "two", "tenant-two")
	ag1 := e.agent(e.owner, all, []string{"example.com"}, nil)

	_, txt := e.tool(ag1, "browser_list", nil)
	if strings.Contains(txt, x2.DeviceID) || !strings.Contains(txt, x1.DeviceID) {
		t.Fatalf("list_browsers crosses tenants: %s", txt)
	}
	// explicitly naming the other tenant's browser must fail
	isErr, txt := e.tool(ag1, "browser_read_page", map[string]any{"tab_id": t1, "browser": x2.DeviceID})
	if !isErr || code(txt) != "unknown_browser" || len(x2.Commands()) != 0 {
		t.Fatalf("cross-tenant call: %s", txt)
	}
	// owner 2 cannot revoke tenant 1's device or see its agents
	if c, _ := e.do("DELETE", "/v1/owner/devices/"+x1.DeviceID, owner2, nil); c != 404 {
		t.Fatalf("cross-tenant revoke: %d", c)
	}
	_, out := e.do("GET", "/v1/owner/agents", owner2, nil)
	if l, _ := out["agents"].([]any); len(l) != 0 {
		t.Fatalf("agents leak: %v", out)
	}
	// cannot bind an agent to a foreign browser
	if c, _ := e.do("POST", "/v1/owner/agents", e.owner, map[string]any{"name": "x", "scopes": all, "browsers": []string{x2.DeviceID}}); c != 400 {
		t.Fatalf("foreign browser bound: %d", c)
	}
}

// ---------- browsers, queue, offline ----------

func TestSelectionOfferedAndOffline(t *testing.T) {
	e := newEnv(t, nil)
	ag := func() string { return e.agent(e.owner, all, []string{"example.com"}, nil) }()

	isErr, txt := e.tool(ag, "browser_tabs_list", nil)
	if !isErr || code(txt) != "no_browser" {
		t.Fatalf("no browser: %s", txt)
	}
	x1 := e.device(e.owner, "home")
	e.device(e.owner, "office")
	isErr, txt = e.tool(ag, "browser_tabs_list", nil)
	if !isErr || code(txt) != "ambiguous_browser" {
		t.Fatalf("two browsers: %s", txt)
	}
	isErr, _ = e.tool(ag, "browser_tabs_list", map[string]any{"browser": "home"})
	if isErr {
		t.Fatal("select by name failed")
	}
	x1.Disconnect()
	<-x1.Closed()
	for i := 0; i < 100 && e.srv.Hub.Online(x1.DeviceID); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	isErr, txt = e.tool(ag, "browser_tabs_list", map[string]any{"browser": "home"})
	if !isErr || code(txt) != "browser_offline" {
		t.Fatalf("offline: %s", txt)
	}
}

func TestQueueSerialisesPerBrowser(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	x.Delay = 40 * time.Millisecond
	tab := x.AddTab("https://example.com/", "t", "text")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if isErr, txt := e.tool(ag, "browser_read_page", map[string]any{"tab_id": tab}); isErr {
				t.Error(txt)
			}
		}()
	}
	wg.Wait()
	if x.MaxPar != 1 {
		t.Fatalf("commands ran in parallel on one browser: %d", x.MaxPar)
	}
	if len(x.Commands()) != 5 {
		t.Fatalf("commands: %v", x.Commands())
	}
}

func TestCrossTabConcurrencyDoesNotBlock(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	x.Delay = 80 * time.Millisecond
	tab1 := x.AddTab("https://example.com/1", "t1", "text 1")
	tab2 := x.AddTab("https://example.com/2", "t2", "text 2")
	ag1 := e.agent(e.owner, all, []string{"example.com"}, nil)
	ag2 := e.agent(e.owner, all, []string{"example.com"}, nil)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		if isErr, txt := e.tool(ag1, "browser_read_page", map[string]any{"tab_id": tab1}); isErr {
			t.Error(txt)
		}
	}()
	go func() {
		defer wg.Done()
		if isErr, txt := e.tool(ag2, "browser_read_page", map[string]any{"tab_id": tab2}); isErr {
			t.Error(txt)
		}
	}()
	wg.Wait()
	if x.MaxPar < 2 {
		t.Fatalf("expected cross-tab commands to execute in parallel, but MaxPar was %d", x.MaxPar)
	}
}

func TestQueueFullAndExpiry(t *testing.T) {
	hub := relay.NewHub()
	hub.QueueSize = 2
	hub.QueueTTL = 50 * time.Millisecond
	e := newEnv(t, func(c *relay.Config) { c.Hub = hub })
	x := e.device(e.owner, "laptop")
	x.Delay = 300 * time.Millisecond
	tab := x.AddTab("https://example.com/", "t", "text")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)

	res := make(chan string, 6)
	for i := 0; i < 6; i++ {
		go func() {
			_, txt := e.tool(ag, "browser_read_page", map[string]any{"tab_id": tab})
			res <- code(txt)
		}()
		time.Sleep(15 * time.Millisecond)
	}
	got := map[string]int{}
	for i := 0; i < 6; i++ {
		got[<-res]++
	}
	if got["queue_full"] == 0 || got["command_expired"] == 0 {
		t.Fatalf("expected queue_full and command_expired, got %v", got)
	}
}

func TestRateLimit(t *testing.T) {
	e := newEnv(t, func(c *relay.Config) { c.RatePerMin = 3 })
	x := e.device(e.owner, "laptop")
	tab := x.AddTab("https://example.com/", "t", "text")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	var last string
	for i := 0; i < 4; i++ {
		_, txt := e.tool(ag, "browser_read_page", map[string]any{"tab_id": tab})
		last = code(txt)
	}
	if last != "rate_limited" {
		t.Fatalf("4th call: %q", last)
	}
	e.advance(61 * time.Second)
	if isErr, txt := e.tool(ag, "browser_read_page", map[string]any{"tab_id": tab}); isErr {
		t.Fatalf("after window: %s", txt)
	}
}

// ---------- full tool path, confirmation, needs_human ----------

func TestToolsEndToEnd(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)

	// initialize negotiates the version
	_, r := e.mcp(ag, "initialize", map[string]any{"protocolVersion": "2025-03-26"})
	if r["protocolVersion"] != "2025-03-26" {
		t.Fatalf("init: %v", r)
	}
	isErr, txt := e.tool(ag, "browser_tabs_open", map[string]any{"url": "https://example.com/form"})
	if isErr {
		t.Fatal(txt)
	}
	var opened struct {
		TabID int `json:"tab_id"`
	}
	json.Unmarshal([]byte(txt), &opened)
	if isErr, txt = e.tool(ag, "browser_form_input", map[string]any{"tab_id": opened.TabID, "selector": "#q", "value": "capybara"}); isErr {
		t.Fatal(txt)
	}
	if x.Field(opened.TabID, "#q") != "capybara" {
		t.Fatal("field not set")
	}
	if isErr, txt = e.tool(ag, "browser_type", map[string]any{"tab_id": opened.TabID, "selector": "#q2", "text": "abc"}); isErr {
		t.Fatal(txt)
	}
	if isErr, txt = e.tool(ag, "browser_click", map[string]any{"tab_id": opened.TabID, "ref": "e2"}); isErr {
		t.Fatal(txt)
	}
	if isErr, txt = e.tool(ag, "browser_read_page", map[string]any{"tab_id": opened.TabID, "mode": "snapshot"}); isErr || !strings.Contains(txt, "textbox") {
		t.Fatal(txt)
	}
	if isErr, txt = e.tool(ag, "browser_screenshot", map[string]any{"tab_id": opened.TabID}); isErr || !strings.HasPrefix(txt, "image:") {
		t.Fatal(txt)
	}
	// missing argument is a tool error, not a crash
	if isErr, _ = e.tool(ag, "browser_navigate", map[string]any{"tab_id": 1}); !isErr {
		t.Fatal("missing url accepted")
	}
	// passwords are left to the human
	isErr, txt = e.tool(ag, "browser_type", map[string]any{"tab_id": opened.TabID, "selector": "input#password", "text": "x"})
	if !isErr || code(txt) != "needs_human" {
		t.Fatalf("password: %s", txt)
	}
}

func TestConfirmationStubDeclines(t *testing.T) {
	e := newEnv(t, nil) // default StubConfirmer
	x := e.device(e.owner, "laptop")
	tab := x.AddTab("https://example.com/", "t", "text")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	isErr, txt := e.tool(ag, "browser_click", map[string]any{"tab_id": tab, "selector": "#delete-account"})
	if !isErr || code(txt) != "needs_owner_confirmation" {
		t.Fatalf("dangerous click: %s", txt)
	}
	if got := x.Commands(); len(got) != 1 {
		t.Fatalf("command re-sent without approval: %v", got)
	}
	// the request is in the audit trail
	_, out := e.do("GET", "/v1/owner/audit", e.owner, nil)
	if !strings.Contains(toJSON(out), `"confirmation"`) {
		t.Fatalf("no confirmation entry: %v", out)
	}
}

func TestConfirmationApproved(t *testing.T) {
	ap := &okConfirmer{}
	e := newEnv(t, func(c *relay.Config) { c.Confirmer = ap })
	x := e.device(e.owner, "laptop")
	tab := x.AddTab("https://example.com/", "t", "text")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	isErr, txt := e.tool(ag, "browser_click", map[string]any{"tab_id": tab, "selector": "#delete-account"})
	if isErr {
		t.Fatalf("approved click failed: %s", txt)
	}
	if len(x.Commands()) != 2 || x.Confirms[1] != true || x.Confirms[0] != false {
		t.Fatalf("expected resend with confirmed=true: %v %v", x.Commands(), x.Confirms)
	}
	if ap.n != 1 {
		t.Fatalf("hook calls: %d", ap.n)
	}
	_, out := e.do("GET", "/v1/owner/audit", e.owner, nil)
	if !strings.Contains(toJSON(out), "owner-test") {
		t.Fatalf("confirmed_by missing: %v", out)
	}
}

func TestFileUploadAlwaysAsksOwner(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	tab := x.AddTab("https://example.com/", "t", "text")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	// file_upload is not an MCP tool in slice 1, but the JSON fallback reaches Execute
	_, out := e.do("POST", "/v1/call", ag, map[string]any{"command": "file_upload", "args": map[string]any{"tab_id": tab}})
	if out["ok"] != false || len(x.Commands()) != 0 {
		t.Fatalf("upload reached the browser without owner: %v %v", out, x.Commands())
	}
}

// ---------- audit ----------

func TestAuditMetadataOnly(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	tab := x.AddTab("https://example.com/", "t", "PAGE-CONTENT-SECRET")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	e.tool(ag, "browser_read_page", map[string]any{"tab_id": tab})
	e.tool(ag, "browser_type", map[string]any{"tab_id": tab, "selector": "#q", "text": "TYPED-SECRET"})
	e.tool(ag, "browser_navigate", map[string]any{"tab_id": tab, "url": "https://evil.test/"})

	_, out := e.do("GET", "/v1/owner/audit", e.owner, nil)
	s := toJSON(out)
	for _, bad := range []string{"PAGE-CONTENT-SECRET", "TYPED-SECRET", ag} {
		if strings.Contains(s, bad) {
			t.Fatalf("audit contains %q", bad)
		}
	}
	var calls, denied int
	for _, en := range out["entries"].([]any) {
		m := en.(map[string]any)
		if m["event"] == "call" {
			calls++
			if m["cmd"] == "" || m["agent"] != "agent" || m["domain"] == nil {
				t.Fatalf("incomplete entry: %v", m)
			}
			if m["result"] == "domain_denied" {
				denied++
			}
		}
	}
	if calls != 3 || denied != 1 {
		t.Fatalf("calls=%d denied=%d: %s", calls, denied, s)
	}
	// another tenant's audit stays empty of these
	o2, _ := e.newTenant("other")
	_, out2 := e.do("GET", "/v1/owner/audit", o2, nil)
	if strings.Contains(toJSON(out2), `"call"`) {
		t.Fatal("audit crosses tenants")
	}
}

func TestMCPHardening(t *testing.T) {
	e := newEnv(t, nil)
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	req, _ := http.NewRequest("POST", e.ts.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"ping"}`))
	req.Header.Set("Authorization", "Bearer "+ag)
	req.Header.Set("Origin", "https://evil.example")
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 403 {
		t.Fatalf("foreign Origin: %d", resp.StatusCode)
	}
	// notifications get 202 and no body
	req, _ = http.NewRequest("POST", e.ts.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","method":"notifications/initialized"}`))
	req.Header.Set("Authorization", "Bearer "+ag)
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != 202 {
		t.Fatalf("notification: %d", resp.StatusCode)
	}
	if c, _ := e.do("GET", "/mcp", ag, nil); c != 405 {
		t.Fatalf("GET /mcp: %d", c)
	}
}

func TestPersistenceAcrossRestart(t *testing.T) {
	dir := t.TempDir()
	e := newEnv(t, func(c *relay.Config) { c.DataDir = dir })
	x := e.device(e.owner, "laptop")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	srv2, err := relay.New(relay.Config{DataDir: dir, AdminToken: "adm"})
	if err != nil {
		t.Fatal(err)
	}
	ts2 := httptest.NewServer(srv2.Handler())
	defer ts2.Close()
	x2 := fakeext.New(ts2.URL)
	x2.DeviceID, x2.Token = x.DeviceID, x.Token
	if err := x2.Connect(); err != nil {
		t.Fatalf("device token lost over restart: %v", err)
	}
	defer x2.Disconnect()
	req, _ := http.NewRequest("POST", ts2.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
	req.Header.Set("Authorization", "Bearer "+ag)
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 200 {
		t.Fatalf("agent token lost over restart: %d", resp.StatusCode)
	}
}

type okConfirmer struct{ n int }

func (o *okConfirmer) Confirm(_ context.Context, _ relay.ConfirmRequest) relay.Decision {
	o.n++
	return relay.Decision{Approved: true, By: "owner-test"}
}

func toJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func readFile(p string) ([]byte, error) { return os.ReadFile(p) }

// Codex refuses to call MCP tools without annotations in non-interactive mode.
func TestToolAnnotations(t *testing.T) {
	e := newEnv(t, nil)
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	_, r := e.mcp(ag, "tools/list", nil)
	for _, tl := range r["tools"].([]any) {
		m := tl.(map[string]any)
		a, _ := m["annotations"].(map[string]any)
		if _, ok := a["readOnlyHint"]; !ok {
			t.Fatalf("%v has no readOnlyHint", m["name"])
		}
	}
}
