import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, type Settings } from '../config.js';
import { assetName, candidatePaths, downloadCloudflared, hashFromReleaseBody, parseQuickTunnelUrl, resolveCloudflared, sha256Hex, verifyHash } from './cloudflared.js';
import { TunnelManager, normalizeUrl, type TunnelStatus } from './index.js';

const SAMPLE = `2025-11-01T10:00:00Z INF Thank you for trying Cloudflare Tunnel.
2025-11-01T10:00:01Z INF Requesting new quick Tunnel on trycloudflare.com...
2025-11-01T10:00:02Z INF +--------------------------------------------------------------------------------------------+
2025-11-01T10:00:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2025-11-01T10:00:02Z INF |  https://Random-Words-Here.trycloudflare.com                                               |`;

test('parseQuickTunnelUrl extracts the tunnel URL', () => {
  assert.equal(parseQuickTunnelUrl(SAMPLE), 'https://random-words-here.trycloudflare.com');
  assert.equal(parseQuickTunnelUrl('no url here'), undefined);
});

test('parseQuickTunnelUrl ignores api.trycloudflare.com error text', () => {
  assert.equal(parseQuickTunnelUrl('ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"'), undefined);
});

test('binary resolution order: state bin, PATH, Program Files (x86), winget links', () => {
  const env = { PATH: 'C:\\a;C:\\b', 'ProgramFiles(x86)': 'C:\\PF86', ProgramFiles: 'C:\\PF', LOCALAPPDATA: 'C:\\L' };
  const c = candidatePaths({ binDir: 'C:\\S\\bin', platform: 'win32', env });
  assert.equal(c[0], join('C:\\S\\bin', 'cloudflared.exe'));
  assert.ok(c.indexOf(join('C:\\a', 'cloudflared.exe')) < c.indexOf(join('C:\\b', 'cloudflared.exe')));
  assert.ok(c.indexOf(join('C:\\b', 'cloudflared.exe')) < c.indexOf(join('C:\\PF86', 'cloudflared', 'cloudflared.exe')));
  assert.equal(c[c.length - 1], join('C:\\L', 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'));
  const only = join('C:\\PF86', 'cloudflared', 'cloudflared.exe');
  assert.equal(resolveCloudflared({ binDir: 'C:\\S\\bin', platform: 'win32', env, exists: (p) => p === only }), only);
  const both = new Set([only, c[0]]);
  assert.equal(resolveCloudflared({ binDir: 'C:\\S\\bin', platform: 'win32', env, exists: (p) => both.has(p) }), c[0]);
  assert.equal(resolveCloudflared({ binDir: 'x', platform: 'linux', env: { PATH: '' }, exists: () => false }), undefined);
});

test('assetName per platform', () => {
  assert.equal(assetName('win32', 'x64'), 'cloudflared-windows-amd64.exe');
  assert.equal(assetName('linux', 'arm64'), 'cloudflared-linux-arm64');
  assert.equal(assetName('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz');
});

test('hash verification good/bad', () => {
  const data = Buffer.from('hello');
  verifyHash(data, sha256Hex(data));
  assert.throws(() => verifyHash(data, 'a'.repeat(64)));
});

test('hashFromReleaseBody finds exact asset line', () => {
  const h = 'b'.repeat(64);
  const body = `cloudflared-linux-amd64.deb: ${'c'.repeat(64)}\ncloudflared-linux-amd64: ${h}\n`;
  assert.equal(hashFromReleaseBody(body, 'cloudflared-linux-amd64'), h);
});

function fakeFetch(payload: Buffer, hash: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes('api.github.com')) return new Response(JSON.stringify({ body: `cloudflared-linux-amd64: ${hash}` }), { status: 200 });
    return new Response(new Uint8Array(payload), { status: 200 });
  }) as typeof fetch;
}

test('download installs verified binary and rejects tampered one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-dl-'));
  const payload = Buffer.from('#!/bin/sh\necho hi\n');
  const p = await downloadCloudflared({ binDir: dir, version: '9999.1.0', platform: 'linux', arch: 'x64', fetchImpl: fakeFetch(payload, sha256Hex(payload)) });
  assert.equal(p, join(dir, 'cloudflared'));
  const dir2 = mkdtempSync(join(tmpdir(), 'neo-dl-'));
  await assert.rejects(downloadCloudflared({ binDir: dir2, version: '9999.1.0', platform: 'linux', arch: 'x64', fetchImpl: fakeFetch(payload, 'd'.repeat(64)) }), /SHA-256/);
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(join(dir2, 'cloudflared')), false);
});

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('https://a.example.com/'), 'https://a.example.com');
  assert.equal(normalizeUrl('http://a.example.com'), undefined);
  assert.equal(normalizeUrl('nope'), undefined);
});

function settings(kind: Settings['tunnel']['kind'], extra: Partial<Settings['tunnel']> = {}): Settings {
  return { ...DEFAULT_SETTINGS, tunnel: { kind, ...extra } };
}

async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); }
}

