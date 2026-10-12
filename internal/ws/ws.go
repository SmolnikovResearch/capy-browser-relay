// Package ws is a minimal RFC 6455 implementation (text/binary messages,
// ping/pong, close) used by the relay server and by the fake extension client.
package ws

import (
	"bufio"
	"crypto/rand"
	"crypto/sha1"
	"crypto/tls"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

const (
	OpCont   = 0x0
	OpText   = 0x1
	OpBinary = 0x2
	OpClose  = 0x8
	OpPing   = 0x9
	OpPong   = 0xA
)

var ErrTooBig = errors.New("ws: message too big")

type Conn struct {
	c           net.Conn
	br          *bufio.Reader
	wmu         sync.Mutex
	client      bool
	MaxMessage  int64
	ReadTimeout time.Duration // refreshed before every frame; 0 = none
}

func acceptKey(k string) string {
	h := sha1.Sum([]byte(k + guid))
	return base64.StdEncoding.EncodeToString(h[:])
}

// Accept upgrades an HTTP request. The caller must authenticate first.
func Accept(w http.ResponseWriter, r *http.Request, maxMsg int64) (*Conn, error) {
	if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") ||
		r.Header.Get("Sec-WebSocket-Version") != "13" || r.Header.Get("Sec-WebSocket-Key") == "" {
		http.Error(w, "websocket upgrade required", http.StatusBadRequest)
		return nil, errors.New("ws: not an upgrade request")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "hijack unsupported", http.StatusInternalServerError)
		return nil, errors.New("ws: hijack unsupported")
	}
	c, rw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	resp := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
		acceptKey(r.Header.Get("Sec-WebSocket-Key")) + "\r\n\r\n"
	if _, err := rw.WriteString(resp); err != nil {
		c.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		c.Close()
		return nil, err
	}
	return &Conn{c: c, br: rw.Reader, MaxMessage: maxMsg}, nil
}

// Dial opens a client connection (ws:// or wss://).
func Dial(rawURL string, header http.Header, maxMsg int64) (*Conn, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, err
	}
	host := u.Host
	var c net.Conn
	switch u.Scheme {
	case "ws":
		if u.Port() == "" {
			host += ":80"
		}
		c, err = net.DialTimeout("tcp", host, 10*time.Second)
	case "wss":
		if u.Port() == "" {
			host += ":443"
		}
		d := &net.Dialer{Timeout: 10 * time.Second}
		c, err = tls.DialWithDialer(d, "tcp", host, &tls.Config{ServerName: u.Hostname()})
	default:
		return nil, errors.New("ws: unsupported scheme")
	}
	if err != nil {
		return nil, err
	}
	kb := make([]byte, 16)
	rand.Read(kb)
	key := base64.StdEncoding.EncodeToString(kb)
	path := u.RequestURI()
	var sb strings.Builder
	fmt.Fprintf(&sb, "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n", path, u.Host, key)
	for k, vs := range header {
		for _, v := range vs {
			fmt.Fprintf(&sb, "%s: %s\r\n", k, v)
		}
	}
	sb.WriteString("\r\n")
	c.SetDeadline(time.Now().Add(10 * time.Second))
	if _, err := c.Write([]byte(sb.String())); err != nil {
		c.Close()
		return nil, err
	}
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, &http.Request{Method: "GET"})
	if err != nil {
		c.Close()
		return nil, err
	}
	if resp.StatusCode != 101 || resp.Header.Get("Sec-WebSocket-Accept") != acceptKey(key) {
		resp.Body.Close()
		c.Close()
		return nil, fmt.Errorf("ws: handshake failed: status %d", resp.StatusCode)
	}
	c.SetDeadline(time.Time{})
	return &Conn{c: c, br: br, client: true, MaxMessage: maxMsg}, nil
}

