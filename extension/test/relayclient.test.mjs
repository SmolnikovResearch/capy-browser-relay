import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRelay, wsUrl } from '../lib/relayclient.js';

test('localhost relay stays a plain origin', () => {
  assert.equal(normalizeRelay('http://127.0.0.1:18791/'), 'http://127.0.0.1:18791');
  assert.equal(wsUrl('http://127.0.0.1:18791'), 'ws://127.0.0.1:18791/v1/device/ws');
});

test('public relay keeps one path prefix', () => {
  assert.equal(normalizeRelay('https://capyagent.com/browser-relay/'), 'https://capyagent.com/browser-relay');
  assert.equal(wsUrl('https://capyagent.com/browser-relay'), 'wss://capyagent.com/browser-relay/v1/device/ws');
  assert.throws(() => normalizeRelay('http://capyagent.com/browser-relay'), /https/);
});
