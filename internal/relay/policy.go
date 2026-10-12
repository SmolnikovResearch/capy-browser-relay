package relay

import (
	"net/url"
	"strings"
)

const (
	ScopeRead   = "read"
	ScopeAct    = "act"
	ScopeUpload = "upload"
	ScopeRecord = "record"
)

var validScopes = map[string]bool{ScopeRead: true, ScopeAct: true, ScopeUpload: true, ScopeRecord: true}

// cmdScope maps a relay command to the scope it needs.
var cmdScope = map[string]string{
	"tabs_list":   ScopeRead,
	"read_page":   ScopeRead,
	"screenshot":  ScopeRead,
	"tabs_open":   ScopeAct,
	"navigate":    ScopeAct,
	"click":       ScopeAct,
	"type":        ScopeAct,
	"form_input":  ScopeAct,
	"file_upload": ScopeUpload, // not exposed over MCP in slice 1, kept for the contract
}

// alwaysConfirm commands go through the confirmation hook before dispatch.
var alwaysConfirm = map[string]bool{"file_upload": true, "run_js": true, "download": true}

// Hosts that are never reachable, whatever the allowlist says. The extension
// repeats this check on its side (slice 2).
var deniedHosts = []string{
	"chromewebstore.google.com", "accounts.google.com", "mail.google.com", "mail.yandex.ru",
	"sberbank.ru", "online.sberbank.ru", "tbank.ru", "tinkoff.ru", "vtb.ru", "alfabank.ru",
	"paypal.com", "gosuslugi.ru",
}

func hostOf(raw string) (host, path string, ok bool) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return "", "", false
	}
	return strings.ToLower(u.Hostname()), u.Path, true
}

func hostMatches(host, pattern string) bool {
	pattern = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(pattern), "*."))
	if pattern == "" {
		return false
	}
	return host == pattern || strings.HasSuffix(host, "."+pattern)
}

// DomainAllowed reports whether an agent may touch rawURL. An empty allowlist
// allows nothing. Non-http(s) URLs (chrome://, file:, about:) are refused.
func DomainAllowed(allow []string, rawURL string) bool {
	host, path, ok := hostOf(rawURL)
	if !ok {
		return false
	}
	for _, d := range deniedHosts {
		if hostMatches(host, d) {
			return false
		}
	}
	if host == "chrome.google.com" && strings.HasPrefix(path, "/webstore") {
		return false
	}
	for _, p := range allow {
		if hostMatches(host, p) {
			return true
		}
	}
	return false
}

func domainOf(raw string) string {
	h, _, ok := hostOf(raw)
	if !ok {
		return ""
	}
	return h
}
