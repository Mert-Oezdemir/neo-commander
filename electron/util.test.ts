import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectorUrl, isPanelUrl, isSafeExternalUrl, shouldStartHidden } from './util.js';

test('isPanelUrl accepts only the panel origin', () => {
  assert.ok(isPanelUrl('http://127.0.0.1:8787/panel', 8787));
  assert.ok(isPanelUrl('http://localhost:8787/panel/x', 8787));
  assert.ok(!isPanelUrl('http://127.0.0.1:8788/panel', 8787));
  assert.ok(!isPanelUrl('https://127.0.0.1:8787/panel', 8787));
  assert.ok(!isPanelUrl('http://evil.example:8787/', 8787));
  assert.ok(!isPanelUrl('http://127.0.0.1.evil.example:8787/', 8787));
  assert.ok(!isPanelUrl('file:///etc/passwd', 8787));
  assert.ok(!isPanelUrl('not a url', 8787));
});

test('isSafeExternalUrl allows https only', () => {
  assert.ok(isSafeExternalUrl('https://claude.ai/settings'));
  assert.ok(!isSafeExternalUrl('http://claude.ai'));
  assert.ok(!isSafeExternalUrl('file:///C:/Windows/System32/calc.exe'));
  assert.ok(!isSafeExternalUrl('javascript:alert(1)'));
  assert.ok(!isSafeExternalUrl('ms-msdt:/id'));
  assert.ok(!isSafeExternalUrl('https://user:pw@example.com/'));
});

test('connectorUrl', () => {
  assert.equal(connectorUrl('https://a.trycloudflare.com/'), 'https://a.trycloudflare.com/mcp');
  assert.equal(connectorUrl('https://a.example'), 'https://a.example/mcp');
  assert.equal(connectorUrl(undefined), null);
});

test('shouldStartHidden', () => {
  assert.ok(shouldStartHidden(['x', '--hidden'], {}));
  assert.ok(shouldStartHidden(['x'], { wasOpenedAsHidden: true }));
  assert.ok(!shouldStartHidden(['x'], { wasOpenedAtLogin: true }, 'win32'));
  assert.ok(shouldStartHidden(['x'], { wasOpenedAtLogin: true }, 'darwin'));
});
