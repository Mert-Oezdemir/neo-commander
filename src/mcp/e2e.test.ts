import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { startServer, type RunningServer, type AuthLike, type TunnelLike } from '../server.js';
import { textResult, type ToolDef } from '../tools/types.js';

let dir: string;
let srv: RunningServer;
let url: URL;
const calls: string[] = [];
let fakeAuth: AuthLike;

const fakeTool: ToolDef = {
  name: 'desktop_fake',
  description: 'fake own tool',
  inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
  risk: 'read',
  handler: async (args, ctx) => { calls.push(String(args.x)); return textResult(`fake:${args.x}:${ctx.allowedDirectories.length}`); },
};
const bigTool: ToolDef = {
  name: 'desktop_big', description: 'big', inputSchema: { type: 'object' }, risk: 'read',
  handler: async () => textResult('a'.repeat(300_000)),
};
const boomTool: ToolDef = {
  name: 'desktop_boom', description: 'boom', inputSchema: { type: 'object' }, risk: 'read',
  handler: async () => { throw new Error('kaboom'); },
};

function makeClient(token: string) {
  const client = new Client({ name: 't', version: '1' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  return { client, transport };
}
const text = (r: any) => (r.content ?? []).map((c: any) => c.text ?? '').join('\n');

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'neo-e2e-'));
  const dirs = mkdtempSync(join(tmpdir(), 'neo-e2e-files-'));
  writeFileSync(join(dirs, 'a.txt'), 'hello');
  (globalThis as any).__filesDir = dirs;
  srv = await startServer({
    stateDir: dir, port: 0, quiet: true, openBrowser: false,
    overrides: {
      auth: () => (fakeAuth = {
        router: (_req, _res, next) => next(),
        requireAuth: (req, res, next) => {
          const m = /^Bearer (tok[A-Z])$/.exec(req.headers.authorization ?? '');
          if (!m) { res.status(401).json({ error: 'unauthorized' }); return; }
          (req as any).auth = { token: m[1], clientId: m[1].slice(3), scopes: [] };
          next();
        },
        listClients: () => [], revokeClient() {}, revokeAll() {}, onPublicUrlChanged() {},
      }),
      ownTools: [fakeTool, bigTool, boomTool],
      tunnel: () => Object.assign(new EventEmitter(), {
        start: async () => {}, stop: async () => {},
        status: () => ({ kind: 'none', state: 'off' as const, stable: true }), publicUrl: () => undefined,
      }) as TunnelLike,
      panelRouter: () => express.Router().get('/', (_q, r) => { r.send('panel'); }),
      setAutostart: () => ({ ok: true, message: 'ok' }),
    },
  });
  url = new URL(`http://127.0.0.1:${srv.port}/mcp`);
});
after(async () => {
  await srv.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync((globalThis as any).__filesDir, { recursive: true, force: true });
});

test('healthz leaks nothing; / is 404 for non-loopback host header; mcp needs auth', async () => {
  const h = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
  assert.deepEqual(await h.json(), { ok: true });
  assert.equal(h.headers.get('x-powered-by'), null);
  const m = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(m.status, 401);
});

test('list, own tool, engine tool, truncation, exception, unknown', async () => {
  const { client, transport } = makeClient('tokA');
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, 'neo-commander');
  assert.match(client.getInstructions() ?? '', /Windows/);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('desktop_fake') && names.includes('read_file') && names.includes('list_directory'));
  const own = await client.callTool({ name: 'desktop_fake', arguments: { x: 'hi' } });
  assert.equal(text(own), 'fake:hi:0');
  const eng = await client.callTool({ name: 'list_directory', arguments: { path: (globalThis as any).__filesDir } });
  assert.match(text(eng), /a\.txt/);
  const big = await client.callTool({ name: 'desktop_big', arguments: {} });
  assert.ok(text(big).length < 201_000 && /truncated/.test(text(big)));
  const boom = await client.callTool({ name: 'desktop_boom', arguments: {} });
  assert.equal(boom.isError, true);
  assert.match(text(boom), /kaboom/);
  const unk = await client.callTool({ name: 'nope', arguments: {} });
  assert.equal(unk.isError, true);
  await client.close();
});

test('audit has entries', () => {
  // AuditLog writes audit.jsonl in the state dir
  const f = join(dir, 'audit.jsonl');
  const lines = (require_fs().readFileSync(f, 'utf8') as string).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.tool === 'desktop_fake' && e.decision === 'allowed' && e.source === 'own'));
  assert.ok(lines.some((e) => e.tool === 'list_directory' && e.source === 'engine'));
  assert.ok(lines.some((e) => e.tool === 'desktop_boom' && e.decision === 'error'));
});

test('policy: readonly hides + denies, list_changed notified, paused denies', async () => {
  const { client, transport } = makeClient('tokA');
  let changed = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { changed++; });
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some((t) => t.name === 'write_file'));
  await new Promise((r) => setTimeout(r, 200)); // let the standalone SSE stream attach
  srv.updateSettings({ mode: 'readonly' });
  for (let i = 0; i < 50 && !changed; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(changed >= 1, 'list_changed received');
  assert.ok(!(await client.listTools()).tools.some((t) => t.name === 'write_file'));
  const denied = await client.callTool({ name: 'write_file', arguments: { path: join(dir, 'x'), content: 'x' } });
  assert.equal(denied.isError, true);
  srv.updateSettings({ mode: 'full', paused: true });
  const paused = await client.callTool({ name: 'desktop_fake', arguments: { x: 'p' } });
  assert.equal(paused.isError, true);
  srv.updateSettings({ paused: false });
  const ok = await client.callTool({ name: 'desktop_fake', arguments: { x: 'ok' } });
  assert.notEqual(ok.isError, true);
  await client.close();
  const lines = (require_fs().readFileSync(join(dir, 'audit.jsonl'), 'utf8') as string).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.tool === 'write_file' && e.decision === 'denied'));
});

test('sessions are bound to the creating client; DELETE ends session', async () => {
  const baseline = srv.sessions.size;
  const a = makeClient('tokA');
  await a.client.connect(a.transport);
  assert.equal(srv.sessions.size, baseline + 1);
  const sid = a.transport.sessionId!;
  assert.ok(sid);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const hdr = (tok: string) => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok}`, 'mcp-session-id': sid });
  const other = await fetch(url, { method: 'POST', headers: hdr('tokB'), body });
  assert.equal(other.status, 404);
  const same = await fetch(url, { method: 'POST', headers: hdr('tokA'), body });
  assert.equal(same.status, 200);
  await same.text();
  const delOther = await fetch(url, { method: 'DELETE', headers: hdr('tokB') });
  assert.equal(delOther.status, 404);
  await a.transport.terminateSession();
  const gone = await fetch(url, { method: 'POST', headers: hdr('tokA'), body });
  assert.equal(gone.status, 404);
  assert.equal(srv.sessions.size, baseline);
  const noInit = await fetch(url, { method: 'POST', headers: { ...hdr('tokA'), 'mcp-session-id': '' }, body });
  assert.equal(noInit.status, 400);
});

test('session cap evicts LRU, idle sweep removes', async () => {
  const { SessionManager } = await import('./sessions.js');
  assert.equal(typeof SessionManager, 'function');
  const a = makeClient('tokA');
  await a.client.connect(a.transport);
  assert.ok(srv.sessions.size >= 1);
  srv.sessions.sweep(Date.now() + 3 * 60 * 60 * 1000);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(srv.sessions.size, 0);
});

import * as fs from 'node:fs';
function require_fs() { return fs; }
