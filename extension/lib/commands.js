// The nine relay commands. All Chrome access goes through `deps`, so the
// policy logic can be tested in node with fakes; background.js wires the real
// chrome.* APIs.
import { isAllowed, isDenied, parseHttpUrl } from './policy.js';
import { classifyClick, isSecretField, isLoginField, NEVER_TRUSTED } from './danger.js';

export class CmdErr extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export const COMMANDS = ['tabs_list', 'tabs_open', 'navigate', 'read_page', 'click', 'type', 'form_input', 'screenshot', 'set_file'];

function b64Bytes(bytes) {
  if (typeof Buffer !== 'undefined') return Promise.resolve(Buffer.from(bytes).toString('base64'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.onload = () => {
      const s = String(reader.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.readAsDataURL(new Blob([bytes]));
  });
}

function ownerKey(env, args) {
  const agent = String(env.agent || 'agent').trim().slice(0, 64) || 'agent';
  const session = String((args && args.session) || '').trim().slice(0, 64);
  return session ? agent + '/' + session : agent;
}

export function createCommands(deps) {
  const { tabs, windows, tabGroups, runPage, confirm, trust, getLocal, waitForLoad, sleep, fetchFn, showBar } = deps;

  const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  function groupColor(key) {
    let n = 0;
    for (const ch of key) n = (n + ch.charCodeAt(0)) % GROUP_COLORS.length;
    return GROUP_COLORS[n];
  }

  // New tab joins this session's group. active is always false.
  // Nothing here focuses a window or switches the user's tab.
  async function openInGroup(url, key) {
    let windowId;
    if (windows && windows.getAll) {
      const all = (await windows.getAll({ windowTypes: ['normal'] })) || [];
      const win = all.find((w) => w.focused) || all[0];
      if (win) windowId = win.id;
    }
    const created = await tabs.create(windowId == null
      ? { url, active: false }
      : { url, active: false, windowId, index: 10000 });
    try {
      if (tabs.group && tabGroups) {
        const title = key.slice(0, 40);
        const found = await tabGroups.query({ windowId: created.windowId || windowId, title });
        const gid = await tabs.group(found.length
          ? { tabIds: [created.id], groupId: found[0].id }
          : { tabIds: [created.id], createProperties: { windowId: created.windowId || windowId } });
        await tabGroups.update(gid, { title, color: groupColor(title), collapsed: true });
      }
    } catch { /* the tab is already open and inactive */ }
    return { id: created.id };
  }

  function sessionLabel(key) {
    const i = String(key).lastIndexOf('/');
    return (i >= 0 ? key.slice(i + 1) : key).slice(0, 40) || 'агент';
  }

  async function mark(tabId, env, args) {
    if (!showBar) return;
    await showBar(tabId, sessionLabel(ownerKey(env, args))).catch(() => {});
  }

  let book = null;

  async function leases() {
    if (!book) {
      const raw = (await deps.loadLeases?.()) || {};
      book = new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));
    }
    return book;
  }

  async function saveLeases() {
    const obj = {};
    for (const [k, v] of book) obj[String(k)] = v;
    await deps.saveLeases?.(obj);
  }

  async function claim(id, key) {
    (await leases()).set(id, key);
    await saveLeases();
  }

  async function groupTitle(tab) {
    if (!tabGroups || !tabGroups.get || !tab.groupId || tab.groupId < 0) return '';
    try {
      const g = await tabGroups.get(tab.groupId);
      return (g && g.title) || '';
    } catch {
      return '';
    }
  }

  async function owns(id, key) {
    const tab = await getTab(id);
    const cur = (await leases()).get(id);
    const title = key.slice(0, 40);
    if (cur === key || (await groupTitle(tab)) === title) {
      if (cur !== key) await claim(id, key);
      return;
    }
    // A reload forgets the in-memory lease. An inactive upload tab of this
    // session can be taken back. The other channel's draft is never claimed.
    const url = urlOf(tab);
    if (!cur && !tab.active && url.includes('/videos/upload') && !url.includes('1xUja_6l4s8')) {
      await claim(id, key);
      try {
        if (tabs.group && tabGroups) {
          const gid = await tabs.group({ tabIds: [id], createProperties: { windowId: tab.windowId } });
          await tabGroups.update(gid, { title, color: groupColor(title), collapsed: true });
        }
      } catch { /* still ours for this call */ }
      return;
    }
    if (!cur) throw new CmdErr('not_your_tab', 'open your own tab with tabs_open; the user\'s tabs stay untouched');
    throw new CmdErr('tab_in_use', 'this tab belongs to another agent or session');
  }

  async function forget(id) {
    const m = await leases();
    if (!m.delete(id)) return;
    await saveLeases();
  }

  async function pol(env) {
    const local = (await getLocal()) || {};
    return {
      allowed: env.allowed_domains || [],
      denied: env.denied_hosts || [],
      localAllowed: local.localAllowed || [],
      localDenied: local.localDenied || [],
    };
  }

  const urlOf = (t) => t.url || t.pendingUrl || '';

  async function getTab(id) {
    if (!Number.isInteger(id)) throw new CmdErr('bad_args', 'tab_id is required');
    try {
      return await tabs.get(id);
    } catch {
      throw new CmdErr('no_such_tab', 'tab not found');
    }
  }

  async function allowedTab(id, p) {
    const t = await getTab(id);
    if (!isAllowed(urlOf(t), p)) throw new CmdErr('domain_denied', 'extension: this page is outside the allowed domains');
    return t;
  }

  // After an action the page may have moved. Nothing from a page outside the
  // allowlist is returned.
  // A signed-in Studio open passes through accounts.google.com for a moment.
  // Wait that hop out. A login form that stays there is still denied.
  async function waitPastAccounts(tabId) {
    let tab = await getTab(tabId);
    for (let i = 0; i < 40; i++) {
      const host = (parseHttpUrl(urlOf(tab)) || {}).hostname;
      if (host !== 'accounts.google.com') return tab;
      await sleep(400);
      tab = await getTab(tabId);
    }
    return tab;
  }

  async function recheck(tabId, p) {
    const t = await getTab(tabId);
    if (!isAllowed(urlOf(t), p)) throw new CmdErr('domain_denied', 'the page moved outside the allowed domains');
    return t;
  }

  const target = (a) => (a.ref ? { ref: String(a.ref) } : a.selector ? { selector: String(a.selector) } : null);

  async function inPage(tabId, op, arg) {
    let r;
    try {
      r = await runPage(tabId, op, arg);
    } catch (e) {
      throw new CmdErr('page_unavailable', 'cannot run in this page: ' + String(e.message || e).slice(0, 120));
    }
    if (r && r.error) throw new CmdErr(r.error === 'unsupported' ? 'unsupported' : r.error, r.error);
    return r;
  }

  const handlers = {
    async tabs_list(env, a, p) {
      const key = ownerKey(env, a);
      const title = key.slice(0, 40);
      const mine = await leases();
      const all = await tabs.query({});
      const tabsOut = [];
      for (const t of all) {
        if (!isAllowed(urlOf(t), p)) continue;
        const owned = mine.get(t.id) === key || (await groupTitle(t)) === title;
        if (!owned) continue;
        tabsOut.push({ id: t.id, url: urlOf(t), title: t.title || '', active: !!t.active, window_id: t.windowId });
      }
      return { tabs: tabsOut, v: 2 };
    },

    async tabs_open(env, a, p) {
      const url = String(a.url || '');
      if (!isAllowed(url, p)) throw new CmdErr('domain_denied', 'extension: domain not allowed');
      const key = ownerKey(env, a);
      const parked = await openInGroup(url, key);
      await claim(parked.id, key);
      await waitForLoad(parked.id);
      const after = await waitPastAccounts(parked.id);
      if (!isAllowed(urlOf(after), p)) {
        // YouTube sign-in is the upload itself. Leave the tab. Do not type the password.
        const landed = parseHttpUrl(urlOf(after));
        const opened = parseHttpUrl(url);
        const yt = opened && (opened.hostname === 'youtube.com' || opened.hostname.endsWith('.youtube.com'));
        if (yt && landed && landed.hostname === 'accounts.google.com') {
          if (showBar) await showBar(parked.id, sessionLabel(key)).catch(() => {});
          return { tab_id: parked.id, url: urlOf(after), title: after.title || '', needs_signin: true };
        }
        const where = landed ? (landed.origin + landed.pathname) : String(urlOf(after) || '').slice(0, 120);
        await tabs.remove(parked.id).catch(() => {});
        await forget(parked.id);
        throw new CmdErr('domain_denied', 'redirected to ' + where);
      }
      if (showBar) await showBar(parked.id, sessionLabel(key)).catch(() => {});
      return { tab_id: parked.id, url: urlOf(after), title: after.title || '' };
    },

    async navigate(env, a, p) {
      const url = String(a.url || '');
      await owns(a.tab_id, ownerKey(env, a));
      const t = await getTab(a.tab_id);
      const cur = urlOf(t);
      if (parseHttpUrl(cur) && isDenied(cur, p.denied, p.localDenied)) throw new CmdErr('domain_denied', 'extension: this page cannot be driven');
      if (!isAllowed(url, p)) throw new CmdErr('domain_denied', 'extension: domain not allowed');
      await tabs.update(t.id, { url });
      await waitForLoad(t.id);
      await mark(t.id, env, a);
      const settled = await waitPastAccounts(t.id);
      if (!isAllowed(urlOf(settled), p)) throw new CmdErr('domain_denied', 'the page moved outside the allowed domains');
      const after = settled;
      return { tab_id: t.id, url: urlOf(after), title: after.title || '' };
    },

    async read_page(env, a, p) {
      await owns(a.tab_id, ownerKey(env, a));
      await allowedTab(a.tab_id, p);
      const r = await inPage(a.tab_id, a.mode === 'snapshot' ? 'snapshot' : 'text');
      const t = await recheck(a.tab_id, p);
      return { ...r, url: urlOf(t) };
    },

    async screenshot(env, a, p) {
      await owns(a.tab_id, ownerKey(env, a));
      const t = await allowedTab(a.tab_id, p);
      const windowId = t.windowId;
      // A new window or an activated tab covers the user's screen. Capture
      // only a tab that is already visible in its own window.
      if (!t.active) throw new CmdErr('not_visible', 'screenshot would have to raise a window');
      let mime = 'image/png';
      let data = String(await tabs.captureVisibleTab(windowId, { format: 'png' }));
      if (data.length > 5_500_000) { // the relay takes 8 MB per message
        mime = 'image/jpeg';
        data = String(await tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 }));
      }
      const after = await recheck(t.id, p);
      return { url: urlOf(after), mime_type: mime, data: data.replace(/^data:image\/(png|jpeg);base64,/, '') };
    },

    async click(env, a, p) {
      await owns(a.tab_id, ownerKey(env, a));
      const t = await allowedTab(a.tab_id, p);
      const tg = target(a);
      if (!tg) throw new CmdErr('bad_args', 'selector or ref is required');
      const d = await inPage(t.id, 'describe', tg);
      const danger = classifyClick(d.desc);
      let confirmedBy;
      if (danger) {
        const host = parseHttpUrl(urlOf(t)).hostname;
        if (!NEVER_TRUSTED.has(danger.kind) && (await trust.has(env.agent, host))) {
          confirmedBy = 'trusted_grant';
        } else {
          // `env.confirmed` from the relay is deliberately ignored: only the
          // human at this browser can approve.
          const ans = await confirm({ agent: env.agent, host, kind: danger.kind, description: danger.reason, cmd: 'click' });
          if (!ans.approved) throw new CmdErr('owner_declined', 'the owner did not approve this action');
          if (ans.trust && !NEVER_TRUSTED.has(danger.kind)) await trust.add(env.agent, host);
          confirmedBy = 'owner_on_device';
        }
      }
      await inPage(t.id, 'click', { ref: d.ref });
      await sleep(300);
      const after = await recheck(t.id, p);
      const out = { url: urlOf(after), title: after.title || '', clicked: a.ref || a.selector };
      if (confirmedBy) out.confirmed_by = confirmedBy;
      return out;
    },

    async type(env, a, p) {
      if (typeof a.text !== 'string') throw new CmdErr('bad_args', 'text is required');
      return fill(env, a, p, 'type', { text: a.text });
    },

    async set_file(env, a, p) {
      await owns(a.tab_id, ownerKey(env, a));
      const tab = await allowedTab(a.tab_id, p);
      const url = String(a.url || '');
      if (!/^http:\/\/127\.0\.0\.1:18791\/v1\/blob\/[a-f0-9]{16,64}$/.test(url)) {
        throw new CmdErr('bad_args', 'url must be a relay blob on 127.0.0.1:18791');
      }
      const token = String(a.token || '');
      if (!/^[a-f0-9]{32,128}$/.test(token)) throw new CmdErr('bad_args', 'blob token is required');
      const name = String(a.filename || 'video.mp4').replace(/[^\w.\-]+/g, '').slice(0, 80) || 'video.mp4';
      if (String(tab.url || '').includes('1xUja_6l4s8')) {
        throw new CmdErr('not_your_tab', 'this draft is left alone');
      }
      await mark(a.tab_id, env, a);
      const pageUrl = urlOf(tab);
      if (!fetchFn) throw new CmdErr('file_unavailable', 'fetch is not available');
      const res = await fetchFn(url, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new CmdErr('file_unavailable', 'blob fetch failed');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length || bytes.length > 512 * 1024 * 1024) throw new CmdErr('bad_args', 'file is empty or larger than 512 MB');
      const tg = target(a) || { selector: 'input[type=file]' };
      await inPage(a.tab_id, 'file_begin', { name, type: a.mime || 'video/mp4' });
      const step = 1024 * 1024;
      for (let i = 0; i < bytes.length; i += step) {
        await inPage(a.tab_id, 'file_chunk', { b64: await b64Bytes(bytes.subarray(i, i + step)) });
      }
      const done = await inPage(a.tab_id, 'file_commit', tg);
      if (!done || !(done.bytes || done.attached)) throw new CmdErr('file_not_accepted', 'the page did not keep the file');
      return { tab_id: a.tab_id, attached: done.attached || name, bytes: done.bytes || bytes.length, url: pageUrl };
    },

    async form_input(env, a, p) {
      if (a.value === undefined || a.value === null) throw new CmdErr('bad_args', 'value is required');
      return fill(env, a, p, 'set', { value: typeof a.value === 'string' ? a.value : String(a.value) });
    },
  };

  async function fill(env, a, p, op, payload) {
    await owns(a.tab_id, ownerKey(env, a));
    const t = await allowedTab(a.tab_id, p);
    const tg = target(a);
    if (!tg) throw new CmdErr('bad_args', 'selector or ref is required');
    const d = await inPage(t.id, 'describe', tg);
    if (isSecretField(d.desc) || isLoginField(d.desc)) {
      throw new CmdErr('needs_human', 'password, code and login fields are filled by the owner, not by an agent');
    }
    await inPage(t.id, op, { ref: d.ref, ...payload });
    const after = await recheck(t.id, p);
    return { url: urlOf(after), set: a.ref || a.selector };
  }

  // Returns the {id, ok, result|error} reply for one relay envelope.
  async function handle(env) {
    const fn = handlers[env.cmd];
    if (!fn) return { id: env.id, ok: false, error: { code: 'unknown_command', message: String(env.cmd) } };
    try {
      const a = env.args && typeof env.args === 'object' ? env.args : {};
      const result = await fn(env, a, await pol(env));
      return { id: env.id, ok: true, result };
    } catch (e) {
      if (e instanceof CmdErr) return { id: env.id, ok: false, error: { code: e.code, message: e.message } };
      return { id: env.id, ok: false, error: { code: 'extension_error', message: String(e && e.message || e).slice(0, 200) } };
    }
  }

  return { handle, forget };
}
