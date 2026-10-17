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
    const entry = { req, resolve, timer: null };
    const finish = (ans) => {
      if (!pending.delete(id)) return;
      clearTimeout(entry.timer);
      if (pending.size === 0) chrome.action.setBadgeText({ text: (BADGE[client.state().status] || [''])[0] });
      resolve(ans);
    };
    entry.finish = finish;
    entry.timer = setTimeout(() => finish({ approved: false, reason: 'timeout' }), CONFIRM_TIMEOUT_MS);
    pending.set(id, entry);
    // No window. On macOS chrome.windows.create comes to the front even with
    // focused:false and covers every other app.
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
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
function waitForLoad(tabId, ms = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const end = () => { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(on); clearTimeout(t); resolve(); } };
    const on = (id, info) => { if (id === tabId && info.status === 'complete') end(); };
    const t = setTimeout(end, ms);
    chrome.tabs.onUpdated.addListener(on);
    // Give a navigation time to leave "complete" before accepting the current
    // document. An already-open tab is still complete for a moment after update().
    setTimeout(() => {
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === 'complete' && !tab.pendingUrl) end();
      }).catch(end);
    }, 500);
  });
}

async function showBar(tabId, session) {
  const text = 'вкладкой управляет ' + String(session || 'агент');
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (label) => {
      const root = document.documentElement || document.body;
      if (!document.getElementById('capy-agent-style')) {
        const style = document.createElement('style');
        style.id = 'capy-agent-style';
        const svg = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M5 3.2 18.2 11l-5.4 1.3L10.2 19z" fill="#1d5f58" stroke="#f7f9f3" stroke-width="1.2"/></svg>');
        style.textContent = [
          '@keyframes capy-agent-glow{0%,100%{opacity:.72}50%{opacity:1}}',
          '@keyframes capy-agent-click{0%{transform:scale(.45);opacity:1}100%{transform:scale(1.6);opacity:0}}',
          '@media (prefers-reduced-motion: reduce){#capy-agent-frame{animation:none}}',
          '#capy-agent-bar{cursor:url("data:image/svg+xml,' + svg + '") 4 2, auto}',
        ].join('');
        (document.head || root).appendChild(style);
      }
      let frame = document.getElementById('capy-agent-frame');
      if (!frame) {
        frame = document.createElement('div');
        frame.id = 'capy-agent-frame';
        frame.style.cssText = 'position:fixed;inset:0;border:3px solid #1d5f58;box-shadow:inset 0 0 14px rgba(29,95,88,.45);box-sizing:border-box;z-index:2147483645;pointer-events:none;margin:0;animation:capy-agent-glow 2s ease-in-out infinite';
        root.appendChild(frame);
      }
      let bar = document.getElementById('capy-agent-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'capy-agent-bar';
        bar.setAttribute('role', 'status');
        bar.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483646;display:flex;align-items:center;gap:8px;margin:0;padding:7px 12px;background:#1d5f58;color:#f7f9f3;border-radius:999px;font:13px/1.2 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.18);pointer-events:none';
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('width', '14');
        icon.setAttribute('height', '14');
        icon.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M5 3.2 18.2 11l-5.4 1.3L10.2 19z');
        path.setAttribute('fill', '#f7f9f3');
        icon.appendChild(path);
        const span = document.createElement('span');
        span.id = 'capy-agent-bar-text';
        bar.append(icon, span);
        root.appendChild(bar);
      }
      const span = document.getElementById('capy-agent-bar-text');
      if (span) span.textContent = label;
    },
    args: [text],
  });
}

async function runPage(tabId, op, arg) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: capyPage,
    args: [op, arg || {}],
  });
  return res && res[0] ? res[0].result : undefined;
}

const commands = createCommands({
  tabs: {
    get: (id) => chrome.tabs.get(id),
    query: (q) => chrome.tabs.query(q),
    create: (o) => chrome.tabs.create({ ...o, active: false }),
    update: (id, o) => {
      const next = { ...(o || {}) };
      delete next.active;
      if (!Object.keys(next).length) return chrome.tabs.get(id);
      return chrome.tabs.update(id, next);
    },
    remove: (id) => chrome.tabs.remove(id),
    group: (o) => chrome.tabs.group(o),
    captureVisibleTab: (w, o) => chrome.tabs.captureVisibleTab(w, o),
  },
  windows: {
    getAll: (q) => chrome.windows.getAll(q),
  },
  tabGroups: {
    query: (q) => chrome.tabGroups.query(q),
    update: (id, o) => chrome.tabGroups.update(id, o),
    get: (id) => chrome.tabGroups.get(id),
  },
  fetchFn: (...args) => fetch(...args),
  showBar,
  runPage,
  confirm,
  trust,
  getLocal: store.get,
  loadLeases: async () => (await chrome.storage.local.get('tabLeases')).tabLeases || {},
  saveLeases: (leases) => chrome.storage.local.set({ tabLeases: leases }),
  waitForLoad,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});
