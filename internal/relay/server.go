package relay

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"capybrowserrelay/internal/ws"
)

type Config struct {
	DataDir        string
	AdminToken     string // optional; when empty a token is generated once and its hash stored
	Now            func() time.Time
	Confirmer      Confirmer
	PairTTL        time.Duration // default 5 min
	DeviceTTL      time.Duration // default 90 days
	RatePerMin     int           // per agent, default 120
	AllowedOrigins []string      // Origin values accepted on /mcp (default none)
	// RequireDeviceKey refuses to pair a browser without a public key and to
	// accept a device that has none.
	RequireDeviceKey bool
	Hub              *Hub
}

type Server struct {
	cfg   Config
	Store *Store
	Audit *Audit
	Hub   *Hub
	// NewAdminToken is set when a token was generated at first start.
	NewAdminToken string

	rmu     sync.Mutex
	rate    map[string][]time.Time // agent id -> call times
	pairBad map[string][]time.Time // ip -> failures
}

func New(cfg Config) (*Server, error) {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Confirmer == nil {
		cfg.Confirmer = StubConfirmer{}
	}
	if cfg.PairTTL == 0 {
		cfg.PairTTL = 5 * time.Minute
	}
	if cfg.DeviceTTL == 0 {
		cfg.DeviceTTL = 90 * 24 * time.Hour
	}
	if cfg.RatePerMin == 0 {
		cfg.RatePerMin = 120
	}
	if cfg.Hub == nil {
		cfg.Hub = NewHub()
	}
	st, err := OpenStore(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	au, err := OpenAudit(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	s := &Server{cfg: cfg, Store: st, Audit: au, Hub: cfg.Hub, rate: map[string][]time.Time{}, pairBad: map[string][]time.Time{}}
	if cfg.AdminToken == "" && st.AdminHash() == "" {
		b := make([]byte, 32)
		rand.Read(b)
		s.NewAdminToken = "cbr_admin_" + hex.EncodeToString(b)
		st.SetAdminHash(hashToken(s.NewAdminToken))
	}
	return s, nil
}

func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("POST /admin/tenants", s.handleCreateTenant)
	m.HandleFunc("POST /v1/owner/pair-codes", s.owner(s.handlePairCode))
	m.HandleFunc("GET /v1/owner/devices", s.owner(s.handleDevices))
	m.HandleFunc("DELETE /v1/owner/devices/{id}", s.owner(s.handleRevokeDevice))
	m.HandleFunc("POST /v1/owner/agents", s.owner(s.handleCreateAgent))
	m.HandleFunc("GET /v1/owner/agents", s.owner(s.handleAgents))
	m.HandleFunc("DELETE /v1/owner/agents/{id}", s.owner(s.handleRevokeAgent))
	m.HandleFunc("GET /v1/owner/audit", s.owner(s.handleAudit))
	m.HandleFunc("POST /v1/owner/kill", s.owner(s.handleKill))
	m.HandleFunc("POST /v1/pair", s.handlePair)
	m.HandleFunc("GET /v1/device/ws", s.handleDeviceWS)
	m.HandleFunc("POST /v1/device/unpair", s.handleDeviceUnpair)
	m.HandleFunc("POST /mcp", s.handleMCP)
	m.HandleFunc("GET /mcp", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	})
	m.HandleFunc("POST /v1/call", s.handleCall)
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	return m
}

// ---------- helpers ----------

func bearer(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return strings.TrimSpace(h[7:])
	}
	return ""
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func jerr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

func readBody(w http.ResponseWriter, r *http.Request, v any, max int64) bool {
	r.Body = http.MaxBytesReader(w, r.Body, max)
	if err := json.NewDecoder(r.Body).Decode(v); err != nil {
		jerr(w, http.StatusBadRequest, "bad json")
		return false
	}
	return true
}

func clientIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

func (s *Server) now() time.Time { return s.cfg.Now() }

// ---------- admin / owner ----------

func (s *Server) adminOK(tok string) bool {
	if tok == "" {
		return false
	}
	if s.cfg.AdminToken != "" {
		return hashEq(hashToken(tok), hashToken(s.cfg.AdminToken))
	}
	return hashEq(hashToken(tok), s.Store.AdminHash())
}

