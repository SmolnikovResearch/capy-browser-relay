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

export const COMMANDS = ['tabs_list', 'tabs_open', 'navigate', 'read_page', 'click', 'type', 'form_input', 'screenshot'];

export function createCommands(deps) {
  const { tabs, runPage, confirm, trust, getLocal, waitForLoad, sleep } = deps;

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
      const all = await tabs.query({});
      return {
        tabs: all
          .filter((t) => isAllowed(urlOf(t), p))
          .map((t) => ({ id: t.id, url: urlOf(t), title: t.title || '', active: !!t.active, window_id: t.windowId })),
      };
    },

    async tabs_open(env, a, p) {
      const url = String(a.url || '');
      if (!isAllowed(url, p)) throw new CmdErr('domain_denied', 'extension: domain not allowed');
      const t = await tabs.create({ url, active: false });
      await waitForLoad(t.id);
      const after = await getTab(t.id);
      if (!isAllowed(urlOf(after), p)) {
        await tabs.remove(t.id).catch(() => {});
        throw new CmdErr('domain_denied', 'the page redirected outside the allowed domains and was closed');
      }
      return { tab_id: t.id, url: urlOf(after), title: after.title || '' };
    },

    async navigate(env, a, p) {
      const url = String(a.url || '');
      const t = await getTab(a.tab_id);
      const cur = urlOf(t);
      if (parseHttpUrl(cur) && isDenied(cur, p.denied, p.localDenied)) throw new CmdErr('domain_denied', 'extension: this page cannot be driven');
      if (!isAllowed(url, p)) throw new CmdErr('domain_denied', 'extension: domain not allowed');
      await tabs.update(t.id, { url });
      await waitForLoad(t.id);
      const after = await recheck(t.id, p);
      return { tab_id: t.id, url: urlOf(after), title: after.title || '' };
    },

    async read_page(env, a, p) {
      await allowedTab(a.tab_id, p);
      const r = await inPage(a.tab_id, a.mode === 'snapshot' ? 'snapshot' : 'text');
      const t = await recheck(a.tab_id, p);
      return { ...r, url: urlOf(t) };
    },

    async screenshot(env, a, p) {
      const t = await allowedTab(a.tab_id, p);
      if (!t.active) {
        await tabs.update(t.id, { active: true });
        await sleep(200);
      }
      let mime = 'image/png';
      let data = String(await tabs.captureVisibleTab(t.windowId, { format: 'png' }));
      if (data.length > 5_500_000) { // the relay takes 8 MB per message
        mime = 'image/jpeg';
        data = String(await tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 70 }));
      }
      const after = await recheck(t.id, p);
      return { url: urlOf(after), mime_type: mime, data: data.replace(/^data:image\/(png|jpeg);base64,/, '') };
    },

    async click(env, a, p) {
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

    async form_input(env, a, p) {
      if (a.value === undefined || a.value === null) throw new CmdErr('bad_args', 'value is required');
      return fill(env, a, p, 'set', { value: typeof a.value === 'string' ? a.value : String(a.value) });
    },
  };

  async function fill(env, a, p, op, payload) {
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

  return { handle };
}
