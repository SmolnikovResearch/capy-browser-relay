package relay

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Everything secret is stored as a SHA-256 hash of a 256-bit random token.
// Tokens are shown once at creation.

func newToken(prefix string) string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(b)
}

func newID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func hashToken(t string) string {
	h := sha256.Sum256([]byte(t))
	return hex.EncodeToString(h[:])
}

func hashEq(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no 0/O/1/I

func newPairCode() string {
	b := make([]byte, 8)
	rand.Read(b)
	out := make([]byte, 8)
	for i := range b {
		out[i] = codeAlphabet[int(b[i])%len(codeAlphabet)] // 32 symbols, no modulo bias
	}
	return string(out)
}

type Tenant struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	OwnerHash string `json:"owner_hash"`
}

type Device struct {
	ID        string    `json:"id"`
	TenantID  string    `json:"tenant_id"`
	Name      string    `json:"name"`
	Profile   string    `json:"profile,omitempty"`
	PublicKey string    `json:"public_key,omitempty"` // base64 SPKI P-256; proven at pairing and on every connect
	TokenHash string    `json:"token_hash"`
	Created   time.Time `json:"created"`
	Expires   time.Time `json:"expires"`
	LastSeen  time.Time `json:"last_seen"`
	Revoked   bool      `json:"revoked"`
}

type Agent struct {
	ID        string    `json:"id"`
	TenantID  string    `json:"tenant_id"`
	Name      string    `json:"name"`
	TokenHash string    `json:"token_hash"`
	Scopes    []string  `json:"scopes"`
	Domains   []string  `json:"domains"`  // allowlist, empty = nothing allowed
	Browsers  []string  `json:"browsers"` // device ids, empty = all of the tenant
	Created   time.Time `json:"created"`
	Expires   time.Time `json:"expires"`
	Revoked   bool      `json:"revoked"`
}

func (a *Agent) HasScope(s string) bool {
	for _, x := range a.Scopes {
		if x == s {
			return true
		}
	}
	return false
}

type pairCode struct {
	tenant  string
	expires time.Time
	used    bool
}

type stateFile struct {
	AdminHash string             `json:"admin_hash,omitempty"`
	Tenants   map[string]*Tenant `json:"tenants"`
	Devices   map[string]*Device `json:"devices"`
	Agents    map[string]*Agent  `json:"agents"`
}

type Store struct {
	mu    sync.Mutex
	path  string // "" = memory only
	st    stateFile
	codes map[string]*pairCode // by hash
}

func OpenStore(dir string) (*Store, error) {
	s := &Store{codes: map[string]*pairCode{}}
	s.st = stateFile{Tenants: map[string]*Tenant{}, Devices: map[string]*Device{}, Agents: map[string]*Agent{}}
	if dir == "" {
		return s, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	s.path = filepath.Join(dir, "state.json")
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &s.st); err != nil {
		return nil, err
	}
	if s.st.Tenants == nil {
		s.st.Tenants = map[string]*Tenant{}
	}
	if s.st.Devices == nil {
		s.st.Devices = map[string]*Device{}
	}
	if s.st.Agents == nil {
		s.st.Agents = map[string]*Agent{}
	}
	return s, nil
}

// saveLocked writes state atomically. Caller holds s.mu.
func (s *Store) saveLocked() {
	if s.path == "" {
		return
	}
	b, _ := json.MarshalIndent(&s.st, "", " ")
	tmp := s.path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		os.Rename(tmp, s.path)
	}
}

func (s *Store) AdminHash() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st.AdminHash
}

func (s *Store) SetAdminHash(h string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.st.AdminHash = h
	s.saveLocked()
}

func (s *Store) CreateTenant(name string) (Tenant, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tok := newToken("cbr_owner_")
	t := &Tenant{ID: newID(), Name: name, OwnerHash: hashToken(tok)}
	s.st.Tenants[t.ID] = t
	s.saveLocked()
	return *t, tok
}

