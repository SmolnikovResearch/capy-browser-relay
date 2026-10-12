package ws_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"capybrowserrelay/internal/ws"
)

func echoServer(t *testing.T, max int64) *httptest.Server {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := ws.Accept(w, r, max)
		if err != nil {
			return
		}
		defer c.CloseNow()
		for {
			_, m, err := c.ReadMessage()
			if err != nil {
				return
			}
			c.WriteText(m)
		}
	}))
	t.Cleanup(ts.Close)
	return ts
}

func TestEchoSizes(t *testing.T) {
	ts := echoServer(t, 1<<20)
	c, err := ws.Dial("ws"+strings.TrimPrefix(ts.URL, "http"), nil, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	for _, n := range []int{0, 5, 125, 126, 65535, 65536, 300000} {
		msg := strings.Repeat("x", n)
		if err := c.WriteText([]byte(msg)); err != nil {
			t.Fatal(err)
		}
		_, got, err := c.ReadMessage()
		if err != nil || string(got) != msg {
			t.Fatalf("size %d: err=%v len=%d", n, err, len(got))
		}
	}
	if err := c.Ping(); err != nil {
		t.Fatal(err)
	}
}

func TestOversizeRejected(t *testing.T) {
	ts := echoServer(t, 1000)
	c, err := ws.Dial("ws"+strings.TrimPrefix(ts.URL, "http"), nil, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	c.WriteText([]byte(strings.Repeat("y", 5000)))
	if _, _, err := c.ReadMessage(); err == nil {
		t.Fatal("oversize message was echoed")
	}
}

func TestPlainRequestRefused(t *testing.T) {
	ts := echoServer(t, 1000)
	resp, _ := http.Get(ts.URL)
	if resp.StatusCode != 400 {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
