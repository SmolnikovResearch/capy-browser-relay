package relay

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Entry holds metadata only. Page content, screenshots and typed text never
// reach the audit log.
type Entry struct {
	Time        time.Time `json:"time"`
	Tenant      string    `json:"tenant,omitempty"`
	Event       string    `json:"event"`
	Agent       string    `json:"agent,omitempty"`
	Device      string    `json:"device,omitempty"`
	Cmd         string    `json:"cmd,omitempty"`
	Domain      string    `json:"domain,omitempty"`
	Result      string    `json:"result,omitempty"` // ok | error code
	ConfirmedBy string    `json:"confirmed_by,omitempty"`
	Detail      string    `json:"detail,omitempty"`
}

type Audit struct {
	mu   sync.Mutex
	f    *os.File
	ring []Entry
}

const auditRing = 2000

func OpenAudit(dir string) (*Audit, error) {
	a := &Audit{}
	if dir == "" {
		return a, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "audit.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	a.f = f
	return a, nil
}

func (a *Audit) Add(e Entry) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.ring = append(a.ring, e)
	if len(a.ring) > auditRing {
		a.ring = a.ring[len(a.ring)-auditRing:]
	}
	if a.f != nil {
		b, _ := json.Marshal(e)
		a.f.Write(append(b, '\n'))
	}
}

// Tenant returns the newest entries of one tenant, newest last.
func (a *Audit) Tenant(tenant string, limit int) []Entry {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []Entry
	for _, e := range a.ring {
		if e.Tenant == tenant {
			out = append(out, e)
		}
	}
	if limit > 0 && len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out
}
