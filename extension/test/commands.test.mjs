import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrowser, makeCommands, env } from './helpers.mjs';

const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r)); return r.result; };
const err = (r, code) => { assert.equal(r.ok, false, JSON.stringify(r)); assert.equal(r.error.code, code, JSON.stringify(r)); };

async function own(br, cmds, page, url = 'https://example.com/') {
  const id = ok(await cmds.handle(env('tabs_open', { url }))).tab_id;
  if (page) br.pages.set(id, page);
  return id;
}

test('tabs_list shows only tabs this agent opened', async () => {
  const br = fakeBrowser(['https://example.com/a', 'https://evil.test/', 'chrome://settings', 'https://online.sberbank.ru/']);
  const { cmds } = makeCommands(br);
  const hidden = ok(await cmds.handle(env('tabs_list', {})));
  assert.deepEqual(hidden.tabs, []);
  const id = await own(br, cmds, null, 'https://example.com/a');
  const r = ok(await cmds.handle(env('tabs_list', {})));
  assert.deepEqual(r.tabs.map((t) => t.url), ['https://example.com/a']);
  err(await cmds.handle(env('read_page', { tab_id: id }, { agent: 'codex' })), 'tab_in_use');
  err(await cmds.handle(env('read_page', { tab_id: id, session: 'other' })), 'tab_in_use');
  const again = ok(await cmds.handle(env('tabs_list', { session: 'other' })));
  assert.deepEqual(again.tabs, []);
});

test('tabs_open refuses outside domains and closes tabs that redirect out', async () => {
  const br = fakeBrowser();
  const { cmds } = makeCommands(br);
  err(await cmds.handle(env('tabs_open', { url: 'https://evil.test/' })), 'domain_denied');
  assert.equal(br.tabs.size, 0);
  const origCreate = br.api.tabs.create;
  br.api.tabs.create = async (o) => { const t = await origCreate(o); br.tabs.get(t.id).url = 'https://evil.test/landing'; return t; };
  err(await cmds.handle(env('tabs_open', { url: 'https://example.com/' })), 'domain_denied');
  assert.equal(br.tabs.size, 0, 'redirected tab was closed');
  br.api.tabs.create = origCreate;
  const r = ok(await cmds.handle(env('tabs_open', { url: 'https://example.com/ok' })));
  assert.equal(r.url, 'https://example.com/ok');
  assert.equal(br.tabs.get(r.tab_id).active, false);
});

test('navigate stays inside the owned tab', async () => {
  const br = fakeBrowser(['https://example.com/', 'https://online.sberbank.ru/']);
  const { cmds } = makeCommands(br);
  err(await cmds.handle(env('navigate', { tab_id: 1, url: 'https://example.com/x' })), 'not_your_tab');
  const id = await own(br, cmds);
  err(await cmds.handle(env('navigate', { tab_id: id, url: 'https://evil.test/' })), 'domain_denied');
  ok(await cmds.handle(env('navigate', { tab_id: id, url: 'https://example.com/x' })));
  const upd = br.api.tabs.update;
  br.api.tabs.update = async (tid, o) => { await upd(tid, o); br.tabs.get(tid).url = 'https://evil.test/'; };
  err(await cmds.handle(env('navigate', { tab_id: id, url: 'https://example.com/y' })), 'domain_denied');
});

test('read_page works on the agent tab and returns nothing from others', async () => {
  const br = fakeBrowser(['https://example.com/', 'https://evil.test/']);
  const { cmds } = makeCommands(br);
  const id = await own(br, cmds, { text: 'hello', elements: {} });
  assert.equal(ok(await cmds.handle(env('read_page', { tab_id: id }))).text, 'hello');
  err(await cmds.handle(env('read_page', { tab_id: 1 })), 'not_your_tab');
  err(await cmds.handle(env('read_page', { tab_id: 99 })), 'no_such_tab');
  err(await cmds.handle(env('read_page', {})), 'bad_args');
});

test('the page moving away mid-command hides the result', async () => {
  const br = fakeBrowser();
  const run = br.api.runPage;
  let id = 0;
  br.api.runPage = async (...a) => { const r = await run(...a); br.tabs.get(id).url = 'https://evil.test/'; return r; };
  const { cmds } = makeCommands(br);
  id = await own(br, cmds, { text: 'secret of the new page', elements: {} });
  err(await cmds.handle(env('read_page', { tab_id: id })), 'domain_denied');
});

