import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import express from 'express';
import { DEFAULT_SETTINGS, type Settings } from '../config.js';
import type { TunnelManager } from '../tunnel/index.js';
import { setAutostart } from './autostart.js';
import { createPanelRouter } from './index.js';

let server: http.Server;
let port: number;
let settings: Settings = { ...DEFAULT_SETTINGS };
let pin = 'AAAA-BBBB-CCCC-DDDD';
const audit = Object.assign(new EventEmitter(), { recent: () => [{ ts: 1, tool: 'read_file', allowed: true }] });
const tunnel = Object.assign(new EventEmitter(), {
  status: () => ({ kind: 'cloudflare-quick', state: 'online', publicUrl: 'https://x.trycloudflare.com', stable: false }),
  publicUrl: () => 'https://x.trycloudflare.com',
  start: async () => { tunnelStarts++; },
}) as unknown as TunnelManager;
let tunnelStarts = 0;
let revoked: string[] = [];
let locked = true;

before(async () => {
  const app = express();
  app.use('/panel', createPanelRouter({
    getSettings: () => settings,
    updateSettings: (p) => (settings = { ...settings, ...p }),
    getSecrets: () => ({ signingKey: 'k', ownerPin: pin }),
    regeneratePin: () => { pin = 'ZZZZ-YYYY-XXXX-WWWW'; return { signingKey: 'k', ownerPin: pin }; },
    tunnel,
    auth: { listClients: () => [{ clientId: 'c1', clientName: 'Claude', createdAt: 1 }], revokeClient: (id) => { revoked.push(id); }, revokeAll: () => { revoked.push('*'); }, clearPinLockout: () => { revoked.push('unlock'); locked = false; }, isPinLocked: () => locked },
    audit,
    engineStatus: () => ({ state: 'ready', toolCount: 42 }),
    version: '0.1.0',
    setAutostart: (en) => ({ ok: true, message: en ? 'on' : 'off' }),
  }));
  server = await new Promise<http.Server>((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  port = (server.address() as AddressInfo).port;
});
after(() => { server.close(); server.closeAllConnections?.(); });

function req(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; host?: string } = {}): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { host: opts.host ?? `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json' } : {}), ...opts.headers } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, headers: res.headers }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function csrf(): Promise<string> {
  const r = await req('GET', '/panel/');
  assert.equal(r.status, 200);
  const m = r.body.match(/name="neo-csrf" content="([^"]+)"/);
  assert.ok(m && m[1] !== '__NEO_CSRF__');
  return m[1];
}

test('loopback GET serves the built UI, hashed assets and favicon with correct types and cache headers', async () => {
  const page = await req('GET', '/panel/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'] ?? '', /text\/html/);
  assert.match(page.headers['cache-control'] ?? '', /no-store/);
  assert.ok(!page.body.includes('__NEO_CSRF__'), 'CSRF placeholder replaced');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(page.body), 'no inline scripts');
  assert.ok(!/\sstyle=|<style/i.test(page.body), 'no inline styles');
  const csp = String(page.headers['content-security-policy']);
  assert.match(csp, /script-src 'self';/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(csp));
  const js = page.body.match(/src="(\/panel\/assets\/[^"]+\.js)"/)?.[1];
  const css = page.body.match(/href="(\/panel\/assets\/[^"]+\.css)"/)?.[1];
  assert.ok(js && css, 'index.html references hashed js + css under /panel/assets');
  const jsRes = await req('GET', js);
  assert.equal(jsRes.status, 200);
  assert.match(jsRes.headers['content-type'] ?? '', /javascript/);
  assert.match(jsRes.headers['cache-control'] ?? '', /immutable/);
  const cssRes = await req('GET', css);
  assert.equal(cssRes.status, 200);
  assert.match(cssRes.headers['content-type'] ?? '', /text\/css/);
  const font = cssRes.body.match(/\/panel\/assets\/[^")]+\.woff2/)?.[0];
  assert.ok(font, 'css references a self-hosted font');
  const fontRes = await req('GET', font);
  assert.equal(fontRes.status, 200);
  assert.match(fontRes.headers['content-type'] ?? '', /font\/woff2/);
  const ico = await req('GET', '/panel/favicon.svg');
  assert.equal(ico.status, 200);
  assert.match(ico.headers['content-type'] ?? '', /image\/svg/);
  assert.equal((await req('GET', '/panel/assets/nope-12345678.js')).status, 404);
  assert.equal((await req('GET', '/panel/assets/..%2Findex.html')).status, 404);
  assert.equal((await req('GET', '/panel/assets/index.html')).status, 404);
  assert.equal((await req('GET', '/panel/../../etc/passwd')).status, 404);
  assert.equal((await req('GET', '/panel/package.json')).status, 404);
  assert.equal((await req('GET', '/panel/app.js')).status, 404);
});

test('localhost host header is accepted', async () => {
  assert.equal((await req('GET', '/panel/api/state', { host: `localhost:${port}` })).status, 200);
});

test('state API', async () => {
  const r = await req('GET', '/panel/api/state');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.connectorUrl, 'https://x.trycloudflare.com/mcp');
  assert.equal(j.pin, 'AAAA-BBBB-CCCC-DDDD');
  assert.equal(j.engine.toolCount, 42);
  assert.equal(j.clients.length, 1);
  assert.equal(j.tunnelSettings.hasToken, false);
  assert.ok(!('cloudflareToken' in j.tunnelSettings));
});

test('proxy headers -> 404 for UI and API', async () => {
  for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'tailscale-user-login', 'tailscale-funnel-request', 'via']) {
    assert.equal((await req('GET', '/panel/', { headers: { [h]: '1.2.3.4' } })).status, 404, h);
    assert.equal((await req('GET', '/panel/api/state', { headers: { [h]: 'x' } })).status, 404, h);
  }
});

test('bad Host header -> 404 (DNS rebinding)', async () => {
  assert.equal((await req('GET', '/panel/', { host: 'evil.example.com' })).status, 404);
  assert.equal((await req('GET', '/panel/api/state', { host: `evil.example.com:${port}` })).status, 404);
  assert.equal((await req('GET', '/panel/api/state', { host: '127.0.0.1:1' })).status, 404);
  assert.equal((await req('GET', '/panel/api/state', { host: '127.0.0.1' })).status, 404);
});

test('POST without CSRF -> 403; wrong token -> 403; cross-site -> 403', async () => {
  assert.equal((await req('POST', '/panel/api/settings', { body: { paused: true } })).status, 403);
  assert.equal((await req('POST', '/panel/api/settings', { body: { paused: true }, headers: { 'x-neo-csrf': 'nope' } })).status, 403);
  const t = await csrf();
  assert.equal((await req('POST', '/panel/api/settings', { body: { paused: true }, headers: { 'x-neo-csrf': t, 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await req('POST', '/panel/api/settings', { body: { paused: true }, headers: { 'x-neo-csrf': t, origin: 'http://evil.com' } })).status, 403);
  assert.equal(settings.paused, false);
});

test('POST with CSRF works: pause, mode, dirs, tunnel, validation', async () => {
  const t = await csrf();
  const h = { 'x-neo-csrf': t, 'sec-fetch-site': 'same-origin' };
  let r = await req('POST', '/panel/api/settings', { body: { paused: true, mode: 'readonly' }, headers: h });
  assert.equal(r.status, 200);
  assert.equal(settings.paused, true);
  assert.equal(settings.mode, 'readonly');
  assert.equal((await req('POST', '/panel/api/settings', { body: { mode: 'root' }, headers: h })).status, 400);
  r = await req('POST', '/panel/api/settings', { body: { addDirectory: 'C:\\Users\\Ali\\Belgeler' }, headers: h });
  assert.deepEqual(settings.allowedDirectories, ['C:\\Users\\Ali\\Belgeler']);
  assert.equal((await req('POST', '/panel/api/settings', { body: { addDirectory: 'relative/path' }, headers: h })).status, 400);
  await req('POST', '/panel/api/settings', { body: { removeDirectory: 'C:\\Users\\Ali\\Belgeler' }, headers: h });
  assert.deepEqual(settings.allowedDirectories, []);
  const before = tunnelStarts;
  r = await req('POST', '/panel/api/settings', { body: { tunnel: { kind: 'manual', publicUrl: 'https://neo.example.com/' } }, headers: h });
  assert.equal(r.status, 200);
  assert.equal(settings.tunnel.publicUrl, 'https://neo.example.com');
  assert.equal(tunnelStarts, before + 1);
  assert.equal((await req('POST', '/panel/api/settings', { body: { tunnel: { kind: 'manual', publicUrl: 'http://x.com' } }, headers: h })).status, 400);
  r = await req('POST', '/panel/api/settings', { body: { tunnel: { kind: 'cloudflare-named', cloudflareToken: 'eyJabc.def-ghi=' } }, headers: h });
  assert.equal(JSON.parse(r.body).tunnelSettings.hasToken, true);
  assert.ok(!r.body.includes('eyJabc'));
  r = await req('POST', '/panel/api/settings', { body: { autostart: true }, headers: h });
  assert.equal(settings.autostart, true);
});

test('pin regenerate, revoke, revoke-all, tunnel restart', async () => {
  const h = { 'x-neo-csrf': await csrf() };
  assert.equal(JSON.parse((await req('POST', '/panel/api/pin/regenerate', { headers: h })).body).pin, 'ZZZZ-YYYY-XXXX-WWWW');
  await req('POST', '/panel/api/clients/c1/revoke', { headers: h });
  await req('POST', '/panel/api/clients/revoke-all', { headers: h });
  assert.deepEqual(revoked, ['c1', '*']);
  const before = tunnelStarts;
  assert.equal((await req('POST', '/panel/api/tunnel/restart', { headers: h })).status, 200);
  assert.equal(tunnelStarts, before + 1);
});

test('SSE streams audit entries and status changes', async () => {
  const chunks = await new Promise<string>((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: '/panel/api/events', headers: { host: `127.0.0.1:${port}` } }, (res) => {
      assert.match(res.headers['content-type'] ?? '', /text\/event-stream/);
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        if (buf.includes('hello') && !buf.includes('read_file_sse')) { audit.emit('entry', { tool: 'read_file_sse', allowed: false, durationMs: 5 }); tunnel.emit('status'); }
        if (buf.includes('read_file_sse') && buf.includes('event: status')) { r.destroy(); resolve(buf); }
      });
    });
    r.on('error', (e) => { if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e); });
    r.end();
    setTimeout(() => reject(new Error('sse timeout')), 4000).unref();
  });
  assert.match(chunks, /event: audit\ndata: \{"tool":"read_file_sse"/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(audit.listenerCount('entry'), 0, 'listener cleaned up');
});

test('autostart: windows startup file written/removed; other OS unsupported', () => {
  const app = mkdtempSync(join(tmpdir(), 'neo-app-'));
  const startup = mkdtempSync(join(tmpdir(), 'neo-startup-'));
  writeFileSync(join(app, 'Neo-Commander.cmd'), '');
  assert.equal(setAutostart(true, app, { platform: 'linux' }).ok, false);
  const r = setAutostart(true, app, { platform: 'win32', startupDir: startup });
  assert.equal(r.ok, true);
  const f = join(startup, 'Neo Commander.cmd');
  assert.ok(existsSync(f));
  const body = readFileSync(f, 'utf8');
  assert.match(body, /NEO_NO_BROWSER=1/);
  assert.match(body, /\/min/);
  assert.equal(setAutostart(false, app, { platform: 'win32', startupDir: startup }).ok, true);
  assert.equal(existsSync(f), false);
  assert.equal(setAutostart(true, 'C:\\evil" & calc', { platform: 'win32', startupDir: startup }).ok, false);
});

test('POST /pin/unlock: needs CSRF, clears the lockout, state reports pinLocked', async () => {
  locked = true;
  const st = JSON.parse((await req('GET', '/panel/api/state')).body);
  assert.equal(st.pinLocked, true);
  assert.equal((await req('POST', '/panel/api/pin/unlock', { body: {} })).status, 403); // no CSRF token
  assert.equal((await req('POST', '/panel/api/pin/unlock', { body: {}, host: 'evil.test', headers: { 'x-neo-csrf': await csrf() } })).status, 404); // not direct loopback
  const r = await req('POST', '/panel/api/pin/unlock', { body: {}, headers: { 'x-neo-csrf': await csrf() } });
  assert.equal(r.status, 200);
  assert.ok(revoked.includes('unlock'));
  assert.equal(JSON.parse((await req('GET', '/panel/api/state')).body).pinLocked, false);
});
