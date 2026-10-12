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
        const el = document.querySelector(target.selector);
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
      const t = (document.body ? document.body.innerText : '') || '';
      return { url: location.href, title: document.title, text: t.slice(0, MAX_TEXT), truncated: t.length > MAX_TEXT };
    }
    case 'snapshot': {
      const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=menuitem],[role=tab],[role=textbox],[onclick],[contenteditable=""],[contenteditable=true]';
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        if (out.length >= 300) break;
        if (!visible(el)) continue;
        const it = { ref: refOf(el), role: roleOf(el), name: nameOf(el) };
        const ty = (el.type || '').toLowerCase();
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
          it.type = ty || el.tagName.toLowerCase();
          if (ty === 'password') it.secret = true;
          else if (ty === 'checkbox' || ty === 'radio') it.checked = el.checked;
          else if (el.value) it.value = String(el.value).slice(0, 100);
        }
        if (el.tagName === 'A' && el.href) it.href = el.href.slice(0, 200);
        if (el.disabled) it.disabled = true;
        out.push(it);
      }
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
      f.el.scrollIntoView({ block: 'center', inline: 'center' });
      f.el.click();
      return { clicked: true };
    }
    case 'type': {
      const f = find(a);
      if (f.error) return { error: f.error };
      const el = f.el;
      el.focus();
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
        el.focus();
        el.textContent = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el instanceof HTMLInputElement && el.type === 'file') {
        return { error: 'unsupported' };
      } else {
        nativeSet(el, String(v));
      }
      return { set: true };
    }
  }
  return { error: 'bad_op' };
}