test('local lists narrow access', async () => {
  const br = fakeBrowser();
  const local = { localDenied: [] };
  const { cmds } = makeCommands(br, { local });
  const id = await own(br, cmds, { text: 'x', elements: {} });
  local.localDenied = ['example.com'];
  err(await cmds.handle(env('read_page', { tab_id: id })), 'domain_denied');
});

test('screenshot does not activate the user tab or open a window', async () => {
  const br = fakeBrowser(['https://www.youtube.com/keep']);
  br.tabs.get(1).active = true;
  const { cmds } = makeCommands(br);
  const id = await own(br, cmds);
  err(await cmds.handle(env('screenshot', { tab_id: id })), 'not_visible');
  assert.equal(br.tabs.get(1).active, true);
  assert.equal(br.tabs.get(id).active, false);
  assert.equal(br.tabs.get(id).windowId, 1);
  assert.ok(br.tabs.get(id).groupId);
});

test('typing into password, code and login fields is needs_human', async () => {
  const br = fakeBrowser();
  const { cmds } = makeCommands(br);
  const page = { elements: {
    '#pw': { tag: 'input', type: 'password' },
    '#otp': { tag: 'input', type: 'text', autocomplete: 'one-time-code' },
    '#user': { tag: 'input', type: 'text', name: 'login', formHasPassword: true },
    '#q': { tag: 'input', type: 'search', name: 'q' },
  } };
  const id = await own(br, cmds, page);
  for (const sel of ['#pw', '#otp', '#user']) {
    err(await cmds.handle(env('type', { tab_id: id, selector: sel, text: 'x' })), 'needs_human');
    err(await cmds.handle(env('form_input', { tab_id: id, selector: sel, value: 'x' })), 'needs_human');
  }
  assert.equal(br.pages.get(id).filled, undefined, 'nothing was typed');
  ok(await cmds.handle(env('type', { tab_id: id, selector: '#q', text: 'cats' })));
  assert.equal(br.pages.get(id).filled.text, 'cats');
  ok(await cmds.handle(env('form_input', { tab_id: id, ref: '#q', value: 'dogs' })));
  err(await cmds.handle(env('type', { tab_id: id, selector: '#nope', text: 'x' })), 'element_not_found');
  err(await cmds.handle(env('type', { tab_id: id, text: 'x' })), 'bad_args');
});

test('dangerous click: declined does nothing, approved runs and is reported', async () => {
  const br = fakeBrowser();
  const page = { elements: { '#del': { tag: 'button', text: 'Delete account' }, '#next': { tag: 'button', text: 'Next' } } };
  let m = makeCommands(br, { confirmAnswer: { approved: false } });
  const id = await own(br, m.cmds, page);
  err(await m.cmds.handle(env('click', { tab_id: id, selector: '#del' })), 'owner_declined');
  assert.equal(br.pages.get(id).clicked, undefined);
  assert.equal(m.asked.length, 1);
  assert.equal(m.asked[0].kind, 'delete');
  m = makeCommands(br, { confirmAnswer: { approved: true } });
  const id2 = await own(br, m.cmds, page);
  const r = ok(await m.cmds.handle(env('click', { tab_id: id2, selector: '#del' })));
  assert.equal(r.confirmed_by, 'owner_on_device');
  assert.equal(br.pages.get(id2).clicked, 1);
  m = makeCommands(br);
  const id3 = await own(br, m.cmds, page);
  ok(await m.cmds.handle(env('click', { tab_id: id3, selector: '#next' })));
  assert.equal(m.asked.length, 0);
});

test('relay saying confirmed:true never skips the window', async () => {
  const br = fakeBrowser();
  const m = makeCommands(br, { confirmAnswer: { approved: false } });
  const id = await own(br, m.cmds, { elements: { '#pay': { tag: 'button', text: 'Pay now' } } });
  err(await m.cmds.handle(env('click', { tab_id: id, selector: '#pay' }, { confirmed: true })), 'owner_declined');
  assert.equal(m.asked.length, 1);
});

