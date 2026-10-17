// Runs inside the page (chrome.scripting.executeScript, isolated world). The
// function must stay self-contained: it is serialised and shipped to the tab.
// One entry point, several ops. Element references ("e1"...) are kept in a
// WeakRef map in the isolated world, so they survive between calls and never
// touch the page's own scripts or DOM.
export function capyPage(op, a) {
  const S = globalThis.__capyRefs || (globalThis.__capyRefs = { map: new Map(), n: 0 });
  const MAX_TEXT = 200000;

  function refOf(el) {
    for (const [k, w] of S.map) {
      const v = w.deref();
      if (v === el) return k;
      if (!v) S.map.delete(k);
    }
    const k = 'e' + ++S.n;
    S.map.set(k, new WeakRef(el));
    return k;
  }
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function labelText(el) {
    try {
      if (el.labels && el.labels.length) return el.labels[0].innerText.trim().slice(0, 100);
    } catch (e) { /* ignore */ }
    return '';
  }
  function nameOf(el) {
    const al = el.getAttribute('aria-label');
    if (al) return al.trim().slice(0, 100);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ').trim();
      if (t) return t.slice(0, 100);
    }
    const l = labelText(el);
    if (l) return l;
    const own = (el.innerText || '').trim();
    if (own) return own.replace(/\s+/g, ' ').slice(0, 100);
    return (el.placeholder || el.title || el.alt || (el.type === 'submit' || el.type === 'button' ? el.value : '') || '').trim().slice(0, 100);
  }
  function roleOf(el) {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = (el.type || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'submit' || ty === 'button' || ty === 'image' || ty === 'reset') return 'button';
      return 'textbox';
    }
    return t;
  }
  function uploadDialog() {
    return document.querySelector('ytcp-uploads-dialog')
      || document.querySelector('ytcp-uploads-still-dialog')
      || document.querySelector('ytcp-uploads-video-info-dialog');
  }
  function shortName(el) {
    if (!el || !el.getAttribute) return '';
    const aria = el.getAttribute('aria-label') || '';
    if (aria) return aria.replace(/\s+/g, ' ').trim().slice(0, 80);
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 80);
  }
  function collectText(root) {
    const start = performance.now();
    const chunks = [];
    let size = 0;
    let nodes = 0;
    function push(s) {
      s = String(s || '').replace(/\s+/g, ' ').trim();
      if (!s || size >= 6000) return;
      const bit = s.slice(0, 140);
      chunks.push(bit);
      size += bit.length + 1;
    }
    function walk(node) {
      if (!node || nodes > 1200 || size >= 6000 || performance.now() - start > 700) return;
      if (node.nodeType === 3) { push(node.nodeValue); return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      const name = node.localName || '';
      if (name === 'script' || name === 'style' || name === 'svg' || name === 'noscript') return;
      nodes++;
      if (name === 'button' || name === 'ytcp-button' || (node.getAttribute && node.getAttribute('role') === 'button')) {
        push(shortName(node));
      }
      if (node.shadowRoot) walk(node.shadowRoot);
      const kids = node.childNodes;
      if (!kids) return;
      for (let i = 0; i < kids.length && nodes <= 1200 && size < 6000; i++) walk(kids[i]);
    }
    walk(root);
    return chunks.join('\n');
  }
  function queryDeep(root, selector) {
    const start = performance.now();
    let seen = 0;
    function walk(node) {
      if (!node || seen > 1500 || performance.now() - start > 700) return null;
      if (node.nodeType === 1) {
        seen++;
        try { if (node.matches && node.matches(selector)) return node; } catch (e) { return null; }
        if (node.shadowRoot) {
          const inner = walk(node.shadowRoot);
          if (inner) return inner;
        }
      }
      const list = node.children;
      if (!list) return null;
      for (let i = 0; i < list.length; i++) {
        const inner = walk(list[i]);
        if (inner) return inner;
      }
      return null;
    }
    const dialog = uploadDialog();
    const hit = walk(dialog || root);
    if (hit || !dialog) return hit;
    return walk(root);
  }
  function videoFileInput(root) {
    const found = [];
    function walk(node) {
      if (!node || !node.querySelectorAll) return;
      for (const el of node.querySelectorAll('input[type=file]')) found.push(el);
      for (const el of node.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
    }
    walk(root || document);
    const video = found.find((el) => {
      const acc = (el.getAttribute('accept') || '').toLowerCase();
      return !acc || acc.includes('video') || acc.includes('mp4') || acc.includes('*');
    });
    return video || found[0] || null;
  }
  function find(target) {
    if (!target) return { error: 'bad_args' };
    if (target.ref) {
      const w = S.map.get(target.ref);
      const el = w && w.deref();
      if (!el || !el.isConnected) return { error: 'stale_ref' };
      return { el };
    }
    if (target.selector) {
      try {
        const el = queryDeep(document, target.selector);
        return el ? { el } : { error: 'element_not_found' };
      } catch (e) {
        return { error: 'bad_selector' };
      }
    }
    return { error: 'bad_args' };
  }
  function describe(el) {
    const clickable = el.closest('button,a,input,[role=button],summary') || el;
    const form = clickable.form || el.form || clickable.closest('form');
    const tag = clickable.tagName.toLowerCase();
    const type = (el.type || '').toLowerCase();
    const cType = (clickable.type || '').toLowerCase();
    const isSubmit = !!form && ((tag === 'button' && cType !== 'button' && cType !== 'reset') ||
      (tag === 'input' && (cType === 'submit' || cType === 'image')));
    const method = (clickable.formMethod || (form && form.method) || 'get').toLowerCase();
    return {
      tag: el.tagName.toLowerCase(),
      type: type === 'file' || cType === 'file' ? 'file' : type,
      text: (clickable.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200),
      value: type === 'password' ? '' : String(clickable.value || '').slice(0, 100),
      ariaLabel: el.getAttribute('aria-label') || clickable.getAttribute('aria-label') || '',
      title: clickable.title || '',
      placeholder: el.placeholder || '',
      name: el.name || '',
      id: el.id || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      label: labelText(el),
      href: tag === 'a' ? clickable.href : '',
      download: tag === 'a' && clickable.hasAttribute('download'),
      isSubmit,
      formMethod: method,
      formHasPassword: !!(form && type !== 'password' && form.querySelector('input[type=password]')),
    };
  }
  function nativeSet(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  switch (op) {
    case 'text': {
      const dialog = uploadDialog();
      const bar = document.getElementById('capy-agent-bar-text');
      const plaque = bar ? String(bar.textContent || '').replace(/\s+/g, ' ').trim() : '';
      let diag = '';
      if (dialog) {
        const radios = Array.from(dialog.querySelectorAll('tp-yt-paper-radio-button, [role=radio], input[type=radio]')).map(r => (r.name || r.id || (r.innerText||'').trim().slice(0, 30)) + '=' + (r.checked || r.getAttribute('checked') || r.getAttribute('aria-checked')));
        const done = dialog.querySelector('#done-button') || dialog.querySelector('[id*=done]') || dialog.querySelector('[id*=publish]');
        const doneState = done ? ('done-btn: tag=' + done.tagName + ' disabled=' + done.hasAttribute('disabled') + ' aria-disabled=' + done.getAttribute('aria-disabled') + ' text=' + done.innerText.trim()) : 'no-done-btn';
        const errs = Array.from(dialog.querySelectorAll('[error], .error, [aria-invalid=true], ytcp-error, [has-error], .error-short, .error-message, ytcp-badge[type=ERROR]')).map(e => (e.className || e.tagName) + ': ' + e.innerText.trim());
        diag = '\n--- DIAG ---\nradios: ' + radios.join(', ') + '\n' + doneState + '\nerrors: ' + errs.join(' | ');
      }
      const text = dialog
        ? (collectText(dialog) + diag)
        : [document.title || '', plaque].filter(Boolean).join('\n');
      return { url: location.href, title: document.title, text: text, truncated: false };
    }
    case 'snapshot': {
      const root = uploadDialog() || document.body || document.documentElement;
      const out = [];
      const start = performance.now();
      let seen = 0;
      function consider(el) {
        if (out.length >= 80 || seen > 2000 || performance.now() - start > 1500) return;
        seen++;
        const tag = el.localName || '';
        const role = el.getAttribute && el.getAttribute('role');
        const interesting = tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'ytcp-button' || role === 'button' || role === 'textbox' || role === 'menuitem' || role === 'tab';
        if (!interesting) return;
        const it = { ref: refOf(el), role: roleOf(el), name: shortName(el) };
        const ty = (el.type || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') {
          it.type = ty || tag;
          if (ty === 'password') it.secret = true;
        }
        out.push(it);
      }
      function walk(node) {
        if (!node || out.length >= 80 || performance.now() - start > 1500) return;
        if (node.nodeType === 1) {
          consider(node);
          if (node.shadowRoot) walk(node.shadowRoot);
          const kids = node.children;
          if (!kids) return;
          for (let i = 0; i < kids.length; i++) walk(kids[i]);
        } else if (node.nodeType === 11) {
          const kids = node.children;
          if (!kids) return;
          for (let i = 0; i < kids.length; i++) walk(kids[i]);
        }
      }
      walk(root);
      return { url: location.href, title: document.title, snapshot: out };
    }
    case 'describe': {
      const f = find(a);
      if (f.error) return { error: f.error };
      return { ref: refOf(f.el), desc: describe(f.el) };
    }
    case 'click': {
      const f = find(a);
      if (f.error) return { error: f.error };
      const box = f.el.getBoundingClientRect();
      const ring = document.createElement('div');
      ring.style.cssText = 'position:fixed;left:' + (box.left + box.width / 2 - 14) + 'px;top:' + (box.top + box.height / 2 - 14) + 'px;width:28px;height:28px;border:3px solid #1d5f58;border-radius:50%;pointer-events:none;z-index:2147483644;animation:capy-agent-click .45s ease-out forwards';
      (document.documentElement || document.body).appendChild(ring);
      setTimeout(() => ring.remove(), 500);
      f.el.click();
      return { clicked: true, x: box.left + box.width / 2, y: box.top + box.height / 2, w: box.width, h: box.height };
    }
    case 'type': {
      const f = find(a);
      if (f.error) return { error: f.error };
      const el = f.el;
      if (typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* not a text field */ }
      }
      if (!document.execCommand('insertText', false, a.text)) {
        if (el.isContentEditable) el.textContent += a.text;
        else nativeSet(el, (el.value || '') + a.text);
      }
      return { typed: true };
    }
    case 'set': {
      const f = find(a);
      if (f.error) return { error: f.error };
      const el = f.el;
      const v = a.value;
      if (el instanceof HTMLSelectElement) {
        const o = Array.from(el.options).find((x) => x.value === v || x.text.trim() === v);
        if (!o) return { error: 'option_not_found' };
        nativeSet(el, o.value);
      } else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        const want = !/^(false|0|off|no|)$/i.test(String(v));
        if (el.checked !== want) el.click();
      } else if (el.isContentEditable) {
        el.textContent = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el instanceof HTMLInputElement && el.type === 'file') {
        return { error: 'unsupported' };
      } else {
        nativeSet(el, String(v));
      }
      return { set: true };
    }
    case 'file_begin': {
      S.file = { name: String(a.name || 'video.mp4'), type: String(a.type || 'video/mp4'), parts: [] };
      return { ok: true };
    }
    case 'file_chunk': {
      if (!S.file) return { error: 'no_file' };
      S.file.parts.push(String(a.b64 || ''));
      return { ok: true };
    }
    case 'file_commit': {
      if (!S.file) return { error: 'no_file' };
      let el = null;
      const f = find(a);
      if (!f.error) el = f.el;
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') el = videoFileInput(document);
      if (!(el instanceof HTMLInputElement) || el.type !== 'file') return { error: 'no_file_input' };
      let total = 0;
      const parts = [];
      for (const part of S.file.parts) {
        const raw = atob(part);
        const u = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i) & 255;
        parts.push(u);
        total += u.length;
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const u of parts) {
        bytes.set(u, offset);
        offset += u.length;
      }
      const file = new File([bytes], S.file.name, { type: S.file.type });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      if (!el.files || !el.files.length) return { error: 'file_not_accepted' };
      const name = S.file.name;
      const size = el.files[0].size;
      S.file = null;
      return { attached: name, bytes: size };
    }
  }
  return { error: 'bad_op' };
}
