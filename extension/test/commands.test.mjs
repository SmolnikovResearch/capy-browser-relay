import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrowser, makeCommands, env } from './helpers.mjs';

const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.result; };
const err = (r, code) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.error.code, code, JSON.stringify(r)); };

test('tabs_list hides pages outside the allowlist and non-http tabs', async () => {
  const br = fakeBrowser(['https://example.com/a', 'https://evil.test/', 'chrome://settings', 'https://online.sberbank.ru/']);
  const { cmds } = makeCommands(br);
  const r = ok(await cmds.handle(env('tabs_list', {})));
  assert.deepEqual(r.tabs.map((t) => t.url), ['https://example.com/a']);
});

test('tabs_open refuses outside domains and closes tabs that redirect out', async () => {
  const br = fakeBrowser();
  const { cmds } = makeCommands(br);
  err(await cmds.handle(env('tabs_open', { url: 'https://evil.test/' })), 'domain_denied');
  assert.equal(br.tabs.size, 0);
  // a redirect: the tab ends up elsewhere
  const origCreate = br.api.tabs.create;
  br.api.tabs.create = async (o) => { const t = await origCreate(o); br.tabs.get(t.id).url = 'https://evil.test/landing'; return t; };
  err(await cmds.handle(env('tabs_open', { url: 'https://example.com/' })), 'domain_denied');
  assert.equal(br.tabs.size, 0, 'redirected tab was closed');
  br.api.tabs.create = origCreate;
  const r = ok(await cmds.handle(env('tabs_open', { url: 'https://example.com/ok' })));
  assert.equal(r.url, 'https://example.com/ok');
});

test('navigate checks target and denied current page, and the landing page', async () => {
  const br = fakeBrowser(['https://example.com/', 'https://online.sberbank.ru/']);
  const { cmds } = makeCommands(br);
  err(await cmds.handle(env('navigate', { tab_id: 1, url: 'https://evil.test/' })), 'domain_denied');
  err(await cmds.handle(env('navigate', { tab_id: 2, url: 'https://example.com/' }, { allowed_domains: ['example.com', 'sberbank.ru'] })), 'domain_denied');
  ok(await cmds.handle(env('navigate', { tab_id: 1, url: 'https://example.com/x' })));
  // redirect after navigation
  const upd = br.api.tabs.update;
  br.api.tabs.update = async (id, o) => { await upd(id, o); br.tabs.get(id).url = 'https://evil.test/'; };
  err(await cmds.handle(env('navigate', { tab_id: 1, url: 'https://example.com/y' })), 'domain_denied');
});

test('read_page works on allowed tabs and returns nothing from others', async () => {
  const br = fakeBrowser(['https://example.com/', 'https://evil.test/']);
  br.pages.set(1, { text: 'hello', elements: {} });
  const { cmds } = makeCommands(br);
  assert.equal(ok(await cmds.handle(env('read_page', { tab_id: 1 }))).text, 'hello');
  err(await cmds.handle(env('read_page', { tab_id: 2 })), 'domain_denied');
  err(await cmds.handle(env('read_page', { tab_id: 99 })), 'no_such_tab');
  err(await cmds.handle(env('read_page', {})), 'bad_args');
});

test('the page moving away mid-command hides the result', async () => {
  const br = fakeBrowser(['https://example.com/']);
  const run = br.api.runPage;
  br.api.runPage = async (...a) => { const r = await run(...a); br.tabs.get(1).url = 'https://evil.test/'; return r; };
  br.pages.set(1, { text: 'secret of the new page', elements: {} });
  const { cmds } = makeCommands(br);
  err(await cmds.handle(env('read_page', { tab_id: 1 })), 'domain_denied');
});

test('local lists narrow access', async () => {
  const br = fakeBrowser(['https://example.com/']);
  const { cmds } = makeCommands(br, { local: { localDenied: ['example.com'] } });
  err(await cmds.handle(env('read_page', { tab_id: 1 })), 'domain_denied');
});

test('screenshot returns bare base64', async () => {
  const br = fakeBrowser(['https://example.com/']);
  const { cmds } = makeCommands(br);
  const r = ok(await cmds.handle(env('screenshot', { tab_id: 1 })));
  assert.equal(r.data, 'QUJD');
  assert.equal(r.mime_type, 'image/png');
  assert.equal(br.tabs.get(1).active, true);
});

