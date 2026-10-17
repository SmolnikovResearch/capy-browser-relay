package relay

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const blobMax = 512 << 20

type blobItem struct {
	name  string
	path  string
	token string
	exp   time.Time
}

type blobStore struct {
	mu    sync.Mutex
	dir   string
	items map[string]blobItem
}

func newBlobStore(dir string) *blobStore {
	d := filepath.Join(dir, "blobs")
	_ = os.MkdirAll(d, 0o700)
	return &blobStore{dir: d, items: map[string]blobItem{}}
}

func randHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func cleanName(raw string) string {
	base := filepath.Base(strings.TrimSpace(raw))
	if base == "." || base == "/" || base == "" {
		return "video.mp4"
	}
	var b strings.Builder
	for _, r := range base {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if out == "" || strings.HasPrefix(out, ".") {
		return "video.mp4"
	}
	if len(out) > 80 {
		out = out[:80]
	}
	return out
}

func (b *blobStore) put(name string, r io.Reader, now time.Time) (id, token string, size int64, err error) {
	id = randHex(16)
	token = randHex(24)
	path := filepath.Join(b.dir, id)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return "", "", 0, err
	}
	n, copyErr := io.Copy(f, r)
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil || n == 0 {
		_ = os.Remove(path)
		if copyErr != nil {
			return "", "", 0, copyErr
		}
		if n == 0 {
			return "", "", 0, io.ErrUnexpectedEOF
		}
		return "", "", 0, closeErr
	}
	b.mu.Lock()
	b.sweepLocked(now)
	b.items[id] = blobItem{name: name, path: path, token: token, exp: now.Add(2 * time.Hour)}
	b.mu.Unlock()
	return id, token, n, nil
}

func (b *blobStore) sweepLocked(now time.Time) {
	for id, it := range b.items {
		if now.After(it.exp) {
			_ = os.Remove(it.path)
			delete(b.items, id)
		}
	}
}

func (b *blobStore) open(id, token string, now time.Time) (blobItem, *os.File, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	it, ok := b.items[id]
	if !ok || now.After(it.exp) || token == "" || token != it.token {
		return blobItem{}, nil, false
	}
	f, err := os.Open(it.path)
	if err != nil {
		return blobItem{}, nil, false
	}
	return it, f, true
}

func (s *Server) handleBlobPut(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.Store.AgentByToken(bearer(r), s.now()); !ok {
		jerr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, blobMax)
	id, token, n, err := s.blobs.put(cleanName(r.URL.Query().Get("name")), r.Body, s.now())
	if err != nil {
		jerr(w, http.StatusBadRequest, "could not store the file")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"id": id, "bytes": n, "token": token,
		"url": "http://127.0.0.1:18791/v1/blob/" + id,
	})
}

func (s *Server) handleBlobGet(w http.ResponseWriter, r *http.Request) {
	token := bearer(r)
	if token == "" {
		token = r.URL.Query().Get("t")
	}
	it, f, ok := s.blobs.open(r.PathValue("id"), token, s.now())
	if !ok {
		jerr(w, http.StatusNotFound, "not found")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Capy-Name", it.name)
	_, _ = io.Copy(w, f)
}