chrome.tabs.onRemoved.addListener((id) => { commands.forget(id); });

// Child tab adoption: links clicked with target="_blank" in an agent's tab
// automatically join the same session group, stay inactive, and are muted.
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId) {
    try {
      const leases = (await chrome.storage.local.get('tabLeases')).tabLeases || {};
      const parentKey = leases[String(tab.openerTabId)] || leases[tab.openerTabId];
      if (parentKey) {
        leases[String(tab.id)] = parentKey;
        await chrome.storage.local.set({ tabLeases: leases });
        await chrome.tabs.update(tab.id, { active: false, muted: true }).catch(() => {});
        const parentTab = await chrome.tabs.get(tab.openerTabId).catch(() => null);
        if (parentTab && parentTab.groupId && parentTab.groupId > 0) {
          await chrome.tabs.group({ tabIds: [tab.id], groupId: parentTab.groupId }).catch(() => {});
        }
      }
    } catch { /* ignore */ }
  }
});

// Sound isolation: if an agent tab starts playing audio dynamically, mute it.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.audible) {
    try {
      const leases = (await chrome.storage.local.get('tabLeases')).tabLeases || {};
      if (leases[String(tabId)] || leases[tabId]) {
        await chrome.tabs.update(tabId, { muted: true }).catch(() => {});
      }
    } catch { /* ignore */ }
  }
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
function closeReloadTab() {
  const prefix = chrome.runtime.getURL('popup.html');
  chrome.tabs.query({}).then((list) => {
    for (const t of list) {
      if (t.url && t.url.startsWith(prefix) && t.url.includes('reload=1') && !t.active) {
        chrome.tabs.remove(t.id).catch(() => {});
      }
    }
  }).catch(() => {});
}

// One-shot install hook. A local file on 127.0.0.1 is served only while
// this machine is being paired. Nothing is logged. If the port is closed,
// the browser stays unpaired until someone enters a code.
let bootstrapOnce = null;
function bootstrapPair() {
  if (bootstrapOnce) return bootstrapOnce;
  bootstrapOnce = (async () => {
    const cfg = await store.get();
    if (cfg.token) return;
    const until = Date.now() + 90000;
    let last = 'wait';
    while (Date.now() < until) {
      const cur = await store.get();
      if (cur.token) return;
      try {
        const resp = await fetch('http://127.0.0.1:18793/capy-bootstrap.json', { cache: 'no-store' });
        if (resp.ok) {
          const body = await resp.json().catch(() => null);
          if (body && body.code && body.relay) {
            try {
              await client.pair({ relay: body.relay, code: String(body.code), name: body.name || 'Kotik' });
              last = 'paired';
            } catch (e) {
              last = 'pair_fail';
            }
            try { await chrome.storage.local.set({ bootNote: last }); } catch { /* ignore */ }
            return;
          }
          last = 'bad_json';
        } else {
          last = 'http_' + resp.status;
        }
      } catch {
        last = 'fetch_fail';
      }
      try { await chrome.storage.local.set({ bootNote: last }); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return bootstrapOnce;
}

chrome.runtime.onStartup.addListener(() => { bootstrapPair().finally(() => client.ensure()); });
chrome.runtime.onInstalled.addListener(() => { bootstrapPair().finally(() => client.ensure()); closeReloadTab(); });
chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
bootstrapPair().finally(() => client.ensure());

// ---------- messages from our own pages ----------
const confirmUrl = chrome.runtime.getURL('confirm.html');
const popupUrl = chrome.runtime.getURL('popup.html');
const panelUrl = chrome.runtime.getURL('panel.html');

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
    if (!from.startsWith(popupUrl) && !from.startsWith(panelUrl)) return { ok: false, error: 'not allowed' };
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