test('typing into password, code and login fields is needs_human', async () => {
  const br = fakeBrowser(['https://example.com/']);
  br.pages.set(1, { elements: {
    '#pw': { tag: 'input', type: 'password' },
    '#otp': { tag: 'input', type: 'text', autocomplete: 'one-time-code' },
    '#user': { tag: 'input', type: 'text', name: 'login', formHasPassword: true },
    '#q': { tag: 'input', type: 'search', name: 'q' },
  } });
  const { cmds } = makeCommands(br);
  for (const sel of ['#pw', '#otp', '#user']) {
    err(await cmds.handle(env('type', { tab_id: 1, selector: sel, text: 'x' })), 'needs_human');
    err(await cmds.handle(env('form_input', { tab_id: 1, selector: sel, value: 'x' })), 'needs_human');
  }
  assert.equal(br.pages.get(1).filled, undefined, 'nothing was typed');
  ok(await cmds.handle(env('type', { tab_id: 1, selector: '#q', text: 'cats' })));
  assert.equal(br.pages.get(1).filled.text, 'cats');
  ok(await cmds.handle(env('form_input', { tab_id: 1, ref: '#q', value: 'dogs' })));
  err(await cmds.handle(env('type', { tab_id: 1, selector: '#nope', text: 'x' })), 'element_not_found');
  err(await cmds.handle(env('type', { tab_id: 1, text: 'x' })), 'bad_args');
});

test('dangerous click: declined does nothing, approved runs and is reported', async () => {
  const br = fakeBrowser(['https://example.com/']);
  br.pages.set(1, { elements: { '#del': { tag: 'button', text: 'Delete account' }, '#next': { tag: 'button', text: 'Next' } } });
  let m = makeCommands(br, { confirmAnswer: { approved: false } });
  err(await m.cmds.handle(env('click', { tab_id: 1, selector: '#del' })), 'owner_declined');
  assert.equal(br.pages.get(1).clicked, undefined);
  assert.equal(m.asked.length, 1);
  assert.equal(m.asked[0].kind, 'delete');
  m = makeCommands(br, { confirmAnswer: { approved: true } });
  const r = ok(await m.cmds.handle(env('click', { tab_id: 1, selector: '#del' })));
  assert.equal(r.confirmed_by, 'owner_on_device');
  assert.equal(br.pages.get(1).clicked, 1);
  // harmless click: no window
  m = makeCommands(br);
  ok(await m.cmds.handle(env('click', { tab_id: 1, selector: '#next' })));
  assert.equal(m.asked.length, 0);
});

test('relay saying confirmed:true never skips the window', async () => {
  const br = fakeBrowser(['https://example.com/']);
  br.pages.set(1, { elements: { '#pay': { tag: 'button', text: 'Pay now' } } });
  const m = makeCommands(br, { confirmAnswer: { approved: false } });
  err(await m.cmds.handle(env('click', { tab_id: 1, selector: '#pay' }, { confirmed: true })), 'owner_declined');
  assert.equal(m.asked.length, 1);
});

test('trust grants skip the window for submits but never for payments', async () => {
  const br = fakeBrowser(['https://example.com/']);
  br.pages.set(1, { elements: {
    '#send': { tag: 'button', text: 'Send', isSubmit: true, formMethod: 'post' },
    '#pay': { tag: 'button', text: 'Buy' },
  } });
  const m = makeCommands(br, { confirmAnswer: { approved: true, trust: true } });
  ok(await m.cmds.handle(env('click', { tab_id: 1, selector: '#send' })));
  assert.equal(m.asked.length, 1);
  assert.equal(m.trust.list.length, 1);
  const r2 = ok(await m.cmds.handle(env('click', { tab_id: 1, selector: '#send' })));
  assert.equal(m.asked.length, 1, 'second submit trusted');
  assert.equal(r2.confirmed_by, 'trusted_grant');
  ok(await m.cmds.handle(env('click', { tab_id: 1, selector: '#pay' })));
  assert.equal(m.asked.length, 2, 'payment still asks');
});

test('a click that lands outside the allowlist returns nothing', async () => {
  const br = fakeBrowser(['https://example.com/']);
  br.pages.set(1, { elements: { '#go': { tag: 'a', text: 'Out', href: 'https://evil.test/' } }, onClick: (t) => { t.url = 'https://evil.test/'; } });
  const { cmds } = makeCommands(br);
  err(await cmds.handle(env('click', { tab_id: 1, selector: '#go' })), 'domain_denied');
});

test('unknown commands and thrown errors are reported, not raised', async () => {
  const br = fakeBrowser(['https://example.com/']);
  br.api.runPage = async () => { throw new Error('Cannot access contents of the page'); };
  const { cmds } = makeCommands(br);
  err(await cmds.handle(env('run_js', {})), 'unknown_command');
  err(await cmds.handle(env('read_page', { tab_id: 1 })), 'page_unavailable');
});
