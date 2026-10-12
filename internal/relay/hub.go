package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"capybrowserrelay/internal/ws"
)

// Envelope is sent relay -> extension.
type Envelope struct {
	V              int             `json:"v"`
	ID             string          `json:"id"`
	Cmd            string          `json:"cmd"`
	Args           json.RawMessage `json:"args,omitempty"`
	Agent          string          `json:"agent"`
	AllowedDomains []string        `json:"allowed_domains"`
	DeniedHosts    []string        `json:"denied_hosts"`
	Confirmed      bool            `json:"confirmed,omitempty"`
}

type CmdError struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

func (e *CmdError) Error() string { return e.Code + ": " + e.Message }

// Response is sent extension -> relay.
type Response struct {
	ID     string          `json:"id"`
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *CmdError       `json:"error,omitempty"`
}

var (
	errOffline   = &CmdError{"browser_offline", "browser is not connected"}
	errQueueFull = &CmdError{"queue_full", "too many pending commands for this browser"}
	errExpired   = &CmdError{"command_expired", "command waited in the queue too long"}
	errTimeout   = &CmdError{"timeout", "browser did not answer in time"}
)

type job struct {
	env  Envelope
	enq  time.Time
	resp chan Response
}

type deviceConn struct {
	id      string
	conn    *ws.Conn
	queue   chan *job
	done    chan struct{}
	once    sync.Once
	mu      sync.Mutex
	pending map[string]chan Response
}

type Hub struct {
	mu         sync.Mutex
	conns      map[string]*deviceConn
	QueueTTL   time.Duration // commands older than this are dropped (plan: 30 s)
	CmdTimeout time.Duration
	QueueSize  int
}

func NewHub() *Hub {
	return &Hub{conns: map[string]*deviceConn{}, QueueTTL: 30 * time.Second, CmdTimeout: 30 * time.Second, QueueSize: 32}
}

func (h *Hub) Online(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.conns[id]
	return ok
}

// Serve registers the connection and blocks until it closes.
func (h *Hub) Serve(id string, c *ws.Conn, registered, onClose func()) {
	d := &deviceConn{id: id, conn: c, queue: make(chan *job, h.QueueSize), done: make(chan struct{}),
		pending: map[string]chan Response{}}
	c.ReadTimeout = 60 * time.Second
	h.mu.Lock()
	if old := h.conns[id]; old != nil {
		old.shutdown()
	}
	h.conns[id] = d
	h.mu.Unlock()
	if registered != nil {
		registered()
	}

	go h.worker(d)
	go func() { // keepalive
		t := time.NewTicker(20 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				if d.conn.Ping() != nil {
					d.shutdown()
					return
				}
			case <-d.done:
				return
			}
		}
	}()
	for { // reader
		_, msg, err := c.ReadMessage()
		if err != nil {
			break
		}
		var r Response
		if json.Unmarshal(msg, &r) != nil || r.ID == "" {
			// app-level keepalive from the extension (a browser cannot see
			// WebSocket ping frames): answer so it can detect a dead link
			if bytes.Contains(msg, []byte(`"ping"`)) {
				d.conn.WriteText([]byte(`{"type":"pong"}`))
			}
			continue
		}
		d.mu.Lock()
		ch := d.pending[r.ID]
		delete(d.pending, r.ID)
		d.mu.Unlock()
		if ch != nil {
			ch <- r
		}
	}
	d.shutdown()
	h.mu.Lock()
	if h.conns[id] == d {
		delete(h.conns, id)
	}
	h.mu.Unlock()
	if onClose != nil {
		onClose()
	}
}

func (d *deviceConn) shutdown() {
	d.once.Do(func() {
		close(d.done)
		d.conn.CloseNow()
	})
}

// Kick drops the device connection at once (revocation).
func (h *Hub) Kick(id string) {
	h.mu.Lock()
	d := h.conns[id]
	h.mu.Unlock()
	if d != nil {
		d.shutdown()
	}
}

// worker runs queued commands one at a time per browser.
func (h *Hub) worker(d *deviceConn) {
	for {
		select {
		case <-d.done:
			for {
				select {
				case j := <-d.queue:
					j.resp <- Response{ID: j.env.ID, Error: errOffline}
				default:
					return
				}
			}
		case j := <-d.queue:
			if time.Since(j.enq) > h.QueueTTL {
				j.resp <- Response{ID: j.env.ID, Error: errExpired}
				continue
			}
			ch := make(chan Response, 1)
			d.mu.Lock()
			d.pending[j.env.ID] = ch
			d.mu.Unlock()
			b, _ := json.Marshal(j.env)
			if err := d.conn.WriteText(b); err != nil {
				d.shutdown()
				j.resp <- Response{ID: j.env.ID, Error: errOffline}
				continue
			}
			select {
			case r := <-ch:
				j.resp <- r
			case <-time.After(h.CmdTimeout):
				d.mu.Lock()
				delete(d.pending, j.env.ID)
				d.mu.Unlock()
				j.resp <- Response{ID: j.env.ID, Error: errTimeout}
			case <-d.done:
				j.resp <- Response{ID: j.env.ID, Error: errOffline}
			}
		}
	}
}

// Submit queues a command for a browser and waits for the answer.
func (h *Hub) Submit(ctx context.Context, deviceID string, env Envelope) (Response, error) {
	h.mu.Lock()
	d := h.conns[deviceID]
	h.mu.Unlock()
	if d == nil {
		return Response{}, errOffline
	}
	j := &job{env: env, enq: time.Now(), resp: make(chan Response, 1)}
	select {
	case d.queue <- j:
	default:
		return Response{}, errQueueFull
	}
	select {
	case r := <-j.resp:
		if r.Error != nil && (r.Error == errOffline || r.Error == errExpired || r.Error == errTimeout) {
			return r, r.Error
		}
		return r, nil
	case <-d.done:
		return Response{}, errOffline
	case <-ctx.Done():
		return Response{}, errors.New("canceled")
	}
}