test('trust grants skip the window for submits but never for payments', async () => {
  const br = fakeBrowser();
  const page = { elements: {
    '#send': { tag: 'button', text: 'Send', isSubmit: true, formMethod: 'post' },
    '#pay': { tag: 'button', text: 'Buy' },
  } };
  const m = makeCommands(br, { confirmAnswer: { approved: true, trust: true } });
  const id = await own(br, m.cmds, page);
  ok(await m.cmds.handle(env('click', { tab_id: id, selector: '#send' })));
  assert.equal(m.asked.length, 1);
  assert.equal(m.trust.list.length, 1);
  const r2 = ok(await m.cmds.handle(env('click', { tab_id: id, selector: '#send' })));
  assert.equal(m.asked.length, 1, 'second submit trusted');
  assert.equal(r2.confirmed_by, 'trusted_grant');
  ok(await m.cmds.handle(env('click', { tab_id: id, selector: '#pay' })));
  assert.equal(m.asked.length, 2, 'payment still asks');
});

test('a click that lands outside the allowlist returns nothing', async () => {
  const br = fakeBrowser();
  const { cmds } = makeCommands(br);
  const id = await own(br, cmds, { elements: { '#go': { tag: 'a', text: 'Out', href: 'https://evil.test/' } }, onClick: (t) => { t.url = 'https://evil.test/'; } });
  err(await cmds.handle(env('click', { tab_id: id, selector: '#go' })), 'domain_denied');
});

test('unknown commands and thrown errors are reported, not raised', async () => {
  const br = fakeBrowser();
  br.api.runPage = async () => { throw new Error('Cannot access contents of the page'); };
  const { cmds } = makeCommands(br);
  const id = await own(br, cmds);
  err(await cmds.handle(env('run_js', {})), 'unknown_command');
  err(await cmds.handle(env('read_page', { tab_id: id })), 'page_unavailable');
});

test('set_file pulls a relay blob into the agent tab only', async () => {
  const br = fakeBrowser(['https://www.youtube.com/keep']);
  const ops = [];
  const orig = br.api.runPage;
  br.api.runPage = async (tabId, op, arg) => {
    ops.push(op);
    if (op === 'file_commit') return { attached: 'clip.mp4' };
    if (op === 'file_begin' || op === 'file_chunk') return { ok: true };
    return orig(tabId, op, arg);
  };
  const { cmds } = makeCommands(br);
  const id = ok(await cmds.handle(env('tabs_open', { url: 'https://example.com/upload', session: 'yt-up' }))).tab_id;
  const token = 'ab'.repeat(16);
  const blob = 'http://127.0.0.1:18791/v1/blob/' + 'cd'.repeat(8);
  const r = ok(await cmds.handle(env('set_file', {
    tab_id: id, session: 'yt-up', selector: 'input[type=file]', url: blob, token, filename: 'clip.mp4',
  })));
  assert.equal(r.bytes, 4);
  assert.equal(r.url, 'https://example.com/upload');
  assert.equal(ops.includes('file_begin') && ops.includes('file_chunk') && ops.includes('file_commit'), true);
  assert.equal(br.tabs.get(1).url, 'https://www.youtube.com/keep');
  err(await cmds.handle(env('set_file', {
    tab_id: id, session: 'other', selector: 'input[type=file]', url: blob, token,
  })), 'tab_in_use');
  err(await cmds.handle(env('set_file', {
    tab_id: id, session: 'yt-up', selector: 'input[type=file]', url: 'https://evil.test/clip.mp4', token,
  })), 'bad_args');
});

test('set_file ignores a debugger and keeps the in-page file path', async () => {
  const br = fakeBrowser(['https://www.youtube.com/keep']);
  const calls = [];
  const ops = [];
  const orig = br.api.runPage;
  br.api.runPage = async (tabId, op, arg) => {
    ops.push(op);
    if (op === 'file_commit') return { attached: 'clip.mp4', bytes: 4 };
    if (op === 'file_begin' || op === 'file_chunk') return { ok: true };
    return orig(tabId, op, arg);
  };
  const token = 'ab'.repeat(16);
  const blob = 'http://127.0.0.1:18791/v1/blob/' + 'cd'.repeat(8);
  const debug = {
    attach: async () => { calls.push('attach'); },
    detach: async () => { calls.push('detach'); },
    send: async () => { calls.push('send'); return {}; },
  };
  const { cmds } = makeCommands(br, { overrides: { debug } });
  const id = ok(await cmds.handle(env('tabs_open', { url: 'https://example.com/upload', session: 'yt-up' }))).tab_id;
  const r = ok(await cmds.handle(env('set_file', {
    tab_id: id, session: 'yt-up', url: blob, token, filename: 'clip.mp4',
  })));
  assert.equal(r.attached, 'clip.mp4');
  assert.equal(calls.length, 0);
  assert.equal(ops.includes('file_begin'), true);
  assert.equal(br.tabs.get(1).url, 'https://www.youtube.com/keep');
});

