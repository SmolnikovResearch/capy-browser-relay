// Runs the real extension client against the real Go relay (built from this
// repo) with a fake browser underneath: pairing, key proof, commands over MCP,
// revoke, reconnect with backoff. Skipped when `go` is not available.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { createClient } from '../lib/relayclient.js';
import * as K from '../lib/keys.js';
import { fakeBrowser, makeCommands } from './helpers.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let haveGo = true;
try { execFileSync('go', ['version'], { stdio: 'ignore' }); } catch { haveGo = false; }

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(f, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(25); } return false; }

// in-memory stand-ins for chrome.storage and IndexedDB
function memStore() {
  let cfg = {};
  return { get: async () => ({ ...cfg }), patch: async (p) => { cfg = { ...cfg, ...p }; }, raw: () => cfg };
}
function memKeys() {
  let kp = null;
  return {
    get: async () => kp || (kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])),
    create: async () => (kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])),
    remove: async () => { kp = null; },
    pub: K.publicKeyB64,
    sign: K.sign,
    verify: async (stored) => {
      if (!kp) return { ok: false, reason: 'no_key' };
      return (await K.publicKeyB64(kp)) === stored ? { ok: true } : { ok: false, reason: 'public_key_mismatch' };
    },
    swap: async () => { kp = null; await sleep(0); kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']); },
  };
}

async function startRelay(port, dir, bin) {
  const p = spawn(bin, ['-listen', '127.0.0.1:' + port, '-data', dir], { env: { ...process.env, RELAY_ADMIN_TOKEN: 'adm' }, stdio: 'ignore' });
  const base = 'http://127.0.0.1:' + port;
  assert.ok(await until(async () => { try { return (await fetch(base + '/healthz')).ok; } catch { return false; } }, 5000), 'relay did not start');
  return { p, base };
}

const api = (base) => async (method, path, token, body) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

const mcp = (base, agent) => async (name, args) => {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + agent, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const j = await r.json();
  return j.result;
};
const textOf = (res) => res.content.map((c) => c.text || '').join('');

