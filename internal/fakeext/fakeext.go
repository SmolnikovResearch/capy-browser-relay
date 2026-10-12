// Package fakeext is a stand-in for the browser extension, used in tests until
// the real MV3 extension exists. It speaks the same wire protocol: pairs with a
// code, connects outbound over WebSocket, answers relay commands against an
// in-memory set of tabs.
package fakeext

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"capybrowserrelay/internal/relay"
	"capybrowserrelay/internal/ws"
)

type Tab struct {
	ID     int
	URL    string
	Title  string
	Text   string
	Fields map[string]string
}

type Client struct {
	Base     string // http://host:port
	DeviceID string
	Token    string

	// Misbehave skips the extension-side domain check, to prove the relay
	// filters on its own.
	Misbehave bool
	// Delay is added to every command (queue tests).
	Delay time.Duration
	// Key, when set, is the device key: sent at pairing and used to answer the
	// connect challenge (same scheme as the real extension).
	Key *ecdsa.PrivateKey
	// LocalConfirm makes dangerous clicks behave like the real extension:
	// the human is asked on the device, the relay is not involved.
	LocalConfirm bool

	mu       sync.Mutex
	tabs     map[int]*Tab
	next     int
	Log      []string // "cmd" in arrival order
	inflight int
	MaxPar   int
	Confirms []bool // Confirmed flag of each command seen

	conn   *ws.Conn
	closed chan struct{}
}

func New(base string) *Client {
	return &Client{Base: base, tabs: map[int]*Tab{}, next: 1}
}

// UseKey generates a device key.
func (c *Client) UseKey() *Client {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	c.Key = k
	return c
}

func (c *Client) PublicKeyB64() string {
	der, _ := x509.MarshalPKIXPublicKey(&c.Key.PublicKey)
	return base64.StdEncoding.EncodeToString(der)
}

// Sign returns an r||s (P1363) signature, base64, like WebCrypto.
func (c *Client) Sign(msg string) string {
	h := sha256.Sum256([]byte(msg))
	r, s, _ := ecdsa.Sign(rand.Reader, c.Key, h[:])
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return base64.StdEncoding.EncodeToString(sig)
}

func (c *Client) AddTab(u, title, text string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := c.next
	c.next++
	c.tabs[id] = &Tab{ID: id, URL: u, Title: title, Text: text, Fields: map[string]string{}}
	return id
}

func (c *Client) Field(tab int, sel string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.tabs[tab].Fields[sel]
}

func (c *Client) Commands() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.Log...)
}

// Pair exchanges a one-time code for a device token.
func (c *Client) Pair(code, name string) (int, error) {
	body := map[string]string{"code": code, "name": name, "profile": "Default"}
	if c.Key != nil {
		body["public_key"] = c.PublicKeyB64()
		body["signature"] = c.Sign("capy-pair|" + strings.ToUpper(code) + "|" + name)
	}
	b, _ := json.Marshal(body)
	resp, err := http.Post(c.Base+"/v1/pair", "application/json", bytes.NewReader(b))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	var out struct {
		DeviceID string `json:"device_id"`
		Token    string `json:"device_token"`
	}
	json.NewDecoder(resp.Body).Decode(&out)
	if resp.StatusCode == 201 {
		c.DeviceID, c.Token = out.DeviceID, out.Token
	}
	return resp.StatusCode, nil
}

// Connect opens the outbound socket and authenticates. Run starts in a goroutine.
func (c *Client) Connect() error {
	u := strings.Replace(c.Base, "http", "ws", 1) + "/v1/device/ws"
	conn, err := ws.Dial(u, nil, 8<<20)
	if err != nil {
		return err
	}
	b, _ := json.Marshal(map[string]string{"type": "auth", "token": c.Token})
	if err := conn.WriteText(b); err != nil {
		return err
	}
	conn.ReadTimeout = 10 * time.Second
	_, msg, err := conn.ReadMessage()
	if err != nil {
		return err
	}
	var r struct {
		Type  string `json:"type"`
		Nonce string `json:"nonce"`
	}
	json.Unmarshal(msg, &r)
	if r.Type == "challenge" && c.Key != nil {
		pb, _ := json.Marshal(map[string]string{"type": "proof", "sig": c.Sign("capy-auth|" + c.DeviceID + "|" + r.Nonce)})
		if err := conn.WriteText(pb); err != nil {
			return err
		}
		_, msg, err = conn.ReadMessage()
		if err != nil {
			return err
		}
		r.Type = ""
		json.Unmarshal(msg, &r)
	}
	if r.Type != "ready" {
		conn.CloseNow()
		return fmt.Errorf("auth refused: %s", msg)
	}
	conn.ReadTimeout = 0
	c.conn, c.closed = conn, make(chan struct{})
	go c.loop()
	return nil
}

// Closed is closed when the relay dropped the socket.
func (c *Client) Closed() <-chan struct{} { return c.closed }

