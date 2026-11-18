import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from './index.js';

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
