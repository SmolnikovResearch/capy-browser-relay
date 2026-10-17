import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, isDenied, hostMatches } from '../lib/policy.js';

const P = (o = {}) => ({ allowed: ['example.com'], ...o });

test('empty allowlist allows nothing', () => {
  assert.equal(isAllowed('https://example.com/', { allowed: [] }), false);
});
test('subdomains match, lookalikes do not', () => {
  assert.equal(isAllowed('https://a.example.com/x', P()), true);
  assert.equal(isAllowed('https://notexample.com/', P()), false);
  assert.equal(isAllowed('https://example.com.evil.test/', P()), false);
});
test('non-http schemes are refused', () => {
  for (const u of ['chrome://settings', 'file:///etc/passwd', 'about:blank', 'javascript:alert(1)', 'chrome-extension://x/y', 'data:text/html,x', '']) {
    assert.equal(isAllowed(u, P({ allowed: ['*'] })), false, u);
  }
});
test('built-in deny floor wins over the allowlist', () => {
  assert.equal(isAllowed('https://online.sberbank.ru/', { allowed: ['sberbank.ru'] }), false);
  assert.equal(isAllowed('https://accounts.google.com/', { allowed: ['google.com'] }), false);
  assert.equal(isAllowed('https://chromewebstore.google.com/detail/x', { allowed: ['google.com'] }), false);
  assert.equal(isAllowed('https://chrome.google.com/webstore/detail/x', { allowed: ['google.com'] }), false);
  assert.equal(isAllowed('https://chrome.google.com/other', { allowed: ['google.com'] }), true);
});
test('relay-sent and local deny lists apply', () => {
  assert.equal(isAllowed('https://shop.example.com/', P({ denied: ['shop.example.com'] })), false);
  assert.equal(isAllowed('https://shop.example.com/', P({ localDenied: ['example.com'] })), false);
});
test('local allowlist only narrows', () => {
  assert.equal(isAllowed('https://a.example.com/', P({ localAllowed: ['b.example.com'] })), false);
  assert.equal(isAllowed('https://b.example.com/', P({ localAllowed: ['b.example.com'] })), true);
  assert.equal(isAllowed('https://other.org/', P({ localAllowed: ['other.org'] })), false);
});
test('hostMatches handles wildcard prefix and empties', () => {
  assert.equal(hostMatches('a.b.com', '*.b.com'), true);
  assert.equal(hostMatches('a.com', '*'), true);
  assert.equal(isAllowed('https://example.com/', { allowed: ['*'] }), true);
  assert.equal(isAllowed('https://online.sberbank.ru/', { allowed: ['*'] }), false);
  assert.equal(hostMatches('a.com', ''), false);
  assert.equal(isDenied('not a url'), true);
});