test('two agents do not share tabs and do not raise a window', async () => {
  const br = fakeBrowser(['https://example.com/user']);
  br.tabs.get(1).active = true;
  const updates = [];
  const origUpdate = br.api.tabs.update;
  br.api.tabs.update = async (id, patch) => {
    updates.push(patch);
    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'active'), false);
    return origUpdate(id, patch);
  };
  let raised = false;
  br.api.windows.create = async () => { raised = true; throw new Error('window'); };
  br.api.windows.update = async () => { raised = true; throw new Error('focus'); };
  const { cmds } = makeCommands(br);
  const a = ok(await cmds.handle(env('tabs_open', { url: 'https://example.com/a', session: 'one' }, { agent: 'grok' }))).tab_id;
  const b = ok(await cmds.handle(env('tabs_open', { url: 'https://example.com/b', session: 'one' }, { agent: 'codex' }))).tab_id;
  assert.equal(br.tabs.get(a).active, false);
  assert.equal(br.tabs.get(b).active, false);
  assert.equal(br.tabs.get(1).active, true);
  assert.notEqual(br.tabs.get(a).groupId, br.tabs.get(b).groupId);
  const listG = ok(await cmds.handle(env('tabs_list', { session: 'one' }, { agent: 'grok' })));
  assert.deepEqual(listG.tabs.map((t) => t.id), [a]);
  err(await cmds.handle(env('read_page', { tab_id: 1, session: 'one' }, { agent: 'grok' })), 'not_your_tab');
  err(await cmds.handle(env('read_page', { tab_id: a, session: 'one' }, { agent: 'codex' })), 'tab_in_use');
  ok(await cmds.handle(env('navigate', { tab_id: a, url: 'https://example.com/a2', session: 'one' }, { agent: 'grok' })));
  assert.ok(updates.length > 0);
  assert.equal(raised, false);
  assert.ok(updates.every((patch) => !Object.prototype.hasOwnProperty.call(patch, 'active')));
});

test('studio open waits out a brief accounts.google.com hop', async () => {
  const br = fakeBrowser(['https://www.youtube.com/keep']);
  let reads = 0;
  const origGet = br.api.tabs.get;
  br.api.tabs.get = async (id) => {
    const t = await origGet(id);
    reads++;
    if (String(t.url).includes('studio.youtube.com') && reads < 4) {
      return { ...t, url: 'https://accounts.google.com/ServiceLogin?passive=true' };
    }
    return t;
  };
  const { cmds } = makeCommands(br);
  const r = ok(await cmds.handle(env('tabs_open', {
    url: 'https://studio.youtube.com/channel/UCKQQz6ZEdpdmsOZwJj_1mgw/videos',
    session: 'yt-up',
  }, { allowed_domains: ['studio.youtube.com', 'youtube.com'] })));
  assert.equal(r.url, 'https://studio.youtube.com/channel/UCKQQz6ZEdpdmsOZwJj_1mgw/videos');
  assert.equal(br.tabs.get(1).url, 'https://www.youtube.com/keep');
});

test('two sessions of one agent do not share tabs', async () => {
  const br = fakeBrowser(['https://www.youtube.com/keep']);
  const { cmds } = makeCommands(br);
  const a = ok(await cmds.handle(env('tabs_open', { url: 'https://example.com/a', session: 'chat-a' }))).tab_id;
  const b = ok(await cmds.handle(env('tabs_open', { url: 'https://example.com/b', session: 'chat-b' }))).tab_id;
  const listA = ok(await cmds.handle(env('tabs_list', { session: 'chat-a' })));
  assert.deepEqual(listA.tabs.map((t) => t.id), [a]);
  err(await cmds.handle(env('navigate', { tab_id: b, url: 'https://example.com/nope', session: 'chat-a' })), 'tab_in_use');
  assert.equal(br.tabs.get(1).url, 'https://www.youtube.com/keep');
});
