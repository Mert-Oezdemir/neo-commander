import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, buildChildEnv, unpackedPath } from './index.js';

let dir: string;
let engine: Engine;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'neo-engine-'));
  engine = new Engine({ stateDir: dir, backoffMinMs: 200, backoffMaxMs: 1000 });
  await engine.start();
});
after(async () => { await engine.stop(); rmSync(dir, { recursive: true, force: true }); });

const text = (r: any) => (r.content ?? []).map((c: any) => c.text ?? '').join('\n');

test('lists tools', () => {
  const names = engine.listTools().map((t) => t.name);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('start_process'));
  assert.equal(engine.status().state, 'ready');
  assert.equal(engine.status().toolCount, names.length);
});

test('isolated config is used, real home untouched', () => {
  const cfg = join(dir, 'dc-config', '.claude-server-commander', 'config.json');
  assert.ok(existsSync(cfg));
  const c = JSON.parse(readFileSync(cfg, 'utf8'));
  assert.equal(c.telemetryEnabled, false);
  assert.equal(c.fileReadLineLimit, 2000);
});

test('list_directory on temp dir', async () => {
  const r = await engine.callTool('list_directory', { path: dir });
  assert.ok(text(r).includes('dc-config'), text(r));
});

test('start_process echo hi', async () => {
  const r = await engine.callTool('start_process', { command: 'echo hi', timeout_ms: 5000 });
  assert.match(text(r), /hi/);
});

test('restarts after kill', async () => {
  const pid = engine.pid!;
  assert.ok(pid);
  process.kill(pid, 'SIGKILL');
  await new Promise((r) => setTimeout(r, 100));
  await engine.waitReady(30_000);
  assert.notEqual(engine.pid, pid);
  const r = await engine.callTool('list_directory', { path: dir });
  assert.ok(text(r).length > 0);
});

test('child env sets ELECTRON_RUN_AS_NODE only under Electron', () => {
  const base = { PATH: '/x', KEEP: '1' } as NodeJS.ProcessEnv;
  const plain = buildChildEnv(base, '/home/fake', false);
  assert.equal(plain.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(plain.DESKTOP_COMMANDER_DISABLE_TELEMETRY, '1');
  assert.equal(plain.NEO_DC_HOME, '/home/fake');
  assert.equal(plain.KEEP, '1');
  const el = buildChildEnv(base, '/home/fake', true);
  assert.equal(el.ELECTRON_RUN_AS_NODE, '1');
});

test('preload strips ELECTRON_RUN_AS_NODE again inside the child (no leak to user shells)', async () => {
  const d = mkdtempSync(join(tmpdir(), 'neo-engine-el-'));
  const script = join(d, 'fake-dc.mjs');
  // Minimal MCP stdio server whose single tool reports the flag as seen after the preload ran (electron:true set it in the spawn env).
  const sdk = new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url).href;
  writeFileSync(script, `
    import { Server } from '${sdk}server/index.js';
    import { StdioServerTransport } from '${sdk}server/stdio.js';
    import { ListToolsRequestSchema, CallToolRequestSchema } from '${sdk}types.js';
    const s = new Server({ name: 'fake', version: '0' }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'envflag', description: 'x', inputSchema: { type: 'object', properties: {} } }] }));
    s.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'flag=' + String(process.env.ELECTRON_RUN_AS_NODE) }] }));
    await s.connect(new StdioServerTransport());
  `);
  const e = new Engine({ stateDir: d, entry: script, electron: true, backoffMinMs: 200 });
  try {
    await e.start();
    const r = await e.callTool('envflag', {});
    // The preload deletes it after startup (so user shells never inherit it).
    assert.match(text(r), /flag=undefined/);
  } finally { await e.stop(); rmSync(d, { recursive: true, force: true }); }
});

test('unpackedPath maps app.asar files to app.asar.unpacked when they exist', () => {
  const a = '/opt/App/resources/app.asar/node_modules/x/dist/index.js';
  const u = '/opt/App/resources/app.asar.unpacked/node_modules/x/dist/index.js';
  assert.equal(unpackedPath(a, (f) => f === u), u);
  assert.equal(unpackedPath(a, () => false), a);
  assert.equal(unpackedPath('/plain/node_modules/x.js', () => true), '/plain/node_modules/x.js');
  const w = 'C:\\Users\\a\\AppData\\Local\\Programs\\Neo\\resources\\app.asar\\node_modules\\x.js';
  assert.equal(unpackedPath(w, () => true), w.replace('app.asar', 'app.asar.unpacked'));
});
