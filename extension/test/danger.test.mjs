import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyClick, isSecretField, isLoginField } from '../lib/danger.js';

test('password and code fields are secret', () => {
  assert.equal(isSecretField({ type: 'password' }), true);
  assert.equal(isSecretField({ type: 'text', autocomplete: 'one-time-code' }), true);
  assert.equal(isSecretField({ type: 'text', name: 'user_password' }), true);
  assert.equal(isSecretField({ type: 'text', placeholder: 'Введите пароль' }), true);
  assert.equal(isSecretField({ type: 'text', autocomplete: 'cc-number' }), true);
  assert.equal(isSecretField({ type: 'text', label: 'CVV' }), true);
});
test('ordinary fields are not secret (passport, search)', () => {
  assert.equal(isSecretField({ type: 'text', name: 'passport_city' }), false);
  assert.equal(isSecretField({ type: 'search', name: 'q', placeholder: 'Search' }), false);
  assert.equal(isSecretField({ type: 'email', name: 'email' }), false);
});
test('a field in a form with a password input is a login field', () => {
  assert.equal(isLoginField({ type: 'email', formHasPassword: true }), true);
  assert.equal(isLoginField({ type: 'email', formHasPassword: false }), false);
});
test('payment, delete, upload, download, POST submit are dangerous', () => {
  assert.equal(classifyClick({ tag: 'button', text: 'Pay now' }).kind, 'payment');
  assert.equal(classifyClick({ tag: 'button', text: 'Оплатить заказ' }).kind, 'payment');
  assert.equal(classifyClick({ tag: 'button', text: 'Delete account' }).kind, 'delete');
  assert.equal(classifyClick({ tag: 'button', text: 'Удалить' }).kind, 'delete');
  assert.equal(classifyClick({ tag: 'input', type: 'file' }).kind, 'upload');
  assert.equal(classifyClick({ tag: 'a', href: 'https://x.test/app.exe' }).kind, 'download');
  assert.equal(classifyClick({ tag: 'a', download: true, href: 'https://x.test/r' }).kind, 'download');
  assert.equal(classifyClick({ tag: 'button', text: 'Go', isSubmit: true, formMethod: 'post' }).kind, 'submit');
  assert.equal(classifyClick({ tag: 'button', text: 'Send message', isSubmit: true, formMethod: 'get' }).kind, 'submit');
});
test('harmless clicks pass', () => {
  assert.equal(classifyClick({ tag: 'button', text: 'Search', isSubmit: true, formMethod: 'get' }), null);
  assert.equal(classifyClick({ tag: 'a', text: 'Payment methods', href: 'https://x.test/pay' }), null);
  assert.equal(classifyClick({ tag: 'button', text: 'Next' }), null);
  assert.equal(classifyClick(null), null);
});