func (c *Conn) readFrame() (fin bool, op byte, payload []byte, err error) {
	if c.ReadTimeout > 0 {
		c.c.SetReadDeadline(time.Now().Add(c.ReadTimeout))
	} else {
		c.c.SetReadDeadline(time.Time{})
	}
	var h [2]byte
	if _, err = io.ReadFull(c.br, h[:]); err != nil {
		return
	}
	fin = h[0]&0x80 != 0
	if h[0]&0x70 != 0 {
		err = errors.New("ws: reserved bits set")
		return
	}
	op = h[0] & 0x0f
	masked := h[1]&0x80 != 0
	n := int64(h[1] & 0x7f)
	if !c.client && !masked {
		err = errors.New("ws: unmasked client frame")
		return
	}
	switch n {
	case 126:
		var b [2]byte
		if _, err = io.ReadFull(c.br, b[:]); err != nil {
			return
		}
		n = int64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err = io.ReadFull(c.br, b[:]); err != nil {
			return
		}
		u := binary.BigEndian.Uint64(b[:])
		if u > 1<<62 {
			err = ErrTooBig
			return
		}
		n = int64(u)
	}
	if op >= 0x8 && (n > 125 || !fin) {
		err = errors.New("ws: bad control frame")
		return
	}
	if c.MaxMessage > 0 && n > c.MaxMessage {
		err = ErrTooBig
		return
	}
	var mask [4]byte
	if masked {
		if _, err = io.ReadFull(c.br, mask[:]); err != nil {
			return
		}
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(c.br, payload); err != nil {
		return
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return
}

// ReadMessage returns the next text or binary message. Control frames are
// handled internally. A close frame yields io.EOF.
func (c *Conn) ReadMessage() (byte, []byte, error) {
	var msgOp byte
	var buf []byte
	for {
		fin, op, p, err := c.readFrame()
		if err != nil {
			return 0, nil, err
		}
		switch op {
		case OpPing:
			c.write(OpPong, p)
			continue
		case OpPong:
			continue
		case OpClose:
			c.write(OpClose, p)
			return 0, nil, io.EOF
		case OpText, OpBinary:
			if buf != nil {
				return 0, nil, errors.New("ws: unexpected data frame")
			}
			msgOp = op
		case OpCont:
			if msgOp == 0 {
				return 0, nil, errors.New("ws: unexpected continuation")
			}
		default:
			return 0, nil, errors.New("ws: unknown opcode")
		}
		buf = append(buf, p...)
		if c.MaxMessage > 0 && int64(len(buf)) > c.MaxMessage {
			return 0, nil, ErrTooBig
		}
		if fin {
			return msgOp, buf, nil
		}
	}
}

func (c *Conn) write(op byte, p []byte) error {
	var hdr []byte
	hdr = append(hdr, 0x80|op)
	mb := byte(0)
	if c.client {
		mb = 0x80
	}
	switch n := len(p); {
	case n < 126:
		hdr = append(hdr, mb|byte(n))
	case n < 1<<16:
		hdr = append(hdr, mb|126, byte(n>>8), byte(n))
	default:
		hdr = append(hdr, mb|127)
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(n))
		hdr = append(hdr, b[:]...)
	}
	body := p
	if c.client {
		var mask [4]byte
		rand.Read(mask[:])
		hdr = append(hdr, mask[:]...)
		body = make([]byte, len(p))
		for i := range p {
			body[i] = p[i] ^ mask[i%4]
		}
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	c.c.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if _, err := c.c.Write(hdr); err != nil {
		return err
	}
	_, err := c.c.Write(body)
	return err
}

func (c *Conn) WriteText(p []byte) error { return c.write(OpText, p) }
func (c *Conn) Ping() error              { return c.write(OpPing, nil) }

// CloseNow drops the TCP connection immediately (used for revocation).
func (c *Conn) CloseNow() error { return c.c.Close() }

// Close sends a close frame and drops the connection.
func (c *Conn) Close() error {
	c.write(OpClose, []byte{0x03, 0xe8})
	return c.c.Close()
}
