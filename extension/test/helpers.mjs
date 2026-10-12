// Fakes shared by the extension tests.
import { createCommands } from '../lib/commands.js';

export function fakeBrowser(tabsInit = []) {
  const tabs = new Map();
  let next = 1;
  const add = (url, title = 't', extra = {}) => {
    const t = { id: next++, url, title, active: false, windowId: 1, status: 'complete', ...extra };
    tabs.set(t.id, t);
    return t;
  };
  tabsInit.forEach((u) => add(u));
  const log = [];
  // page model: per tab, elements by selector
  const pages = new Map();
  const api = {
    tabs: {
      get: async (id) => { const t = tabs.get(id); if (!t) throw new Error('no tab'); return { ...t }; },
      query: async () => [...tabs.values()].map((t) => ({ ...t })),
      create: async ({ url }) => add(url),
      update: async (id, o) => { Object.assign(tabs.get(id), o); return { ...tabs.get(id) }; },
      remove: async (id) => { tabs.delete(id); },
      captureVisibleTab: async (w, o) => 'data:image/png;base64,QUJD',
    },
    runPage: async (tabId, op, arg) => {
      log.push({ op, arg });
      const page = pages.get(tabId) || { elements: {}, text: '' };
      if (op === 'text') return { url: tabs.get(tabId).url, title: 't', text: page.text };
      if (op === 'snapshot') return { url: tabs.get(tabId).url, title: 't', snapshot: [] };
      if (op === 'describe') {
        const key = arg.selector || arg.ref;
        const el = page.elements[key];
        if (!el) return { error: 'element_not_found' };
        return { ref: 'e_' + key, desc: el };
      }
      if (op === 'click') { page.clicked = (page.clicked || 0) + 1; if (page.onClick) page.onClick(tabs.get(tabId)); return { clicked: true }; }
      if (op === 'type' || op === 'set') { page.filled = { op, ...arg }; return { ok: true }; }
      return { error: 'bad_op' };
    },
    waitForLoad: async () => {},
    sleep: async () => {},
  };
  return { tabs, add, pages, log, api };
}

export function makeCommands(br, { local = {}, confirmAnswer = { approved: false }, trusted = [] } = {}) {
  const asked = [];
  const trust = {
    list: [...trusted],
    has: async (a, h) => trust.list.some((x) => x.a === a && x.h === h),
    add: async (a, h) => { trust.list.push({ a, h }); },
  };
  const cmds = createCommands({
    ...br.api,
    confirm: async (r) => { asked.push(r); return confirmAnswer; },
    trust,
    getLocal: async () => local,
  });
  return { cmds, asked, trust };
}

export const env = (cmd, args, extra = {}) => ({ id: 'i1', cmd, args, agent: 'claude-code', allowed_domains: ['example.com'], denied_hosts: [], ...extra });