func (s *Store) TenantByOwnerToken(tok string) (Tenant, bool) {
	h := hashToken(tok)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.st.Tenants {
		if hashEq(t.OwnerHash, h) {
			return *t, true
		}
	}
	return Tenant{}, false
}

func (s *Store) NewPairCode(tenant string, now time.Time, ttl time.Duration) (string, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for h, c := range s.codes { // drop stale
		if now.After(c.expires) || c.used {
			delete(s.codes, h)
		}
	}
	code := newPairCode()
	exp := now.Add(ttl)
	s.codes[hashToken(code)] = &pairCode{tenant: tenant, expires: exp}
	return code, exp
}

// ConsumeCode is single use: the first successful call burns the code.
func (s *Store) ConsumeCode(code string, now time.Time) (string, bool) {
	h := hashToken(code)
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.codes[h]
	if !ok || c.used || now.After(c.expires) {
		return "", false
	}
	c.used = true
	return c.tenant, true
}

func (s *Store) AddDevice(tenant, name, profile, pub string, now time.Time, ttl time.Duration) (Device, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tok := newToken("cbr_dev_")
	d := &Device{ID: newID(), TenantID: tenant, Name: name, Profile: profile, PublicKey: pub,
		TokenHash: hashToken(tok), Created: now, Expires: now.Add(ttl)}
	s.st.Devices[d.ID] = d
	s.saveLocked()
	return *d, tok
}

func (s *Store) DeviceByToken(tok string, now time.Time) (Device, bool) {
	h := hashToken(tok)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, d := range s.st.Devices {
		if hashEq(d.TokenHash, h) && !d.Revoked && now.Before(d.Expires) {
			return *d, true
		}
	}
	return Device{}, false
}

func (s *Store) Device(id string) (Device, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.st.Devices[id]
	if !ok {
		return Device{}, false
	}
	return *d, true
}

func (s *Store) TouchDevice(id string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d, ok := s.st.Devices[id]; ok {
		d.LastSeen = now
	}
}

func (s *Store) DevicesOf(tenant string) []Device {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Device
	for _, d := range s.st.Devices {
		if d.TenantID == tenant && !d.Revoked {
			out = append(out, *d)
		}
	}
	return out
}

func (s *Store) RevokeDevice(tenant, id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.st.Devices[id]
	if !ok || d.TenantID != tenant {
		return false
	}
	d.Revoked = true
	s.saveLocked()
	return true
}

func (s *Store) AddAgent(a Agent, now time.Time) (Agent, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tok := newToken("cbr_agent_")
	a.ID, a.TokenHash, a.Created = newID(), hashToken(tok), now
	s.st.Agents[a.ID] = &a
	s.saveLocked()
	return a, tok
}

func (s *Store) AgentByToken(tok string, now time.Time) (Agent, bool) {
	h := hashToken(tok)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, a := range s.st.Agents {
		if hashEq(a.TokenHash, h) && !a.Revoked && now.Before(a.Expires) {
			return *a, true
		}
	}
	return Agent{}, false
}

func (s *Store) AgentsOf(tenant string) []Agent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Agent
	for _, a := range s.st.Agents {
		if a.TenantID == tenant && !a.Revoked {
			out = append(out, *a)
		}
	}
	return out
}

func (s *Store) RevokeAgent(tenant, id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	a, ok := s.st.Agents[id]
	if !ok || a.TenantID != tenant {
		return false
	}
	a.Revoked = true
	s.saveLocked()
	return true
}

// RevokeAll is the kill switch; returns the revoked device ids.
func (s *Store) RevokeAll(tenant string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var ids []string
	for _, d := range s.st.Devices {
		if d.TenantID == tenant && !d.Revoked {
			d.Revoked = true
			ids = append(ids, d.ID)
		}
	}
	for _, a := range s.st.Agents {
		if a.TenantID == tenant {
			a.Revoked = true
		}
	}
	s.saveLocked()
	return ids
}
