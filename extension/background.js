// Service worker: glue between Chrome and the relay client. All policy lives
// in lib/ and is tested in node; this file only wires the real chrome.* APIs.
import { createClient } from './lib/relayclient.js';
import { createCommands } from './lib/commands.js';
import { capyPage } from './lib/page.js';
import * as K from './lib/keys.js';

const LOCAL_KEYS = ['relay', 'deviceId', 'token', 'expires', 'name', 'pub', 'paused', 'localAllowed', 'localDenied'];

const store = {
  async get() {
    const r = await chrome.storage.local.get('cfg');
    return r.cfg || {};
  },
  async patch(p) {
    const cur = await store.get();
    const next = { ...cur };
    for (const k of Object.keys(p)) if (LOCAL_KEYS.includes(k)) next[k] = p[k];
    await chrome.storage.local.set({ cfg: next });
  },
};

const keys = {
  get: K.getOrCreateKeyPair,
  create: K.createKeyPair,
  remove: K.deleteKeyPair,
  pub: K.publicKeyB64,
  sign: K.sign,
  verify: K.verifyStoredKey,
};

// ---------- trust grants ("trust this agent on this site for 15 minutes") ----------
const TRUST_MS = 15 * 60 * 1000;
const trust = {
  async list() {
    const r = await chrome.storage.local.get('trust');
    const now = Date.now();
    return (r.trust || []).filter((g) => g.until > now);
  },
  async has(agent, host) {
    return (await trust.list()).some((g) => g.agent === agent && g.host === host);
  },
  async add(agent, host) {
    const l = (await trust.list()).filter((g) => !(g.agent === agent && g.host === host));
    l.push({ agent, host, until: Date.now() + TRUST_MS });
    await chrome.storage.local.set({ trust: l });
  },
  async clear() {
    await chrome.storage.local.set({ trust: [] });
  },
};

// ---------- confirmation window ----------
const CONFIRM_TIMEOUT_MS = 25000; // under the relay's 30 s command timeout
const pending = new Map();

function confirm(req) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const entry = { req, resolve, winId: null, timer: null };
    const finish = (ans) => {
      if (!pending.delete(id)) return;
      clearTimeout(entry.timer);
      if (pending.size === 0) chrome.action.setBadgeText({ text: (BADGE[client.state().status] || [''])[0] });
      if (entry.winId != null) chrome.windows.remove(entry.winId).catch(() => {});
      resolve(ans);
    };
    entry.finish = finish;
    entry.timer = setTimeout(() => finish({ approved: false, reason: 'timeout' }), CONFIRM_TIMEOUT_MS);
    pending.set(id, entry);
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
    chrome.windows
      .create({ url: chrome.runtime.getURL('confirm.html?id=' + id), type: 'popup', width: 480, height: 440, focused: true })
      .then((w) => { entry.winId = w.id; })
      .catch(() => finish({ approved: false, reason: 'no_window' }));
  });
}

chrome.windows.onRemoved.addListener((winId) => {
  for (const e of pending.values()) if (e.winId === winId) e.finish({ approved: false, reason: 'closed' });
});

// ---------- activity log: metadata only ----------
async function logActivity(env, reply) {
  let host = '';
  try { host = new URL((env.args && env.args.url) || '').hostname; } catch { /* no url */ }
  const r = await chrome.storage.local.get('activity');
  const list = r.activity || [];
  list.unshift({ t: Date.now(), agent: env.agent, cmd: env.cmd, host, result: reply.ok ? 'ok' : reply.error.code });
  await chrome.storage.local.set({ activity: list.slice(0, 50) });
}

// ---------- chrome.* adapters for lib/commands.js ----------
function waitForLoad(tabId, ms = 15000) {
  return new Promise((resolve) => {
    let done = false;
    const end = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(on); clearTimeout(t); resolve(); } };
    const on = (id, info) => { if (id === tabId && info.status === 'complete') end(); };
    const t = setTimeout(end, ms);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') end(); }).catch(end);
  });
}

async function runPage(tabId, op, arg) {
  const res = await chrome.scripting.executeScript({ target: { tabId }, func: capyPage, args: [op, arg || {}] });
  return res && res[0] ? res[0].result : undefined;
}

