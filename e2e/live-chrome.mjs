// Live end-to-end test: real Chrome, the unpacked extension, a relay on
// loopback, a local test site. Windows/Linux/macOS, node 22+.
//
//   node live-chrome.mjs --chrome <chrome path> --relay <relay binary> --ext <extension dir> --work <empty dir> [--claude <claude path>]
//
// The extension manifest is copied with host_permissions set to <all_urls>
// (the shipped manifest asks for it at runtime, which needs a click on a
// browser prompt that automation cannot answer). Everything lives under
// --work: throwaway profile, relay state. Nothing is installed or published.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

const arg = (n) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const chromePath = arg('chrome'), relayBin = arg('relay'), extSrc = arg('ext'), work = arg('work'), claudePath = arg('claude');
if (!chromePath || !relayBin || !extSrc || !work) { console.error('missing args'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 15000, step = 100) { const t = Date.now(); while (Date.now() - t < ms) { const v = await f(); if (v) return v; await sleep(step); } return false; }
const results = [];
function check(name, cond, extra = '') { results.push({ name, ok: !!cond, extra: String(extra).slice(0, 200) }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + String(extra).slice(0, 300))); }

const procs = [];
const cleanup = () => { for (const p of procs) { try { p.kill(); } catch {} } };
process.on('exit', cleanup);

// ---------- test site ----------
const PAGE = `<!doctype html><html><head><title>E2E page</title></head><body>
<h1>Hello from the e2e site</h1>
<form method="get" action="/search"><input id="q" name="q" type="search" placeholder="Search"><button id="go" type="submit">Search</button></form>
<form method="post" action="/login"><input id="user" name="user" type="text" placeholder="Username"><input id="pw" name="pw" type="password" placeholder="Password"><button id="signin" type="submit">Sign in</button></form>
<button id="del" type="button" onclick="document.title='DELETED'">Delete account</button>
<button id="plain" type="button" onclick="document.title='CLICKED'">Next step</button>
<a id="out" href="http://localhost:__PORT__/other">other host</a>
</body></html>`;
let sitePort;
const site = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE.replace('__PORT__', sitePort)); });
await new Promise((r) => site.listen(0, '127.0.0.1', r));
sitePort = site.address().port;
const SITE = 'http://127.0.0.1:' + sitePort;

// ---------- relay ----------
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const relayPort = 18700 + Math.floor(Math.random() * 200);
const relay = spawn(relayBin, ['-listen', '127.0.0.1:' + relayPort, '-data', join(work, 'data')], { env: { ...process.env, RELAY_ADMIN_TOKEN: 'adm' }, stdio: 'ignore' });
procs.push(relay);
const R = 'http://127.0.0.1:' + relayPort;
await until(async () => { try { return (await fetch(R + '/healthz')).ok; } catch { return false; } }, 8000) || (console.error('relay did not start'), process.exit(3));
const api = async (method, path, token, body) => {
  const r = await fetch(R + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const owner = (await api('POST', '/admin/tenants', 'adm', { name: 'e2e' })).json.owner_token;
const agentTok = (await api('POST', '/v1/owner/agents', owner, { name: 'e2e-agent', scopes: ['read', 'act'], domains: ['127.0.0.1'], ttl_seconds: 3600 })).json.token;
const mcp = async (name, args) => {
  const r = await fetch(R + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + agentTok, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  return j.result || { isError: true, content: [{ text: JSON.stringify(j) }] };
};
const txt = (r) => (r.content || []).map((c) => c.text || '').join('');

// ---------- extension copy with required host permission ----------
const extDir = join(work, 'ext');
cpSync(extSrc, extDir, { recursive: true, filter: (s) => !/[\\/](test|node_modules)([\\/]|$)/.test(s) });
const mf = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
delete mf.optional_host_permissions;
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(mf, null, 2));

// ---------- Chrome ----------
const cdpPort = 19300 + Math.floor(Math.random() * 200);
const chrome = spawn(chromePath, [
  '--user-data-dir=' + join(work, 'profile'), '--remote-debugging-port=' + cdpPort, '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--headless=new', '--window-size=1000,700', 'about:blank',
], { stdio: 'ignore' });
procs.push(chrome);
const ver = await until(async () => { try { return await (await fetch('http://127.0.0.1:' + cdpPort + '/json/version')).json(); } catch { return false; } }, 20000);
if (!ver) { console.error('chrome did not start'); process.exit(3); }
console.log('Chrome ' + ver.Browser);

class CDP {
  constructor(url) { this.id = 0; this.cb = new Map(); this.ev = []; this.ws = new WebSocket(url); this.ready = new Promise((r) => (this.ws.onopen = r));
    this.ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && this.cb.has(j.id)) { this.cb.get(j.id)(j); this.cb.delete(j.id); } else this.ev.push(j); }; }
  async send(method, params = {}, sessionId) {
    await this.ready; const id = ++this.id;
    return new Promise((res, rej) => { this.cb.set(id, (j) => (j.error ? rej(new Error(method + ': ' + j.error.message)) : res(j.result))); this.ws.send(JSON.stringify({ id, method, params, sessionId })); });
  }
}
const cdp = new CDP(ver.webSocketDebuggerUrl);
let extId;
try {
  extId = (await cdp.send('Extensions.loadUnpacked', { path: extDir })).id;
} catch (e) { console.error('load failed: ' + e.message); check('extension loads in Chrome via CDP', false, e.message); finish(); }
check('extension loads in Chrome via CDP', !!extId, extId);