test('quick tunnel: starting -> online on edge registration; url event; stop -> off', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-fake-'));
  const fake = join(dir, 'cloudflared');
  writeFileSync(fake, `#!/usr/bin/env node\nconsole.error('INF |  https://fake-one.trycloudflare.com  |');console.error('INF Registered tunnel connection connIndex=0 location=fra08 protocol=quic');\nsetInterval(()=>{},1000);\n`);
  chmodSync(fake, 0o755);
  let checks = 0;
  const m = new TunnelManager({ stateDir: dir, port: 1, getSettings: () => settings('cloudflare-quick'), cloudflaredPath: fake, healthCheck: async () => ++checks >= 2 });
  const seen: string[] = [];
  const urls: (string | undefined)[] = [];
  m.on('status', (s: TunnelStatus) => seen.push(s.state));
  m.on('url', (u) => urls.push(u));
  await m.start();
  assert.equal(m.status().state, 'starting');
  await waitFor(() => m.status().state === 'online');
  assert.equal(m.publicUrl(), 'https://fake-one.trycloudflare.com');
  assert.equal(m.status().stable, false);
  await waitFor(() => checks >= 1); // background reachability probe runs, but does not gate online
  assert.ok(seen.includes('starting'));
  assert.deepEqual(urls, ['https://fake-one.trycloudflare.com']);
  await m.stop();
  assert.equal(m.status().state, 'off');
  assert.equal(m.publicUrl(), undefined);
});

test('quick tunnel restarts with backoff when process dies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-fake-'));
  const fake = join(dir, 'cloudflared');
  const counter = join(dir, 'count');
  writeFileSync(counter, '');
  writeFileSync(fake, `#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(counter)},'x');const n=fs.readFileSync(${JSON.stringify(counter)}).length;console.error('https://run-'+n+'.trycloudflare.com');console.error('INF Registered tunnel connection connIndex=0 location=fra08 protocol=quic');if(n<2)setTimeout(()=>process.exit(1),100);else setInterval(()=>{},1000);\n`);
  chmodSync(fake, 0o755);
  const m = new TunnelManager({ stateDir: dir, port: 1, getSettings: () => settings('cloudflare-quick'), cloudflaredPath: fake, healthCheck: async () => true, restartDelaysMs: [50] });
  await m.start();
  await waitFor(() => m.publicUrl() === 'https://run-2.trycloudflare.com' && m.status().state === 'online');
  await m.stop();
});

test('quick tunnel: URL alone is not online; registered edge connection is', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-fake-'));
  const fake = join(dir, 'cloudflared');
  writeFileSync(fake, `#!/usr/bin/env node\nconsole.error('https://slow.trycloudflare.com');setTimeout(()=>console.error('INF Registered tunnel connection connIndex=0'),400);setInterval(()=>{},1000);\n`);
  chmodSync(fake, 0o755);
  const m = new TunnelManager({ stateDir: dir, port: 1, getSettings: () => settings('cloudflare-quick'), cloudflaredPath: fake, healthCheck: async () => true });
  await m.start();
  await new Promise((r) => setTimeout(r, 150));
  assert.notEqual(m.status().state, 'online');
  await waitFor(() => m.status().state === 'online');
  assert.equal(m.publicUrl(), 'https://slow.trycloudflare.com');
  await m.stop();
});

test('quick tunnel stays online (with a hint) when local health check keeps failing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-fake-'));
  const fake = join(dir, 'cloudflared');
  writeFileSync(fake, `#!/usr/bin/env node\nconsole.error('https://never.trycloudflare.com');console.error('INF Registered tunnel connection connIndex=0 location=fra08 protocol=quic');setInterval(()=>{},1000);\n`);
  chmodSync(fake, 0o755);
  const m = new TunnelManager({ stateDir: dir, port: 1, getSettings: () => settings('cloudflare-quick'), cloudflaredPath: fake, healthCheck: async () => false, healthTimeoutMs: 1200, restartDelaysMs: [60000] });
  await m.start();
  await waitFor(() => /DNS/.test(m.status().message ?? ''));
  assert.equal(m.status().state, 'online');
  assert.equal(m.publicUrl(), 'https://never.trycloudflare.com');
  await m.stop();
});

test('manual / none / named validation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-fake-'));
  let s = settings('manual', { publicUrl: 'https://my.example.com/' });
  const m = new TunnelManager({ stateDir: dir, port: 1, getSettings: () => s });
  await m.start();
  assert.deepEqual([m.status().state, m.publicUrl(), m.status().stable], ['online', 'https://my.example.com', true]);
  s = settings('none');
  await m.start();
  assert.equal(m.status().state, 'off');
  s = settings('cloudflare-named', {});
  await m.start();
  assert.equal(m.status().state, 'error');
  await m.stop();
});

test('tailscale: funnel not enabled gives clear error; success derives DNSName URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-ts-'));
  const ts = join(dir, 'tailscale');
  writeFileSync(ts, `#!/usr/bin/env node
const a=process.argv.slice(2);
if(a[0]==='status'){console.log(JSON.stringify({BackendState:'Running',Self:{DNSName:'pc.tail1234.ts.net.'}}));}
else if(a[0]==='funnel'&&a.includes('--bg')){ if(process.env.FUNNEL_OFF){console.error('Funnel is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/funnel?node=abc');process.exit(1);} console.log('Available on the internet');}
`);
  chmodSync(ts, 0o755);
  const m = new TunnelManager({ stateDir: dir, port: 8790, getSettings: () => settings('tailscale'), tailscalePath: ts });
  process.env.FUNNEL_OFF = '1';
  await m.start();
  await waitFor(() => m.status().state !== 'starting');
  assert.equal(m.status().state, 'error');
  assert.match(m.status().message ?? '', /Funnel/);
  assert.match(m.status().message ?? '', /login\.tailscale\.com/);
  delete process.env.FUNNEL_OFF;
  await m.start();
  await waitFor(() => m.status().state === 'online');
  assert.equal(m.publicUrl(), 'https://pc.tail1234.ts.net');
  assert.equal(m.status().stable, true);
  await m.stop();
});