func (s *Server) handleCreateTenant(w http.ResponseWriter, r *http.Request) {
	if !s.adminOK(bearer(r)) {
		jerr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if !readBody(w, r, &req, 4096) {
		return
	}
	if req.Name == "" || len(req.Name) > 64 {
		jerr(w, http.StatusBadRequest, "name required (max 64)")
		return
	}
	t, tok := s.Store.CreateTenant(req.Name)
	s.Audit.Add(Entry{Time: s.now(), Tenant: t.ID, Event: "tenant_created"})
	writeJSON(w, 201, map[string]string{"tenant_id": t.ID, "owner_token": tok})
}

func (s *Server) owner(h func(http.ResponseWriter, *http.Request, Tenant)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := s.Store.TenantByOwnerToken(bearer(r))
		if !ok {
			jerr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r, t)
	}
}

func (s *Server) handlePairCode(w http.ResponseWriter, r *http.Request, t Tenant) {
	code, exp := s.Store.NewPairCode(t.ID, s.now(), s.cfg.PairTTL)
	s.Audit.Add(Entry{Time: s.now(), Tenant: t.ID, Event: "pair_code_issued"})
	writeJSON(w, 201, map[string]any{"code": code, "expires_at": exp, "expires_in": int(s.cfg.PairTTL.Seconds())})
}

type deviceView struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	Profile  string    `json:"profile,omitempty"`
	Online   bool      `json:"online"`
	LastSeen time.Time `json:"last_seen"`
	Expires  time.Time `json:"expires"`
}

func (s *Server) deviceViews(devs []Device) []deviceView {
	out := make([]deviceView, 0, len(devs))
	for _, d := range devs {
		out = append(out, deviceView{d.ID, d.Name, d.Profile, s.Hub.Online(d.ID), d.LastSeen, d.Expires})
	}
	return out
}

func (s *Server) handleDevices(w http.ResponseWriter, r *http.Request, t Tenant) {
	writeJSON(w, 200, map[string]any{"devices": s.deviceViews(s.Store.DevicesOf(t.ID))})
}

func (s *Server) handleRevokeDevice(w http.ResponseWriter, r *http.Request, t Tenant) {
	id := r.PathValue("id")
	if !s.Store.RevokeDevice(t.ID, id) {
		jerr(w, 404, "not found")
		return
	}
	s.Hub.Kick(id)
	s.Audit.Add(Entry{Time: s.now(), Tenant: t.ID, Event: "device_revoked", Device: id})
	writeJSON(w, 200, map[string]bool{"revoked": true})
}

