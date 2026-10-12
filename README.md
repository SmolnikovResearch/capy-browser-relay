# capy-browser-relay

Relay between a browser extension (on a laptop) and AI agents (on servers).
The extension opens an outbound WSS connection; agents reach the same relay
over standard MCP (Streamable HTTP, `Authorization: Bearer <agent token>`).
Any MCP client works: Claude Code, Codex, Hermes, OpenClaw, CapyAgent.

Status: slice 1 (relay + MCP + fake extension + tests). The real MV3 extension is slice 2.
Go 1.22+, standard library only. Plan: `01 Projects/CapyAgent/Единое расширение для браузера - план.md` in the vault.

```
extension (laptop) --outbound WSS--> relay <--MCP/HTTP, Bearer-- agents (servers)
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
curl -XPOST $A/admin/tenants -H 'Authorization: Bearer change-me' -d '{"name":"kirill"}'
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
- Not in slice 1: TLS inside the process, device key binding (public key is stored, not verified), token auto-renewal, content-free end-to-end encryption, real owner confirmation channel.

## Wire protocol (relay <-> extension)

Extension connects to `/v1/device/ws` and sends `{"type":"auth","token":"<device token>"}` as the first
message (a browser WebSocket cannot set headers). Relay answers `{"type":"ready","device_id":...}`, then sends
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