async function openPage(url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return { targetId, sessionId, ev: (expr) => cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId).then((r) => r.result.value) };
}
const popup = await openPage('chrome-extension://' + extId + '/popup.html');
await sleep(500);
const popupText = (id) => popup.ev(`document.getElementById('${id}').textContent`);

check('popup shows Not paired', await until(async () => (await popupText('status')) === 'Not paired', 5000), await popupText('status'));

// ---------- pair through the popup ----------
const code = (await api('POST', '/v1/owner/pair-codes', owner)).json.code;
await popup.ev(`(() => { document.getElementById('relay').value=${JSON.stringify(R)}; document.getElementById('code').value=${JSON.stringify(code)}; document.getElementById('devname').value='e2e chrome'; document.getElementById('pairBtn').click(); })()`);
check('pairing through the popup connects', await until(async () => (await popupText('status')) === 'Connected', 15000), await popupText('status') + ' / ' + await popupText('msg'));
const devs = JSON.stringify((await api('GET', '/v1/owner/devices', owner)).json);
check('relay lists the browser online with its name', devs.includes('e2e chrome') && devs.includes('"online":true'), devs);

// ---------- agent commands over MCP ----------
let r = await mcp('browser_list', {});
check('browser_list sees the device', txt(r).includes('e2e chrome'), txt(r));
r = await mcp('browser_tabs_open', { url: SITE + '/' });
check('tabs_open on the allowed site', !r.isError, txt(r));
const tabId = (JSON.parse(txt(r))).tab_id;
r = await mcp('browser_read_page', { tab_id: tabId });
check('read_page returns the page text', txt(r).includes('Hello from the e2e site'), txt(r));
r = await mcp('browser_read_page', { tab_id: tabId, mode: 'snapshot' });
const snap = JSON.parse(txt(r)).snapshot || [];
check('snapshot lists interactive elements with refs', snap.some((e) => e.role === 'button' && /Delete/.test(e.name)) && snap.some((e) => e.type === 'password' && e.secret), txt(r));
const qRef = (snap.find((e) => e.type === 'search') || {}).ref;
r = await mcp('browser_form_input', { tab_id: tabId, ref: qRef, value: 'cats' });
check('form_input by ref fills the search field', !r.isError, txt(r));
r = await mcp('browser_type', { tab_id: tabId, selector: '#q', text: ' and dogs' });
check('type appends keystrokes', !r.isError, txt(r));
const tp = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.targetId);
const pageSess = (await cdp.send('Target.getTargets')).targetInfos.find((t) => t.url.startsWith(SITE) && t.type === 'page');
const page = await (async () => { const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: pageSess.targetId, flatten: true }); return { ev: (e) => cdp.send('Runtime.evaluate', { expression: e, returnByValue: true }, sessionId).then((x) => x.result.value) }; })();
check('the typed value is really in the page', (await page.ev(`document.getElementById('q').value`)) === 'cats and dogs', await page.ev(`document.getElementById('q').value`));
r = await mcp('browser_type', { tab_id: tabId, selector: '#pw', text: 'hunter2' });
check('password field refused (needs_human)', r.isError && txt(r).includes('needs_human'), txt(r));
r = await mcp('browser_form_input', { tab_id: tabId, selector: '#user', value: 'admin' });
check('username in a login form refused (needs_human)', r.isError && txt(r).includes('needs_human'), txt(r));
check('nothing typed into the secret fields', (await page.ev(`document.getElementById('pw').value + document.getElementById('user').value`)) === '', '');
r = await mcp('browser_click', { tab_id: tabId, selector: '#plain' });
check('harmless click runs without a window', !r.isError && (await page.ev('document.title')) === 'CLICKED', txt(r));
r = await mcp('browser_screenshot', { tab_id: tabId });
const png = (r.content || []).find((c) => c.type === 'image');
check('screenshot returns a PNG', png && Buffer.from(png.data, 'base64').subarray(1, 4).toString() === 'PNG', JSON.stringify(r).slice(0, 120));