func validDomainPattern(p string) bool {
	p = strings.TrimPrefix(p, "*.")
	if p == "" || len(p) > 253 || !strings.Contains(p, ".") {
		return false
	}
	for _, c := range p {
		if !(c == '.' || c == '-' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}

func (s *Server) handleCreateAgent(w http.ResponseWriter, r *http.Request, t Tenant) {
	var req struct {
		Name       string   `json:"name"`
		Scopes     []string `json:"scopes"`
		Domains    []string `json:"domains"`
		Browsers   []string `json:"browsers"`
		TTLSeconds int      `json:"ttl_seconds"`
	}
	if !readBody(w, r, &req, 16384) {
		return
	}
	if req.Name == "" || len(req.Name) > 64 {
		jerr(w, 400, "name required (max 64)")
		return
	}
	if len(req.Scopes) == 0 {
		jerr(w, 400, "scopes required")
		return
	}
	for _, sc := range req.Scopes {
		if !validScopes[sc] {
			jerr(w, 400, "unknown scope "+sc)
			return
		}
	}
	for _, d := range req.Domains {
		if !validDomainPattern(d) {
			jerr(w, 400, "bad domain pattern "+d)
			return
		}
	}
	for _, b := range req.Browsers {
		d, ok := s.Store.Device(b)
		if !ok || d.TenantID != t.ID {
			jerr(w, 400, "unknown browser "+b)
			return
		}
	}
	ttl := time.Duration(req.TTLSeconds) * time.Second
	if ttl <= 0 {
		ttl = 30 * 24 * time.Hour
	}
	if ttl > 365*24*time.Hour {
		ttl = 365 * 24 * time.Hour
	}
	a, tok := s.Store.AddAgent(Agent{TenantID: t.ID, Name: req.Name, Scopes: req.Scopes, Domains: req.Domains,
		Browsers: req.Browsers, Expires: s.now().Add(ttl)}, s.now())
	s.Audit.Add(Entry{Time: s.now(), Tenant: t.ID, Event: "agent_created", Agent: a.Name, Detail: a.ID})
	writeJSON(w, 201, map[string]any{"agent_id": a.ID, "token": tok, "expires_at": a.Expires})
}

func (s *Server) handleAgents(w http.ResponseWriter, r *http.Request, t Tenant) {
	type view struct {
		ID       string    `json:"id"`
		Name     string    `json:"name"`
		Scopes   []string  `json:"scopes"`
		Domains  []string  `json:"domains"`
		Browsers []string  `json:"browsers"`
		Expires  time.Time `json:"expires"`
	}
	out := []view{}
	for _, a := range s.Store.AgentsOf(t.ID) {
		out = append(out, view{a.ID, a.Name, a.Scopes, a.Domains, a.Browsers, a.Expires})
	}
	writeJSON(w, 200, map[string]any{"agents": out})
}

func (s *Server) handleRevokeAgent(w http.ResponseWriter, r *http.Request, t Tenant) {
	if !s.Store.RevokeAgent(t.ID, r.PathValue("id")) {
		jerr(w, 404, "not found")
		return
	}
	s.Audit.Add(Entry{Time: s.now(), Tenant: t.ID, Event: "agent_revoked", Detail: r.PathValue("id")})
	writeJSON(w, 200, map[string]bool{"revoked": true})
}

func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request, t Tenant) {
	n := 200
	fmt.Sscanf(r.URL.Query().Get("limit"), "%d", &n)
	writeJSON(w, 200, map[string]any{"entries": s.Audit.Tenant(t.ID, n)})
}

func (s *Server) handleKill(w http.ResponseWriter, r *http.Request, t Tenant) {
	for _, id := range s.Store.RevokeAll(t.ID) {
		s.Hub.Kick(id)
	}
	s.Audit.Add(Entry{Time: s.now(), Tenant: t.ID, Event: "kill_all"})
	writeJSON(w, 200, map[string]bool{"killed": true})
}

// ---------- pairing and device socket ----------

const (
	pairFailLimit  = 10
	pairFailWindow = 5 * time.Minute
)

func (s *Server) pairBlocked(ip string) bool {
	s.rmu.Lock()
	defer s.rmu.Unlock()
	cut := s.now().Add(-pairFailWindow)
	var keep []time.Time
	for _, t := range s.pairBad[ip] {
		if t.After(cut) {
			keep = append(keep, t)
		}
	}
	s.pairBad[ip] = keep
	return len(keep) >= pairFailLimit
}

func (s *Server) pairFailed(ip string) {
	s.rmu.Lock()
	s.pairBad[ip] = append(s.pairBad[ip], s.now())
	s.rmu.Unlock()
}

func (s *Server) handlePair(w http.ResponseWriter, r *http.Request) {
	ip := clientIP(r)
	if s.pairBlocked(ip) {
		jerr(w, http.StatusTooManyRequests, "too many wrong codes")
		return
	}
	var req struct {
		Code      string `json:"code"`
		Name      string `json:"name"`
		Profile   string `json:"profile"`
		PublicKey string `json:"public_key"`
		Signature string `json:"signature"` // proof of key possession over the pairing code
	}
	if !readBody(w, r, &req, 8192) {
		return
	}
	if len(req.Name) == 0 || len(req.Name) > 64 || len(req.Profile) > 64 || len(req.PublicKey) > 2048 {
		jerr(w, 400, "bad device fields")
		return
	}
	code := strings.ToUpper(strings.TrimSpace(req.Code))
	if req.PublicKey == "" && s.cfg.RequireDeviceKey {
		jerr(w, 400, "a device public key is required")
		return
	}
	if req.PublicKey != "" && !VerifyDeviceSig(req.PublicKey, pairProofMsg(code, req.Name), req.Signature) {
		jerr(w, 400, "device key proof is missing or invalid")
		return
	}
	tenant, ok := s.Store.ConsumeCode(code, s.now())
	if !ok {
		s.pairFailed(ip)
		s.Audit.Add(Entry{Time: s.now(), Event: "pair_failed", Detail: ip})
		jerr(w, http.StatusForbidden, "invalid or expired code")
		return
	}
	d, tok := s.Store.AddDevice(tenant, req.Name, req.Profile, req.PublicKey, s.now(), s.cfg.DeviceTTL)
	s.Audit.Add(Entry{Time: s.now(), Tenant: tenant, Event: "device_paired", Device: d.ID, Detail: d.Name})
	writeJSON(w, 201, map[string]any{"device_id": d.ID, "device_token": tok, "expires_at": d.Expires})
}

// handleDeviceWS: the extension connects outbound and authenticates with its
// first message (browsers cannot set headers on a WebSocket).
func (s *Server) handleDeviceWS(w http.ResponseWriter, r *http.Request) {
	c, err := ws.Accept(w, r, 8<<20)
	if err != nil {
		return
	}
	c.MaxMessage = 4096
	c.ReadTimeout = 5 * time.Second
	_, msg, err := c.ReadMessage()
	var a struct {
		Type  string `json:"type"`
		Token string `json:"token"`
	}
	if err != nil || json.Unmarshal(msg, &a) != nil || a.Type != "auth" {
		c.Close()
		return
	}
	dev, ok := s.Store.DeviceByToken(a.Token, s.now())
	if !ok {
		c.WriteText([]byte(`{"type":"error","code":"unauthorized"}`))
		c.Close()
		return
	}
	if dev.PublicKey != "" || s.cfg.RequireDeviceKey {
		if !s.proveDeviceKey(c, dev) {
			c.WriteText([]byte(`{"type":"error","code":"unauthorized"}`))
			c.Close()
			s.Audit.Add(Entry{Time: s.now(), Tenant: dev.TenantID, Event: "device_key_failed", Device: dev.ID})
			return
		}
	}
	c.MaxMessage = 8 << 20
	b, _ := json.Marshal(map[string]string{"type": "ready", "device_id": dev.ID})
	c.WriteText(b)
	s.Store.TouchDevice(dev.ID, s.now())
	s.Audit.Add(Entry{Time: s.now(), Tenant: dev.TenantID, Event: "device_online", Device: dev.ID})
	s.Hub.Serve(dev.ID, c, func() {
		if d, ok := s.Store.Device(dev.ID); !ok || d.Revoked { // revoked while connecting
			s.Hub.Kick(dev.ID)
		}
	}, func() {
		s.Store.TouchDevice(dev.ID, s.now())
		s.Audit.Add(Entry{Time: s.now(), Tenant: dev.TenantID, Event: "device_offline", Device: dev.ID})
	})
}

// proveDeviceKey sends a fresh challenge and checks the signature.
func (s *Server) proveDeviceKey(c *ws.Conn, dev Device) bool {
	if dev.PublicKey == "" {
		return false
	}
	nb := make([]byte, 16)
	rand.Read(nb)
	nonce := hex.EncodeToString(nb)
	b, _ := json.Marshal(map[string]string{"type": "challenge", "nonce": nonce})
	if c.WriteText(b) != nil {
		return false
	}
	_, msg, err := c.ReadMessage()
	var p struct {
		Type string `json:"type"`
		Sig  string `json:"sig"`
	}
	if err != nil || json.Unmarshal(msg, &p) != nil || p.Type != "proof" {
		return false
	}
	return VerifyDeviceSig(dev.PublicKey, authProofMsg(dev.ID, nonce), p.Sig)
}

// handleDeviceUnpair lets the extension revoke its own token ("Revoke" in the popup).
func (s *Server) handleDeviceUnpair(w http.ResponseWriter, r *http.Request) {
	dev, ok := s.Store.DeviceByToken(bearer(r), s.now())
	if !ok {
		jerr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	s.Store.RevokeDevice(dev.TenantID, dev.ID)
	s.Hub.Kick(dev.ID)
	s.Audit.Add(Entry{Time: s.now(), Tenant: dev.TenantID, Event: "device_unpaired", Device: dev.ID})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ---------- command execution ----------

func (s *Server) rateOK(agentID string) bool {
	s.rmu.Lock()
	defer s.rmu.Unlock()
	now := s.now()
	cut := now.Add(-time.Minute)
	var keep []time.Time
	for _, t := range s.rate[agentID] {
		if t.After(cut) {
			keep = append(keep, t)
		}
	}
	if len(keep) >= s.cfg.RatePerMin {
		s.rate[agentID] = keep
		return false
	}
	s.rate[agentID] = append(keep, now)
	return true
}

func (s *Server) resolveBrowser(a Agent, sel string) (Device, *CmdError) {
	var cands []Device
	for _, d := range s.Store.DevicesOf(a.TenantID) {
		if !s.now().Before(d.Expires) {
			continue
		}
		if len(a.Browsers) > 0 && !contains(a.Browsers, d.ID) {
			continue
		}
		cands = append(cands, d)
	}
	if sel != "" {
		var m []Device
		for _, d := range cands {
			if d.ID == sel || d.Name == sel {
				m = append(m, d)
			}
		}
		if len(m) == 1 {
			return m[0], nil
		}
		if len(m) > 1 {
			return Device{}, &CmdError{"ambiguous_browser", "several browsers have this name, use the id"}
		}
		return Device{}, &CmdError{"unknown_browser", "no such browser for this agent"}
	}
	var on []Device
	for _, d := range cands {
		if s.Hub.Online(d.ID) {
			on = append(on, d)
		}
	}
	switch {
	case len(on) == 1:
		return on[0], nil
	case len(on) > 1:
		return Device{}, &CmdError{"ambiguous_browser", "several browsers are online, pass \"browser\" (see list_browsers)"}
	case len(cands) == 0:
		return Device{}, &CmdError{"no_browser", "no browser is paired for this agent"}
	}
	return Device{}, errOffline
}

func contains(l []string, x string) bool {
	for _, v := range l {
		if v == x {
			return true
		}
	}
	return false
}

// ListBrowsers is the list_browsers tool: only what this agent may use.
func (s *Server) ListBrowsers(a Agent) []deviceView {
	var devs []Device
	for _, d := range s.Store.DevicesOf(a.TenantID) {
		if len(a.Browsers) == 0 || contains(a.Browsers, d.ID) {
			devs = append(devs, d)
		}
	}
	return s.deviceViews(devs)
}

func newCallID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// Execute checks policy, dispatches one command to a browser and audits it.
// The returned JSON is the extension result after relay-side filtering.
func (s *Server) Execute(ctx context.Context, a Agent, browser, cmd string, args map[string]any) (res json.RawMessage, cerr *CmdError) {
	ent := Entry{Tenant: a.TenantID, Event: "call", Agent: a.Name, Cmd: cmd}
	if u, ok := args["url"].(string); ok {
		ent.Domain = domainOf(u)
	}
	defer func() {
		ent.Time = s.now()
		ent.Result = "ok"
		if cerr != nil {
			ent.Result = cerr.Code
		}
		s.Audit.Add(ent)
	}()

	scope, known := cmdScope[cmd]
	if !known {
		return nil, &CmdError{"unknown_command", cmd}
	}
	if !a.HasScope(scope) {
		return nil, &CmdError{"scope_denied", "agent token has no \"" + scope + "\" scope"}
	}
	if !s.rateOK(a.ID) {
		return nil, &CmdError{"rate_limited", "too many commands per minute"}
	}
	if cmd == "tabs_open" || cmd == "navigate" {
		u, _ := args["url"].(string)
		if !DomainAllowed(a.Domains, u) {
			return nil, &CmdError{"domain_denied", "domain is not in this agent's allowlist"}
		}
	}
	dev, e := s.resolveBrowser(a, browser)
	if e != nil {
		return nil, e
	}
	ent.Device = dev.ID

	env := Envelope{V: 1, ID: newCallID(), Cmd: cmd, Agent: a.Name, AllowedDomains: nonNil(a.Domains), DeniedHosts: deniedHosts}
	env.Args, _ = json.Marshal(args)

	creq := ConfirmRequest{Tenant: a.TenantID, Agent: a.Name, Device: dev.ID, Cmd: cmd, Domain: ent.Domain}
	if alwaysConfirm[cmd] {
		creq.Description = "dangerous command " + cmd
		dec := s.askOwner(ctx, &ent, creq)
		if !dec.Approved {
			return nil, &CmdError{"needs_owner_confirmation", "owner confirmation required and not given"}
		}
		env.Confirmed = true
	}

	resp, err := s.Hub.Submit(ctx, dev.ID, env)
	if err != nil {
		ce, _ := err.(*CmdError)
		if ce == nil {
			ce = &CmdError{"canceled", err.Error()}
		}
		return nil, ce
	}
	if resp.Error != nil && resp.Error.Code == "needs_confirmation" {
		creq.Description = resp.Error.Message
		dec := s.askOwner(ctx, &ent, creq)
		if !dec.Approved {
			return nil, &CmdError{"needs_owner_confirmation", "owner confirmation required and not given"}
		}
		env.ID, env.Confirmed = newCallID(), true
		if resp, err = s.Hub.Submit(ctx, dev.ID, env); err != nil {
			ce, _ := err.(*CmdError)
			if ce == nil {
				ce = &CmdError{"canceled", err.Error()}
			}
			return nil, ce
		}
	}
	if resp.Error != nil {
		return nil, resp.Error
	}
	return s.filterResult(a, cmd, resp.Result, &ent)
}

func nonNil(l []string) []string {
	if l == nil {
		return []string{}
	}
	return l
}

func (s *Server) askOwner(ctx context.Context, ent *Entry, r ConfirmRequest) Decision {
	dec := s.cfg.Confirmer.Confirm(ctx, r)
	res := "declined"
	if dec.Approved {
		res = "approved"
		ent.ConfirmedBy = dec.By
	}
	s.Audit.Add(Entry{Time: s.now(), Tenant: r.Tenant, Event: "confirmation", Agent: r.Agent, Device: r.Device,
		Cmd: r.Cmd, Domain: r.Domain, Result: res, ConfirmedBy: dec.By})
	return dec
}

// filterResult is the relay-side second line of defence behind the
// extension's own check: nothing from a non-allowed page reaches the agent.
func (s *Server) filterResult(a Agent, cmd string, raw json.RawMessage, ent *Entry) (json.RawMessage, *CmdError) {
	if len(raw) == 0 {
		return raw, nil
	}
	if cmd == "tabs_list" {
		var v struct {
			Tabs []map[string]any `json:"tabs"`
		}
		if json.Unmarshal(raw, &v) != nil {
			return nil, &CmdError{"bad_response", "tabs_list result is not valid"}
		}
		kept := []map[string]any{}
		for _, t := range v.Tabs {
			if u, _ := t["url"].(string); DomainAllowed(a.Domains, u) {
				kept = append(kept, t)
			}
		}
		out, _ := json.Marshal(map[string]any{"tabs": kept})
		return out, nil
	}
	var v map[string]json.RawMessage
	if json.Unmarshal(raw, &v) == nil {
		if cb, ok := v["confirmed_by"]; ok { // the extension asked the human itself
			var who string
			if json.Unmarshal(cb, &who) == nil && len(who) <= 32 {
				ent.ConfirmedBy = who
			}
		}
		if ub, ok := v["url"]; ok {
			var u string
			json.Unmarshal(ub, &u)
			ent.Domain = domainOf(u)
			if !DomainAllowed(a.Domains, u) {
				return nil, &CmdError{"domain_denied", "the page is outside this agent's allowlist"}
			}
		}
	}
	return raw, nil
}

// handleCall is the plain-JSON fallback for clients without an MCP stack.
func (s *Server) handleCall(w http.ResponseWriter, r *http.Request) {
	a, ok := s.Store.AgentByToken(bearer(r), s.now())
	if !ok {
		jerr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	var req struct {
		Browser string         `json:"browser"`
		Command string         `json:"command"`
		Args    map[string]any `json:"args"`
	}
	if !readBody(w, r, &req, 1<<20) {
		return
	}
	if req.Command == "list_browsers" {
		writeJSON(w, 200, map[string]any{"browsers": s.ListBrowsers(a)})
		return
	}
	res, cerr := s.Execute(r.Context(), a, req.Browser, req.Command, req.Args)
	if cerr != nil {
		writeJSON(w, 200, map[string]any{"ok": false, "error": cerr})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "result": res})
}

var _ = log.Printf
