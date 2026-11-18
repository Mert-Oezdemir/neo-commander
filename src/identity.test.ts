import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { startServer, PortInUseError, handlePortInUse, probeHealthz, type RunningServer, type TunnelLike } from './server.js';
import { computeMac, instanceFile, readInstanceFile } from './identity.js';
import type { Engine } from './engine/index.js';

const fakeEngine = Object.assign(new EventEmitter(), {
  start: async () => {}, stop: async () => {}, status: () => ({ state: 'ready', toolCount: 0 }), listTools: () => [], callTool: async () => ({ content: [] }),
}) as unknown as Engine;
const overrides = {
  auth: () => ({
    router: (_q: any, _r: any, next: any) => next(), requireAuth: (_q: any, r: any) => { r.status(401).end(); },
    listClients: () => [], revokeClient() {}, revokeAll() {}, clearPinLockout() {}, isPinLocked: () => false, onPublicUrlChanged() {},
  }),
  ownTools: [],
  engine: fakeEngine,
  tunnel: () => Object.assign(new EventEmitter(), {
    start: async () => {}, stop: async () => {},
    status: () => ({ kind: 'none', state: 'off' as const, stable: true }), publicUrl: () => undefined,
  }) as TunnelLike,
  panelRouter: () => express.Router(),
  setAutostart: () => ({ ok: true, message: 'ok' }),
};

let dir: string;
let srv: RunningServer;
const squatters: Server[] = [];
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'neo-ident-'));
  srv = await startServer({ stateDir: dir, port: 0, quiet: true, openBrowser: false, overrides });
});
after(async () => {
  await srv.close().catch(() => {});
  for (const s of squatters) s.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (port: number, path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers });

function squat(handler: Parameters<typeof createServer>[1]): Promise<{ port: number; srv: Server }> {
  return new Promise((resolve) => {
    const s = createServer(handler).listen(0, '127.0.0.1', () => {
      squatters.push(s);
      resolve({ port: (s.address() as { port: number }).port, srv: s });
    });
  });
}

test('instance.json is written 0600 with a 32-byte key and the bound port', () => {
  const info = readInstanceFile(dir)!;
  assert.equal(info.port, srv.port);
  assert.match(info.instanceKey, /^[0-9a-f]{64}$/);
  if (process.platform !== 'win32') assert.equal(statSync(instanceFile(dir)).mode & 0o777, 0o600);
});

test('/healthz/identity returns the HMAC of the nonce; plain /healthz is unchanged', async () => {
  const nonce = randomBytes(16).toString('hex');
  const r = await get(srv.port, `/healthz/identity?nonce=${nonce}`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { mac: computeMac(readInstanceFile(dir)!.instanceKey, nonce) });
  assert.deepEqual(await (await get(srv.port, '/healthz')).json(), { ok: true });
});

test('/healthz/identity is 404 for bad nonce, missing nonce, non-loopback Host and proxy headers', async () => {
  assert.equal((await get(srv.port, '/healthz/identity')).status, 404);
  assert.equal((await get(srv.port, '/healthz/identity?nonce=zz')).status, 404);
  assert.equal((await get(srv.port, '/healthz/identity?nonce=ab')).status, 404);
  const nonce = randomBytes(16).toString('hex');
  const viaTunnel = await get(srv.port, `/healthz/identity?nonce=${nonce}`, { 'x-forwarded-for': '1.2.3.4' });
  assert.equal(viaTunnel.status, 404);
  const { request } = await import('node:http');
  const status = await new Promise<number>((res, rej) => {
    const q = request({ host: '127.0.0.1', port: srv.port, path: `/healthz/identity?nonce=${nonce}`, headers: { host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode ?? 0); });
    q.on('error', rej); q.end();
  });
  assert.equal(status, 404);
});

test('probeHealthz verifies the real server', async () => {
  assert.equal(await probeHealthz(srv.port, dir), true);
});

test('probeHealthz rejects a squatter that answers {"ok":true} to everything', async () => {
  const s = await squat((_q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"ok":true,"mac":"' + '0'.repeat(64) + '"}'); });
  assert.equal(await probeHealthz(s.port, dir), false);
});

test('probeHealthz rejects a squatter that has a stale/other-port instance.json and a wrong key', async () => {
  const other = mkdtempSync(join(tmpdir(), 'neo-ident-other-'));
  try {
    const s = await squat((q, r) => {
      const nonce = new URL(q.url ?? '/', 'http://x').searchParams.get('nonce') ?? '';
      r.setHeader('content-type', 'application/json');
      r.end(JSON.stringify({ mac: computeMac(randomBytes(32).toString('hex'), nonce) }));
    });
    writeFileSync(instanceFile(other), JSON.stringify({ instanceKey: randomBytes(32).toString('hex'), port: s.port }));
    assert.equal(await probeHealthz(s.port, other), false);
    // No instance.json at all, or one for a different port: also false (even for the genuine server).
    rmSync(instanceFile(other));
    assert.equal(await probeHealthz(s.port, other), false);
    writeFileSync(instanceFile(other), JSON.stringify({ instanceKey: readInstanceFile(dir)!.instanceKey, port: srv.port + 1 }));
    assert.equal(await probeHealthz(srv.port, other), false);
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test('startServer on a squatted port: PortInUseError.otherNeoCommander=false, CLI exits 1 without opening anything', async () => {
  const s = await squat((_q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"ok":true}'); });
  const other = mkdtempSync(join(tmpdir(), 'neo-ident-sq-'));
  try {
    const err = await startServer({ stateDir: other, port: s.port, quiet: true, openBrowser: false, overrides }).then(() => null, (e) => e);
    assert.ok(err instanceof PortInUseError);
    assert.equal(err.otherNeoCommander, false);
    assert.equal(existsSync(instanceFile(other)), false, 'a failed start must not publish an instance key');
    const prev = process.env.NEO_NO_BROWSER; process.env.NEO_NO_BROWSER = '1';
    const origErr = console.error; console.error = () => {};
    try { assert.equal(await handlePortInUse(err), 1); } finally { console.error = origErr; process.env.NEO_NO_BROWSER = prev; if (prev === undefined) delete process.env.NEO_NO_BROWSER; }
  } finally { rmSync(other, { recursive: true, force: true }); }
});

test('second start in the same state dir on the real server: otherNeoCommander=true', async () => {
  const err = await startServer({ stateDir: dir, port: srv.port, quiet: true, openBrowser: false, overrides }).then(() => null, (e) => e);
  assert.ok(err instanceof PortInUseError);
  assert.equal(err.otherNeoCommander, true);
  assert.equal(err.stateDir, dir);
  assert.ok(existsSync(instanceFile(dir)), 'failed second start must not delete the first instance file');
});

test('instance.json is removed on clean shutdown', async () => {
  const d = mkdtempSync(join(tmpdir(), 'neo-ident-close-'));
  try {
    const s = await startServer({ stateDir: d, port: 0, quiet: true, openBrowser: false, overrides });
    assert.ok(existsSync(instanceFile(d)));
    await s.close();
    assert.equal(existsSync(instanceFile(d)), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
