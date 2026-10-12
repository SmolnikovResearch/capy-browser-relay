package relay_test

import (
	"strings"
	"testing"
	"time"

	"capybrowserrelay/internal/fakeext"
	"capybrowserrelay/internal/relay"
	"capybrowserrelay/internal/ws"
)

func keyed(e *env, owner, name string) *fakeext.Client {
	x := fakeext.New(e.ts.URL).UseKey()
	if c, _ := x.Pair(e.code(owner), name); c != 201 {
		e.t.Fatalf("pair with key: %d", c)
	}
	return x
}

func TestDeviceKeyHappyPath(t *testing.T) {
	e := newEnv(t, func(c *relay.Config) { c.RequireDeviceKey = true })
	x := keyed(e, e.owner, "laptop")
	if err := x.Connect(); err != nil {
		t.Fatal(err)
	}
	defer x.Disconnect()
	waitOnline(t, e.srv, x.DeviceID)
}

func TestStolenTokenWithoutKeyRefused(t *testing.T) {
	e := newEnv(t, nil)
	x := keyed(e, e.owner, "laptop")
	thief := fakeext.New(e.ts.URL)
	thief.DeviceID, thief.Token = x.DeviceID, x.Token
	if err := thief.Connect(); err == nil {
		thief.Disconnect()
		t.Fatal("token without the device key was accepted")
	}
	other := fakeext.New(e.ts.URL).UseKey() // some other key
	other.DeviceID, other.Token = x.DeviceID, x.Token
	if err := other.Connect(); err == nil {
		other.Disconnect()
		t.Fatal("token with a foreign key was accepted")
	}
	if e.srv.Hub.Online(x.DeviceID) {
		t.Fatal("device marked online after failed proof")
	}
	_, out := e.do("GET", "/v1/owner/audit", e.owner, nil)
	if !strings.Contains(toJSON(out), "device_key_failed") {
		t.Fatal("failed proof not audited")
	}
}

func TestPairingNeedsProofOfKey(t *testing.T) {
	e := newEnv(t, nil)
	good := fakeext.New(e.ts.URL).UseKey()
	// claim a public key whose private half the caller does not hold
	victim := fakeext.New(e.ts.URL).UseKey()
	code := e.code(e.owner)
	body := map[string]string{"code": code, "name": "x", "public_key": victim.PublicKeyB64(), "signature": good.Sign("capy-pair|" + code + "|x")}
	if c, _ := e.do("POST", "/v1/pair", "", body); c != 400 {
		t.Fatalf("pairing with a key it cannot prove: %d", c)
	}
	// the code survives a rejected proof and still works with a valid one
	if c, _ := good.Pair(code, "x"); c != 201 {
		t.Fatalf("code burnt by a bad proof: %d", c)
	}
}

func TestRequireDeviceKey(t *testing.T) {
	e := newEnv(t, func(c *relay.Config) { c.RequireDeviceKey = true })
	x := fakeext.New(e.ts.URL)
	if c, _ := x.Pair(e.code(e.owner), "nokey"); c != 400 {
		t.Fatalf("keyless pairing accepted: %d", c)
	}
}

func TestLocalConfirmationIsAudited(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	x.LocalConfirm = true
	tab := x.AddTab("https://example.com/", "t", "x")
	ag := e.agent(e.owner, all, []string{"example.com"}, nil)
	e.tool(ag, "browser_click", map[string]any{"tab_id": tab, "selector": "#delete"})
	_, out := e.do("GET", "/v1/owner/audit", e.owner, nil)
	if !strings.Contains(toJSON(out), `"confirmed_by":"owner_on_device"`) {
		t.Fatalf("on-device confirmation not in audit: %s", toJSON(out))
	}
}

func TestDeviceSelfUnpair(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	if c, _ := e.do("POST", "/v1/device/unpair", "nonsense", nil); c != 401 {
		t.Fatalf("unpair with a bad token: %d", c)
	}
	if c, _ := e.do("POST", "/v1/device/unpair", x.Token, nil); c != 200 {
		t.Fatalf("unpair: %d", c)
	}
	select {
	case <-x.Closed():
	case <-time.After(2 * time.Second):
		t.Fatal("socket still open after self-unpair")
	}
	again := fakeext.New(e.ts.URL)
	again.DeviceID, again.Token = x.DeviceID, x.Token
	if again.Connect() == nil {
		t.Fatal("revoked token reconnected")
	}
}

func TestAppLevelPingGetsPong(t *testing.T) {
	e := newEnv(t, nil)
	x := e.device(e.owner, "laptop")
	conn, err := ws.Dial(strings.Replace(e.ts.URL, "http", "ws", 1)+"/v1/device/ws", nil, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	conn.WriteText([]byte(`{"type":"auth","token":"` + x.Token + `"}`))
	conn.ReadTimeout = 3 * time.Second
	if _, m, err := conn.ReadMessage(); err != nil || !strings.Contains(string(m), "ready") {
		t.Fatalf("ready: %s %v", m, err)
	}
	conn.WriteText([]byte(`{"type":"ping"}`))
	if _, m, err := conn.ReadMessage(); err != nil || !strings.Contains(string(m), "pong") {
		t.Fatalf("pong: %s %v", m, err)
	}
}
