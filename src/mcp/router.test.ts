import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRouter } from './router.js';
import { textResult, type ToolDef } from '../tools/types.js';

const own = (name: string): ToolDef => ({ name, description: 'd', inputSchema: { type: 'object' }, risk: 'read', handler: async () => textResult('ok') });
const mk = (ownTools: ToolDef[], engineNames: string[], take = () => ({ ok: true, retryAfterSec: 0 })) => {
  const audit: any[] = [];
  const router = new ToolRouter({
    engine: {
      listTools: () => engineNames.map((name) => ({ name, inputSchema: { type: 'object' as const } })),
      callTool: async () => textResult('eng'),
    },
    policy: {
      engineToolMeta: (name) => ({ name, risk: 'read', pathArgs: [], source: 'engine' }),
      isVisible: (m) => m.name !== 'hidden',
      check: (m, args) => (m.name === 'bad' ? { ok: false, reason: 'nope' } : { ok: true, args }),
    },
    limiter: { take },
    audit: { record: (e) => audit.push(e) },
    ownTools, getAllowedDirectories: () => [], stateDir: '.',
  });
  return { router, audit };
};

test('collision between engine and own tool throws', () => {
  assert.throws(() => mk([own('read_file')], ['read_file']));
  assert.throws(() => mk([own('a'), own('a')], []));
});
test('visibility, deny, unknown, rate limit', async () => {
  const { router, audit } = mk([own('desktop_x'), own('hidden')], ['bad', 'e1']);
  assert.deepEqual(router.list().map((t) => t.name).sort(), ['bad', 'desktop_x', 'e1']);
  const s = new AbortController().signal;
  assert.equal((await router.call('bad', {}, 'c', s)).isError, true);
  assert.equal((await router.call('zzz', {}, 'c', s)).isError, true);
  assert.equal((await router.call('e1', {}, 'c', s)).isError, undefined);
  assert.equal(audit.find((a) => a.tool === 'bad').decision, 'denied');
  const rl = mk([own('desktop_x')], [], () => ({ ok: false, retryAfterSec: 7 }));
  const r = await rl.router.call('desktop_x', {}, 'c', s);
  assert.match((r.content[0] as any).text, /7/);
});
