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

import { isAllowedExternalUrl, isValidConnectorUrl, isVerifiedPanelOrigin, mayGrantPermission, mayOpenExternal, portInUseMessage } from './util.js';

test('isVerifiedPanelOrigin is an exact origin match', () => {
  assert.ok(isVerifiedPanelOrigin('http://127.0.0.1:8790/panel', 8790));
  assert.ok(!isVerifiedPanelOrigin('http://localhost:8790/panel', 8790));
  assert.ok(!isVerifiedPanelOrigin('http://127.0.0.1:8791/panel', 8790));
  assert.ok(!isVerifiedPanelOrigin('http://127.0.0.1:8790/panel', undefined));
  assert.ok(!isVerifiedPanelOrigin('data:text/html,hi', 8790));
  assert.ok(!isVerifiedPanelOrigin('https://attacker.example/', 8790));
});

test('isAllowedExternalUrl: allowlisted hosts over https only', () => {
  for (const u of ['https://claude.ai/settings', 'https://github.com/x/y', 'https://login.tailscale.com/a', 'https://developers.cloudflare.com/x', 'https://help.openai.com/']) assert.ok(isAllowedExternalUrl(u), u);
  for (const u of ['https://attacker.example/phish', 'http://claude.ai/', 'https://claude.ai.evil.example/', 'https://evil.claude.ai/', 'https://claude.ai:8443/', 'https://u:p@claude.ai/', 'file:///etc/passwd', 'javascript:1']) assert.ok(!isAllowedExternalUrl(u), u);
});

test('mayOpenExternal needs verified panel sender AND allowlisted target', () => {
  assert.ok(mayOpenExternal('http://127.0.0.1:8790/panel', 8790, 'https://claude.ai/'));
  assert.ok(!mayOpenExternal('http://127.0.0.1:8790/panel', 8790, 'https://attacker.example/'));
  assert.ok(!mayOpenExternal('http://127.0.0.1:9999/', 8790, 'https://claude.ai/'));
  assert.ok(!mayOpenExternal('https://attacker.example/', 8790, 'https://claude.ai/'));
  assert.ok(!mayOpenExternal('http://127.0.0.1:8790/panel', undefined, 'https://claude.ai/'));
});

test('mayGrantPermission: clipboard-sanitized-write for the panel origin only', () => {
  assert.ok(mayGrantPermission('clipboard-sanitized-write', 'http://127.0.0.1:8790', 8790));
  assert.ok(mayGrantPermission('clipboard-sanitized-write', 'http://127.0.0.1:8790/panel', 8790));
  assert.ok(!mayGrantPermission('clipboard-sanitized-write', 'https://attacker.example', 8790));
  assert.ok(!mayGrantPermission('clipboard-sanitized-write', 'http://127.0.0.1:8790', undefined));
  assert.ok(!mayGrantPermission('clipboard-read', 'http://127.0.0.1:8790', 8790));
  assert.ok(!mayGrantPermission('media', 'http://127.0.0.1:8790', 8790));
});

test('isValidConnectorUrl', () => {
  assert.ok(isValidConnectorUrl('https://a-b.trycloudflare.com/mcp'));
  assert.ok(isValidConnectorUrl('https://host.tailnet.ts.net/mcp'));
  for (const u of ['http://a.example/mcp', 'https://a.example/', 'https://a.example/mcp?x=1', 'https://127.0.0.1/mcp', 'https://[::1]/mcp', 'https://10.0.0.5/mcp', 'https://2130706433/mcp', 'https://u:p@a.example/mcp', 'https://attacker.example/mcp/evil', '', null, undefined]) assert.ok(!isValidConnectorUrl(u as string), String(u));
});

test('portInUseMessage names the port and settings.json', () => {
  const m = portInUseMessage(8790);
  assert.match(m, /8790/); assert.match(m, /başka bir program tarafından kullanılıyor/); assert.match(m, /settings\.json/);
});