const commands = createCommands({
  tabs: {
    get: (id) => chrome.tabs.get(id),
    query: (q) => chrome.tabs.query(q),
    create: (o) => chrome.tabs.create(o),
    update: (id, o) => chrome.tabs.update(id, o),
    remove: (id) => chrome.tabs.remove(id),
    captureVisibleTab: (w, o) => chrome.tabs.captureVisibleTab(w, o),
  },
  runPage,
  confirm,
  trust,
  getLocal: store.get,
  waitForLoad,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

// ---------- client ----------
const BADGE = {
  connected: ['ON', '#2e7d32'],
  connecting: ['...', '#f9a825'],
  offline: ['off', '#757575'],
  paused: ['||', '#757575'],
  revoked: ['x', '#c0392b'],
  key_error: ['key', '#c0392b'],
  unpaired: ['', '#757575'],
};

const client = createClient({
  store,
  keys,
  WS: WebSocket,
  fetchFn: (...a) => fetch(...a),
  handle: async (env) => {
    const reply = await commands.handle(env);
    logActivity(env, reply).catch(() => {});
    return reply;
  },
  setTimer: (f, ms) => setTimeout(f, ms),
  clearTimer: (t) => clearTimeout(t),
  setIntervalFn: (f, ms) => setInterval(f, ms),
  clearIntervalFn: (t) => clearInterval(t),
  now: () => Date.now(),
  defaultName: 'Chrome',
  onStatus: (s) => {
    const [text, color] = BADGE[s] || ['', '#757575'];
    if (pending.size === 0) {
      chrome.action.setBadgeText({ text });
      chrome.action.setBadgeBackgroundColor({ color });
    }
  },
});

// ---------- lifecycle ----------
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'keepalive') client.ensure(); });
chrome.runtime.onStartup.addListener(() => client.ensure());
chrome.runtime.onInstalled.addListener(() => client.ensure());
client.ensure();

// ---------- messages from our own pages ----------
const confirmUrl = chrome.runtime.getURL('confirm.html');
const popupUrl = chrome.runtime.getURL('popup.html');

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    const from = sender.url || '';
    if (msg.type === 'confirm_get' && from.startsWith(confirmUrl)) {
      const e = pending.get(msg.id);
      return e ? { ok: true, req: e.req, trustMinutes: TRUST_MS / 60000 } : { ok: false };
    }
    if (msg.type === 'confirm_answer' && from.startsWith(confirmUrl)) {
      const e = pending.get(msg.id);
      if (e) e.finish({ approved: !!msg.approve, trust: !!msg.trust });
      chrome.action.setBadgeText({ text: pending.size ? '!' : (BADGE[client.state().status] || [''])[0] });
      return { ok: true };
    }
    if (!from.startsWith(popupUrl)) return { ok: false, error: 'not allowed' };
    switch (msg.type) {
      case 'status': {
        const cfg = await store.get();
        return { ok: true, ...client.state(), cfg: { relay: cfg.relay, name: cfg.name, deviceId: cfg.deviceId, expires: cfg.expires, paired: !!cfg.token, paused: !!cfg.paused, localAllowed: cfg.localAllowed || [], localDenied: cfg.localDenied || [] }, trust: await trust.list() };
      }
      case 'pair':
        try { await client.pair(msg); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; }
      case 'unpair': await client.unpair(); await trust.clear(); return { ok: true };
      case 'pause': await client.setPaused(true); return { ok: true };
      case 'resume': await client.setPaused(false); return { ok: true };
      case 'set_local': {
        const clean = (l) => (Array.isArray(l) ? l : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 100);
        await store.patch({ localAllowed: clean(msg.allowed), localDenied: clean(msg.denied) });
        return { ok: true };
      }
      case 'clear_trust': await trust.clear(); return { ok: true };
      case 'activity': { const r = await chrome.storage.local.get('activity'); return { ok: true, list: r.activity || [] }; }
    }
    return { ok: false, error: 'unknown message' };
  })().then(send);
  return true;
});