// dangerous click: window appears, Deny, then Allow
async function answerConfirm(buttonId) {
  const t = await until(async () => (await cdp.send('Target.getTargets')).targetInfos.find((x) => x.url.includes('confirm.html')), 10000, 100);
  if (!t) return false;
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  await sleep(300);
  const shown = await cdp.send('Runtime.evaluate', { expression: `document.getElementById('what').textContent + ' | ' + document.getElementById('host').textContent`, returnByValue: true }, sessionId);
  await cdp.send('Runtime.evaluate', { expression: `document.getElementById('${buttonId}').click()`, returnByValue: true }, sessionId);
  return shown.result.value;
}
let pend = mcp('browser_click', { tab_id: tabId, selector: '#del' });
const shown = await answerConfirm('deny');
r = await pend;
check('confirmation window shows the action and host', shown && /Delete/.test(shown) && shown.includes('127.0.0.1'), shown);
check('Deny: the action did not run', r.isError && txt(r).includes('owner_declined') && (await page.ev('document.title')) === 'CLICKED', txt(r));
pend = mcp('browser_click', { tab_id: tabId, selector: '#del' });
await answerConfirm('allow');
r = await pend;
check('Allow once: the action runs', !r.isError && (await page.ev('document.title')) === 'DELETED', txt(r));
const audit = JSON.stringify((await api('GET', '/v1/owner/audit', owner)).json);
check('audit records the on-device confirmation, no page content or secrets', audit.includes('owner_on_device') && !audit.includes('hunter2') && !audit.includes('Hello from'), '');

// policy
r = await mcp('browser_navigate', { tab_id: tabId, url: 'http://localhost:' + sitePort + '/' });
check('navigate to a host outside the allowlist refused', r.isError && txt(r).includes('domain_denied'), txt(r));
r = await mcp('browser_tabs_list', {});
check('tabs_list shows only allowed tabs (not about:blank, not extension pages)', JSON.parse(txt(r)).tabs.every((t) => t.url.startsWith(SITE)), txt(r));
r = await mcp('browser_click', { tab_id: tabId, selector: '#out' });
check('a link leading outside the allowlist returns nothing', r.isError && txt(r).includes('domain_denied'), txt(r));

// optional: a real MCP client (Claude Code) against the same relay
if (claudePath) {
  const cfgPath = join(work, 'mcp.json');
  writeFileSync(cfgPath, JSON.stringify({ mcpServers: { browser: { type: 'http', url: R + '/mcp', headers: { Authorization: 'Bearer ' + agentTok } } } }));
  await mcp('browser_navigate', { tab_id: tabId, url: SITE + '/' });
  const p = spawnSync(claudePath, ['-p', 'Call the tool browser_read_page with tab_id ' + tabId + ' and reply with the page heading only.', '--mcp-config', cfgPath, '--strict-mcp-config', '--allowedTools', 'mcp__browser__browser_read_page', '--output-format', 'text'], { encoding: 'utf8', timeout: 150000 });
  console.log('claude exit ' + p.status + ': ' + (p.stdout || p.stderr || '').slice(0, 300).replace(/\s+/g, ' '));
  check('Claude Code reads the live page through the relay', p.status === 0 && /Hello from the e2e site/i.test(p.stdout || ''), (p.stdout || p.stderr || '').slice(0, 200));
}

// pause / resume / revoke
await popup.ev(`document.getElementById('pauseBtn').click()`);
check('pause: popup says Paused and the agent gets browser_offline', await until(async () => (await popupText('status')) === 'Paused', 5000) && txt(await mcp('browser_tabs_list', {})).includes('browser_offline'), '');
await popup.ev(`document.getElementById('pauseBtn').click()`);
check('resume reconnects', await until(async () => (await popupText('status')) === 'Connected', 15000), await popupText('status'));
const devId = JSON.stringify((await api('GET', '/v1/owner/devices', owner)).json).match(/"id":"([^"]+)"/)[1];
const t0 = Date.now();
await api('DELETE', '/v1/owner/devices/' + devId, owner);
check('owner revoke: browser ends up revoked, not retrying', await until(async () => (await popupText('status')).startsWith('Revoked'), 15000), await popupText('status'));
console.log('revoke seen in ' + (Date.now() - t0) + ' ms');
await popup.ev(`document.getElementById('relay').value=${JSON.stringify(R)}`);

finish();

function finish() {
  const failed = results.filter((x) => !x.ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  writeFileSync(join(work, 'result.json'), JSON.stringify(results, null, 2));
  cleanup();
  setTimeout(() => process.exit(failed.length ? 1 : 0), 500);
}