test('extension client against the real relay', { skip: !haveGo, timeout: 90000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'cbr-'));
  const bin = join(tmp, 'relay');
  execFileSync('go', ['build', '-o', bin, './cmd/relay'], { cwd: root, stdio: 'inherit' });
  const port = await freePort();
  let { p, base } = await startRelay(port, join(tmp, 'data'), bin);
  t.after(() => { p.kill(); rmSync(tmp, { recursive: true, force: true }); });
  const A = api(base);

  const ten = (await A('POST', '/admin/tenants', 'adm', { name: 'it' })).json;
  const owner = ten.owner_token;
  const agent = (await A('POST', '/v1/owner/agents', owner, { name: 'claude-code', scopes: ['read', 'act'], domains: ['example.com'], ttl_seconds: 3600 })).json.token;

  const br = fakeBrowser(['https://example.com/page', 'https://evil.test/']);
  br.pages.set(1, { text: 'PAGE TEXT', elements: {
    '#q': { tag: 'input', type: 'search', name: 'q' },
    '#pw': { tag: 'input', type: 'password' },
    '#del': { tag: 'button', text: 'Delete account' },
  } });
  let answer = { approved: false };
  const m = makeCommands(br);
  // route confirm through a mutable answer
  const { createCommands } = await import('../lib/commands.js');
  const cmds = createCommands({ ...br.api, confirm: async (r) => answer, trust: m.trust, getLocal: async () => ({}) });

  const store = memStore();
  const keys = memKeys();
  const statuses = [];
  const client = createClient({
    store, keys, WS: WebSocket, fetchFn: fetch, handle: (e) => cmds.handle(e),
    setTimer: setTimeout, clearTimer: clearTimeout, setIntervalFn: setInterval, clearIntervalFn: clearInterval,
    now: Date.now, defaultName: 'test', onStatus: (s) => statuses.push(s),
  });
  t.after(() => client.disconnect());

  // wrong code
  await assert.rejects(client.pair({ relay: base, code: 'AAAAAAAA', name: 'node' }), /wrong or expired/);
  // plain http to a remote host is refused before anything is sent
  await assert.rejects(client.pair({ relay: 'http://relay.example.com', code: 'AAAAAAAA', name: 'x' }), /https/);

  const code = (await A('POST', '/v1/owner/pair-codes', owner)).json.code;
  await client.pair({ relay: base, code, name: 'node laptop' });
  assert.ok(await until(() => client.state().status === 'connected'), 'connected ' + JSON.stringify(client.state()));
  const devs = (await A('GET', '/v1/owner/devices', owner)).json;
  assert.equal(JSON.stringify(devs).includes('node laptop'), true);

  const call = mcp(base, agent);
  // the user's already-open tabs are not listed and cannot be driven
  let r = await call('browser_tabs_list', { session: 'it' });
  assert.doesNotMatch(textOf(r), /example\.com\/page/);
  assert.doesNotMatch(textOf(r), /evil\.test/);
  r = await call('browser_tabs_open', { url: 'https://example.com/owned', session: 'it' });
  assert.equal(r.isError, false, textOf(r));
  const tabId = JSON.parse(textOf(r)).tab_id;
  br.pages.set(tabId, br.pages.get(1));
  r = await call('browser_tabs_list', { session: 'it' });
  assert.match(textOf(r), /example\.com\/owned/);
  r = await call('browser_read_page', { tab_id: tabId, session: 'it' });
  assert.match(textOf(r), /PAGE TEXT/);
  r = await call('browser_read_page', { tab_id: 1, session: 'it' });
  assert.equal(r.isError, true);
  r = await call('browser_read_page', { tab_id: tabId, session: 'other' });
  assert.equal(r.isError, true);
  // form
  r = await call('browser_form_input', { tab_id: tabId, selector: '#q', value: 'hello', session: 'it' });
  assert.equal(r.isError, false, textOf(r));
  assert.equal(br.pages.get(tabId).filled.value, 'hello');
  r = await call('browser_type', { tab_id: tabId, selector: '#pw', text: 'hunter2', session: 'it' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /needs_human/);
  // dangerous click: declined, then approved on the device; audit shows who
  r = await call('browser_click', { tab_id: tabId, selector: '#del', session: 'it' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /owner_declined/);
  assert.equal(br.pages.get(tabId).clicked, undefined);
  answer = { approved: true };
  r = await call('browser_click', { tab_id: tabId, selector: '#del', session: 'it' });
  assert.equal(r.isError, false, textOf(r));
  const audit = JSON.stringify((await A('GET', '/v1/owner/audit', owner)).json);
  assert.match(audit, /"confirmed_by":"owner_on_device"/);
  assert.equal(audit.includes('hunter2'), false);

  // a different key with the same token is refused (device key binding)
  const cfg = store.raw();
  const stolen = new WebSocket(base.replace('http', 'ws') + '/v1/device/ws');
  const got = await new Promise((res) => {
    stolen.onopen = () => stolen.send(JSON.stringify({ type: 'auth', token: cfg.token }));
    stolen.onmessage = async (ev) => {
      const j = JSON.parse(ev.data);
      if (j.type === 'challenge') {
        const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
        stolen.send(JSON.stringify({ type: 'proof', sig: await K.sign(other, 'capy-auth|' + cfg.deviceId + '|' + j.nonce) }));
      } else res(j);
    };
    stolen.onclose = () => res({ type: 'closed' });
  });
  assert.notEqual(got.type, 'ready');

  // relay restart: reconnect with backoff, same token, same key
  p.kill();
  assert.ok(await until(() => client.state().status === 'offline', 5000), 'noticed the drop');
  ({ p } = await startRelay(port, join(tmp, 'data'), bin));
  t.after(() => p.kill());
  assert.ok(await until(() => client.state().status === 'connected', 15000), 'reconnected ' + JSON.stringify(client.state()));
  r = await call('browser_read_page', { tab_id: tabId, session: 'it' });
  assert.match(textOf(r), /PAGE TEXT/);

  // pause closes the link; resume restores it
  await client.setPaused(true);
  assert.ok(await until(async () => textOf(await call('browser_tabs_list', {})).includes('browser_offline'), 3000));
  await client.setPaused(false);
  assert.ok(await until(() => client.state().status === 'connected'));

  // owner revokes the device on the relay: the extension ends up 'revoked' and stops retrying
  const dev = (await A('GET', '/v1/owner/devices', owner)).json;
  const id = JSON.stringify(dev).match(/"id":"([^"]+)"/)[1];
  const t0 = Date.now();
  await A('DELETE', '/v1/owner/devices/' + id, owner);
  assert.ok(await until(() => ['offline', 'revoked'].includes(client.state().status), 2000));
  assert.ok(Date.now() - t0 < 2500, 'closed within 2 s');
  assert.ok(await until(() => client.state().status === 'revoked', 12000), 'ended revoked: ' + client.state().status);
  assert.equal(store.raw().token, '');

  // key mismatch: a swapped key store stops the client before it connects
  const code2 = (await A('POST', '/v1/owner/pair-codes', owner)).json.code;
  await client.pair({ relay: base, code: code2, name: 'second' });
  assert.ok(await until(() => client.state().status === 'connected'));
  await client.disconnect();
  await keys.swap();
  await client.connect();
  assert.equal(client.state().status, 'key_error');

  // unpair tells the relay
  await keys.create();
  const code3 = (await A('POST', '/v1/owner/pair-codes', owner)).json.code;
  await client.pair({ relay: base, code: code3, name: 'third' });
  assert.ok(await until(() => client.state().status === 'connected'));
  const tok = store.raw().token;
  await client.unpair();
  assert.equal(client.state().status, 'unpaired');
  assert.equal((await A('POST', '/v1/device/unpair', tok)).status, 401, 'token already revoked');
});