func (c *Client) Disconnect() {
	if c.conn != nil {
		c.conn.CloseNow()
	}
}

func (c *Client) loop() {
	defer close(c.closed)
	for {
		_, msg, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		var env relay.Envelope
		if json.Unmarshal(msg, &env) != nil || env.ID == "" {
			continue
		}
		go func() { // concurrent on purpose: lets tests detect a relay that fails to serialise
			resp := c.handle(env)
			b, _ := json.Marshal(resp)
			c.conn.WriteText(b)
		}()
	}
}

func fail(id, code, msg string) relay.Response {
	return relay.Response{ID: id, Error: &relay.CmdError{Code: code, Message: msg}}
}

func ok(id string, v any) relay.Response {
	b, _ := json.Marshal(v)
	return relay.Response{ID: id, OK: true, Result: b}
}

func (c *Client) handle(env relay.Envelope) relay.Response {
	c.mu.Lock()
	c.Log = append(c.Log, env.Cmd)
	c.Confirms = append(c.Confirms, env.Confirmed)
	c.inflight++
	if c.inflight > c.MaxPar {
		c.MaxPar = c.inflight
	}
	c.mu.Unlock()
	defer func() { c.mu.Lock(); c.inflight--; c.mu.Unlock() }()
	if c.Delay > 0 {
		time.Sleep(c.Delay)
	}

	var a struct {
		TabID    int    `json:"tab_id"`
		URL      string `json:"url"`
		Mode     string `json:"mode"`
		Selector string `json:"selector"`
		Ref      string `json:"ref"`
		Text     string `json:"text"`
		Value    string `json:"value"`
	}
	json.Unmarshal(env.Args, &a)
	allowed := func(u string) bool {
		return c.Misbehave || relay.DomainAllowed(env.AllowedDomains, u)
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	switch env.Cmd {
	case "tabs_list":
		list := []map[string]any{}
		for i := 1; i < c.next; i++ {
			if t := c.tabs[i]; t != nil {
				list = append(list, map[string]any{"id": t.ID, "url": t.URL, "title": t.Title})
			}
		}
		return ok(env.ID, map[string]any{"tabs": list}) // unfiltered on purpose: relay filters
	case "tabs_open":
		if !allowed(a.URL) {
			return fail(env.ID, "domain_denied", "extension: domain not allowed")
		}
		id := c.next
		c.next++
		c.tabs[id] = &Tab{ID: id, URL: a.URL, Title: hostTitle(a.URL), Fields: map[string]string{}}
		return ok(env.ID, map[string]any{"tab_id": id, "url": a.URL})
	}
	t := c.tabs[a.TabID]
	if t == nil {
		return fail(env.ID, "no_such_tab", "tab not found")
	}
	if env.Cmd == "navigate" {
		if !allowed(a.URL) {
			return fail(env.ID, "domain_denied", "extension: domain not allowed")
		}
		t.URL, t.Title = a.URL, hostTitle(a.URL)
		return ok(env.ID, map[string]any{"tab_id": t.ID, "url": t.URL, "title": t.Title})
	}
	if !allowed(t.URL) {
		return fail(env.ID, "domain_denied", "extension: domain not allowed")
	}
	sel := a.Selector
	if sel == "" {
		sel = a.Ref
	}
	switch env.Cmd {
	case "read_page":
		if a.Mode == "snapshot" {
			return ok(env.ID, map[string]any{"url": t.URL, "title": t.Title,
				"snapshot": []map[string]string{{"ref": "e1", "role": "textbox", "name": "Search"}, {"ref": "e2", "role": "button", "name": "Go"}}})
		}
		return ok(env.ID, map[string]any{"url": t.URL, "title": t.Title, "text": t.Text})
	case "screenshot":
		return ok(env.ID, map[string]any{"url": t.URL, "mime_type": "image/png",
			"data": base64.StdEncoding.EncodeToString([]byte("\x89PNG-fake"))})
	case "click":
		if c.LocalConfirm && strings.Contains(sel, "delete") {
			return ok(env.ID, map[string]any{"url": t.URL, "clicked": sel, "confirmed_by": "owner_on_device"})
		}
		if strings.Contains(sel, "delete") && !env.Confirmed {
			return fail(env.ID, "needs_confirmation", "click on a delete button")
		}
		return ok(env.ID, map[string]any{"url": t.URL, "clicked": sel})
	case "type", "form_input":
		if strings.Contains(sel, "password") {
			return fail(env.ID, "needs_human", "password fields are filled by the owner")
		}
		v := a.Text
		if env.Cmd == "form_input" {
			v = a.Value
		}
		t.Fields[sel] = v
		return ok(env.ID, map[string]any{"url": t.URL, "set": sel})
	}
	return fail(env.ID, "unknown_command", env.Cmd)
}

func hostTitle(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return u.Host
}
