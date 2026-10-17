# capy-browser-relay

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Go Version](https://img.shields.io/badge/Go-1.22+-00ADD8.svg)](https://go.dev)
[![Manifest](https://img.shields.io/badge/Chrome_Extension-MV3-orange.svg)](extension/manifest.json)

Local and remote bridge between the CapyAgent Browser extension and AI agents on the same or remote computer.
The extension talks to `127.0.0.1` (or outbound TLS to your own server). The agent calls the same bridge over standard MCP
(Streamable HTTP, `Authorization: Bearer`). Claude Code, Codex, Antigravity, Hermes, OpenClaw
and CapyAgent use this interface.

Features:
- **Zero-disturbance for human user:** Background tabs remain inactive (`active: false`), audio is automatically muted (`muted: true`), modal alerts/confirms are neutered, and tabs are neatly folded into color-coded collapsed tab groups.
- **Multi-agent concurrency:** Per-lane execution in Relay allows multiple agents (or multiple sessions) to drive their respective tabs simultaneously without blocking each other.
- **Universal page engine:** Clean, structured Markdown and text extraction for all websites, deep shadow DOM traversal, React 16+ controlled form input support, and full pointer/mouse event simulation.
- **Strict security & privacy:** Token hashing, device ECDSA P-256 key challenges, domain allow/deny lists, password input protection (`needs_human`), and device-only confirmation for dangerous actions.

Go 1.22+, standard library only.

```
same computer:  extension -> 127.0.0.1 relay <- MCP agent (Claude Code, Codex, Antigravity...)
other computer: extension --outbound--> their relay <- their agent
```

## Run (local only)

```
go build -o relay ./cmd/relay
RELAY_ADMIN_TOKEN=change-me ./relay -listen 127.0.0.1:8787 -data ./data
```

The relay speaks plain HTTP and refuses to bind a non-loopback address unless
`-allow-non-loopback` is given. Put a reverse proxy with TLS in front before
exposing it (WSS and HTTPS only; not done in slice 1). Without
`RELAY_ADMIN_TOKEN` a token is generated and printed once at first start.

## Owner flow (curl)

```
A=http://127.0.0.1:8787
# 1. admin creates a tenant (account); the owner token is shown once
curl -XPOST $A/admin/tenants -H 'Authorization: Bearer change-me' -d '{"name":"default"}'
# 2. owner gets a one-time pairing code (8 chars, 5 min, single use)
curl -XPOST $A/v1/owner/pair-codes -H "Authorization: Bearer $OWNER"
# 3. the extension (or ./cmd/fakeext) pairs and connects
go run ./cmd/fakeext -relay $A -code ABCD2345 -name laptop
# 4. owner issues a per-agent token: scopes, domain allowlist, expiry (token shown once)
curl -XPOST $A/v1/owner/agents -H "Authorization: Bearer $OWNER" \
  -d '{"name":"claude-code","scopes":["read","act"],"domains":["example.com"],"ttl_seconds":86400}'
# revoke: DELETE /v1/owner/devices/{id}, DELETE /v1/owner/agents/{id}, POST /v1/owner/kill
# audit:  GET /v1/owner/audit?limit=100   (metadata only)
```

Other endpoints: `GET /v1/owner/devices`, `GET /v1/owner/agents`, `POST /mcp`, `POST /v1/call`
(plain JSON fallback: `{"browser","command","args"}`), `GET /v1/device/ws` (extension socket), `GET /healthz`.

## MCP tools

`browser_list`, `browser_tabs_list`, `browser_tabs_open`, `browser_navigate`, `browser_read_page`
(`mode: text|snapshot`), `browser_click`, `browser_type`, `browser_form_input`, `browser_screenshot`.
Every tool takes an optional `browser` (id or name); with several browsers online it is required.
`tools/list` shows only tools the agent token has the scope for. Tools carry `readOnlyHint` annotations;
Codex needs them to call read tools in non-interactive mode.

Scopes: `read` (tabs_list, read_page, screenshot), `act` (tabs_open, navigate, click, type, form_input),
`upload` (file_upload, not exposed over MCP yet), `record` (reserved).

## Security model in slice 1

- Tokens (owner, device, agent) are 256-bit random, stored as SHA-256 hashes, shown once. Device and agent tokens are separate kinds and are not interchangeable.
- Pairing code: 5 minutes, single use, 10 wrong attempts per IP per 5 minutes, then HTTP 429.
- Revoking a device closes its socket at once (about 1 ms locally, limit 2 s); revoking an agent token or the kill switch takes effect on the next request.
- Domain allowlist per agent. Empty list allows nothing. Non-http(s) URLs, the Chrome Web Store, and a built-in deny list (banks, mail, gosuslugi) are never allowed. The relay checks navigation targets, filters `tabs_list`, and drops any result whose page URL is outside the list; the extension is expected to check as well (the fake one does).
- Dangerous actions: the extension answers `needs_confirmation`, or the command is in the relay's always-confirm set; the relay calls the `Confirmer` hook. The default stub logs and declines, so the action does not run. Passwords: the extension answers `needs_human`.
- Commands per browser are serialised in a queue (32 deep, 30 s lifetime), 120 commands per minute per agent. An offline browser answers `browser_offline` at once.
- Audit log (`data/audit.log`, JSON lines): time, tenant, agent, device, command, domain, result, who confirmed. No page content, typed text or tokens.
- Tenants are isolated: every lookup is keyed by tenant.
- Device key binding (slice 2): the extension makes an ECDSA P-256 key (private half non-extractable, in IndexedDB), sends the public key with a signature over the pairing code, and answers a fresh challenge on every WebSocket connect. A stolen device token without the key is refused. `-require-device-key` (default on) rejects browsers without a key.
- Not done: TLS inside the process (reverse proxy), token auto-renewal, end-to-end encryption, relay-side owner confirmation channel (the window is in the extension).

## Wire protocol (relay <-> extension)

Extension connects to `/v1/device/ws` and sends `{"type":"auth","token":"<device token>"}` as the first
message (a browser WebSocket cannot set headers). If the device has a key the relay sends `{"type":"challenge","nonce"}`
and the extension answers `{"type":"proof","sig"}` (ECDSA P-256/SHA-256, r||s, base64, over `capy-auth|<device id>|<nonce>`; pairing signs `capy-pair|<CODE>|<name>`). Relay answers `{"type":"ready","device_id":...}`; the extension sends `{"type":"ping"}` every 20 s and gets `{"type":"pong"}`. Then the relay sends
`{"v":1,"id","cmd","args","agent","allowed_domains","denied_hosts","confirmed"}`; the extension replies
`{"id","ok":true,"result":{...}}` or `{"id","ok":false,"error":{"code","message"}}`.
Results should carry the page `url`. Error codes the relay understands: `needs_confirmation`; anything else is passed to the agent.

## Client configs

Create the agent token first (step 4 above). Replace URL and token.
Verified = ran against this relay with the fake extension on this server (2026-10-13).

### Claude Code (verified: tools listed and called, read + form_input + click)

```
claude mcp add --transport http browser http://127.0.0.1:8787/mcp --header "Authorization: Bearer $AGENT_TOKEN"
```
Without installing: `.mcp.json`
```json
{"mcpServers":{"browser":{"type":"http","url":"http://127.0.0.1:8787/mcp","headers":{"Authorization":"Bearer <agent token>"}}}}
```
Checked via `claude -p --mcp-config file --strict-mcp-config`; the `claude mcp add` command line itself is from the CLI docs, not run (it would write to the real config).

### Codex (verified: `codex mcp add`, discovery and read tools called in `codex exec`)

```
export RELAY_AGENT_TOKEN=<agent token>
codex mcp add browser --url http://127.0.0.1:8787/mcp --bearer-token-env-var RELAY_AGENT_TOKEN
```
which writes to `~/.codex/config.toml`:
```toml
[mcp_servers.browser]
url = "http://127.0.0.1:8787/mcp"
bearer_token_env_var = "RELAY_AGENT_TOKEN"
```
Note: read tools run in `codex exec`. Acting tools (`form_input`, `click`...) are blocked there with "requires approval,
approval policy is never"; they ran with `--dangerously-bypass-approvals-and-sandbox`. In interactive Codex they prompt the user.

### Hermes (verified: `hermes mcp test` connects and discovers 9 tools; tool calls not run)

`~/.hermes/config.yaml`:
```yaml
mcp_servers:
  browser:
    url: "http://127.0.0.1:8787/mcp"
    headers:
      Authorization: "Bearer <agent token>"
```
Check: `hermes mcp test browser`.

### OpenClaw (config written with `openclaw mcp set`; format from its docs, connection not tested)

```
openclaw mcp set browser '{"url":"http://127.0.0.1:8787/mcp","transport":"streamable-http","headers":{"Authorization":"Bearer <agent token>"}}'
```
OpenClaw's own docs say `mcp set/list` only manage saved config and do not prove reachability. Needs a live run on a machine with a configured OpenClaw model.

### CapyAgent (verified like Hermes: `capyagent mcp test browser` connects, 9 tools)

Same YAML as Hermes in the CapyAgent home (`CAPYAGENT_HOME`, usually `~/.capyagent/config.yaml`).

## Tests

```
go vet ./... && go test -race ./...
```
Light (about 2 s). Covers: pairing (single use, expiry at 5 min, brute-force limit), hashed storage, scopes,
token kinds, agent expiry, domain allowlist (relay and extension side, hostile extension), revoke device within 2 s,
revoke agent, kill switch, tenant isolation, browser selection and offline, queue serialisation/full/expiry,
rate limit, tool path end to end, confirmation (declined by stub, approved by hook), audit contents, MCP hardening
(Origin check, notifications), persistence across restart, WebSocket framing.

`internal/fakeext` is the test extension; `cmd/fakeext` runs it against a live relay for manual MCP-client tests.
Browser end-to-end tests belong to slice 2 and run on the old laptop.

## Extension (slice 2)

`extension/`: MV3, service worker, no build step. Name "CapyAgent Browser", version 0.4.10. A fresh extension: the published
CapyAgent extension is a side panel for the local core on 127.0.0.1 with no relay client, so only its icons were reused.

- Pairing: popup, relay address + one-time code + device name. https required except for localhost. Device token in `chrome.storage.local`, key in IndexedDB.
- Link: WSS, first-message auth, key proof, reconnect with backoff 1-30 s (timers while the worker lives, `chrome.alarms` every 30 s to wake it), app-level ping/pong so a dead link is noticed within about 55 s.
- Commands: `tabs_list`, `tabs_open`, `navigate`, `read_page` (text, snapshot with refs), `screenshot`, `click`, `type`, `form_input`, `set_file`. Uses `storage`, `tabs`, `tabGroups`, `scripting`, `alarms`, `sidePanel`. No `debugger` and no `downloads`. `set_file` fetches a blob from `127.0.0.1:18791` and builds the file in the page. Click does not attach a debugger.
- Local policy: built-in deny floor (banks, mail, sign-in, Chrome Web Store, non-http), the relay's `allowed_domains` and `denied_hosts`, plus the owner's own narrowing lists. Pages are re-checked after every action; nothing from a page outside the list is returned.
- Dangerous actions (payment, delete, form POST/send, download, file chooser): the extension opens its own window and waits for the human (25 s, then Deny). `confirmed` from the relay is ignored. "Trust this agent here for 15 min" skips the window for submit/download only, never for payment, delete, upload. The audit records `owner_on_device`.
- Passwords: password, one-time-code, card fields and any field in a form that holds a password input return `needs_human`; nothing is typed.
- Popup: status, pause/resume, revoke (unpairs and asks the relay to revoke the token), site lists, trust grants, last 15 calls (metadata only).

Load unpacked: `chrome://extensions`, Developer mode, Load unpacked, pick `extension/`. Not published; no store listing.

Tests: `cd extension && node --test test/*.test.mjs` (policy, danger rules, command logic with a fake browser, and the real client against the real relay built from this repo). Live Chrome: `e2e/live-chrome.mjs` (throwaway profile, loopback relay, loads the extension over CDP `Extensions.loadUnpacked`, which Chrome 154 allows with `--enable-unsafe-extension-debugging`; `--load-extension` no longer works in branded Chrome). Run on 2026-10-13 on the old laptop, Chrome 154: 26 of 27 checks passed; the 27th (Claude Code reading the page) needs a logged-in Claude Code on that machine.

## License

This project is licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) file for details.
