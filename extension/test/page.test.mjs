import test from 'node:test';
import assert from 'node:assert/strict';
import { capyPage } from '../lib/page.js';

function createMockDOM() {
  const listeners = new Map();
  function makeEl(tag, attrs = {}) {
    const el = {
      tagName: tag.toUpperCase(),
      localName: tag.toLowerCase(),
      nodeType: 1,
      isConnected: true,
      attributes: { ...attrs },
      children: [],
      childNodes: [],
      style: {},
      getAttribute(k) { return this.attributes[k] || null; },
      setAttribute(k, v) { this.attributes[k] = String(v); },
      hasAttribute(k) { return k in this.attributes; },
      getBoundingClientRect() { return { x: 10, y: 20, width: 100, height: 30 }; },
      scrollIntoView() { this.scrolled = true; },
      closest(sel) { return sel.includes(tag.toLowerCase()) ? this : null; },
      matches(sel) { return sel.toLowerCase() === tag.toLowerCase() || (attrs.id && sel === '#' + attrs.id); },
      dispatchEvent(ev) {
        this.dispatched = this.dispatched || [];
        this.dispatched.push(ev.type);
        return true;
      },
      click() {
        this.clicked = true;
        this.dispatchEvent({ type: 'click' });
      },
      appendChild(c) {
        this.children.push(c);
        this.childNodes.push(c);
        c.parentNode = this;
        return c;
      },
      remove() {
        if (this.parentNode) {
          const i = this.parentNode.childNodes.indexOf(this);
          if (i >= 0) this.parentNode.childNodes.splice(i, 1);
        }
      },
      value: attrs.value || '',
      type: attrs.type || (tag === 'input' ? 'text' : ''),
      innerText: attrs.innerText || '',
      textContent: attrs.textContent || attrs.innerText || '',
    };
    return el;
  }

  const doc = {
    title: 'Test Page',
    location: { href: 'https://example.com/test' },
    body: makeEl('body'),
    documentElement: makeEl('html'),
    createElement: makeEl,
    nodeType: 9,
    children: [],
    getElementById(id) {
      function find(node) {
        if (node.attributes && node.attributes.id === id) return node;
        for (const c of node.childNodes || []) {
          const hit = find(c);
          if (hit) return hit;
        }
        return null;
      }
      return find(doc.documentElement);
    },
    querySelector(sel) { return null; },
    querySelectorAll(sel) { return []; },
    execCommand() { return false; },
  };
  doc.children.push(doc.documentElement);
  doc.documentElement.appendChild(doc.body);
  return { doc, makeEl };
}

test('page.js: guards neutralize alerts and confirm dialogs', () => {
  const { doc } = createMockDOM();
  globalThis.document = doc;
  globalThis.location = doc.location;
  globalThis.window = globalThis;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });

  // Call capyPage to trigger guard setup
  capyPage('text', {});

  assert.equal(typeof globalThis.alert, 'function');
  assert.equal(globalThis.alert('boom'), undefined);
  assert.equal(globalThis.confirm('sure?'), true);
  assert.equal(globalThis.prompt('enter:'), null);
});

test('page.js: text extraction extracts headings and body text on standard websites', () => {
  const { doc, makeEl } = createMockDOM();
  globalThis.document = doc;
  globalThis.location = doc.location;
  globalThis.window = globalThis;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });

  const h1 = makeEl('h1', { innerText: 'Welcome to Example' });
  const p = makeEl('p', { innerText: 'This is an awesome portal for agents.' });
  const btn = makeEl('button', { innerText: 'Get Started' });
  doc.body.appendChild(h1);
  doc.body.appendChild(p);
  doc.body.appendChild(btn);

  const res = capyPage('text', {});
  assert.equal(res.title, 'Test Page');
  assert.ok(res.text.includes('# Test Page'));
  assert.ok(res.text.includes('Welcome to Example'));
  assert.ok(res.text.includes('Get Started'));
});

test('page.js: snapshot extracts interactive elements with roles, names, and rects', () => {
  const { doc, makeEl } = createMockDOM();
  globalThis.document = doc;
  globalThis.location = doc.location;
  globalThis.window = globalThis;
  globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });

  const btn = makeEl('button', { innerText: 'Submit Request', id: 'sub' });
  const inp = makeEl('input', { type: 'text', value: 'hello agent', id: 'name-field', 'aria-label': 'User Name' });
  doc.body.appendChild(btn);
  doc.body.appendChild(inp);

  const res = capyPage('snapshot', {});
  assert.ok(Array.isArray(res.snapshot));
  assert.ok(res.snapshot.length >= 2);

  const buttonSnap = res.snapshot.find((x) => x.role === 'button');
  assert.ok(buttonSnap);
  assert.equal(buttonSnap.name, 'Submit Request');
  assert.ok(buttonSnap.ref.startsWith('e'));
  assert.deepEqual(buttonSnap.rect, { x: 10, y: 20, w: 100, h: 30 });

  const inputSnap = res.snapshot.find((x) => x.type === 'text');
  assert.ok(inputSnap);
  assert.equal(inputSnap.name, 'User Name');
  assert.equal(inputSnap.value, 'hello agent');
});

test('page.js: click dispatches full pointer and mouse event chain', () => {
  const { doc, makeEl } = createMockDOM();
  globalThis.document = doc;
  globalThis.location = doc.location;
  globalThis.window = globalThis;
  globalThis.PointerEvent = function (type, opts) { return { type, ...opts }; };
  globalThis.MouseEvent = function (type, opts) { return { type, ...opts }; };

  const btn = makeEl('button', { innerText: 'Click Me', id: 'test-btn' });
  doc.body.appendChild(btn);

  // Describe to get ref
  const desc = capyPage('describe', { selector: '#test-btn' });
  assert.ok(desc.ref);

  const clickRes = capyPage('click', { ref: desc.ref });
  assert.equal(clickRes.clicked, true);
  assert.equal(btn.clicked, true);
  assert.equal(btn.scrolled, true);
  assert.ok(btn.dispatched.includes('pointerdown'));
  assert.ok(btn.dispatched.includes('mousedown'));
  assert.ok(btn.dispatched.includes('pointerup'));
  assert.ok(btn.dispatched.includes('mouseup'));
  assert.ok(btn.dispatched.includes('click'));
});
