import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { desktopTools } from './index.js';
import { hooks, parsePsOutput, PsError, WINDOWS_ONLY, type PsRunner } from './ps.js';
import { ALL_SCRIPTS, NATIVE_CS } from './scripts.js';

const ctx = { allowedDirectories: [], signal: new AbortController().signal, stateDir: '/tmp' };
const EXPECTED: Record<string, string> = {
  desktop_screenshot: 'read',
  desktop_ocr: 'read',
  desktop_list_monitors: 'read',
  desktop_list_windows: 'read',
  desktop_window: 'control',
  desktop_mouse: 'control',
  desktop_keyboard: 'control',
  desktop_clipboard_get: 'read',
  desktop_clipboard_set: 'control',
  desktop_open: 'exec',
  desktop_system_info: 'read',
  desktop_notify: 'control',
  desktop_wait: 'read',
};

const origWin = hooks.isWindows;
const origRun = hooks.run;
afterEach(() => {
  hooks.isWindows = origWin;
  hooks.run = origRun;
});

describe('tool definitions', () => {
  const tools = desktopTools();
  it('exposes exactly the expected tools with expected risk', () => {
    assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(EXPECTED).sort());
    for (const t of tools) assert.equal(t.risk, EXPECTED[t.name], t.name);
  });
  it('has valid schema and good descriptions', () => {
    const names = new Set<string>();
    for (const t of tools) {
      assert.match(t.name, /^desktop_[a-z_]+$/);
      assert.ok(!names.has(t.name));
      names.add(t.name);
      assert.ok(t.description.length >= 60, `${t.name} description too short`);
      assert.equal(t.inputSchema.type, 'object');
      for (const r of t.inputSchema.required ?? []) {
        assert.ok(r in (t.inputSchema.properties ?? {}), `${t.name}: required ${r} missing in properties`);
      }
      assert.ok(['read', 'write', 'exec', 'control'].includes(t.risk));
      assert.equal(typeof t.handler, 'function');
      assert.equal(t.pathArgs, undefined);
      JSON.stringify(t.inputSchema);
    }
  });
  it('mentions coordinate system and workflow where relevant', () => {
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ['desktop_screenshot', 'desktop_mouse', 'desktop_ocr']) {
      assert.match(by[n]!.description, /screen/i);
      assert.match(by[n]!.description, /pixel|coordinate/i);
    }
    assert.match(by['desktop_screenshot']!.description, /verify|screenshot/i);
  });
});

describe('desktop_open policy flags', () => {
  it('declares target+args as command text so PolicyEngine guards them', () => {
    const open = desktopTools().find((t) => t.name === 'desktop_open')!;
    assert.deepEqual(open.commandArgs, ['target', 'args']);
  });
});

describe('non-Windows', () => {
  it('every handler returns the Windows-only error', async () => {
    hooks.isWindows = () => false;
    let called = false;
    hooks.run = async () => {
      called = true;
      return {};
    };
    for (const t of desktopTools()) {
      const r = await t.handler({}, ctx);
      assert.equal(r.isError, true, t.name);
      assert.deepEqual(r.content, [{ type: 'text', text: WINDOWS_ONLY }]);
    }
    assert.equal(called, false);
  });
  it('real platform on this CI is not win32 (or handlers still safe)', async () => {
    if (process.platform === 'win32') return;
    const r = await desktopTools()[0]!.handler({}, ctx);
    assert.equal(r.isError, true);
  });
});

describe('script safety', () => {
  const EVIL = `'; Remove-Item C:\\* -Recurse; "$(calc.exe)" \`whoami\` @" "@ $env:USERNAME`;

  it('scripts are ASCII only and never contain interpolation of args', () => {
    for (const [name, s] of Object.entries(ALL_SCRIPTS)) {
      // eslint-disable-next-line no-control-regex
      assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s), `${name} has non-ASCII characters`);
      assert.ok(!s.includes('${'), `${name} contains \${`);
      assert.ok(s.includes('$env:NEO_ARGS'), name);
      assert.ok(!/Invoke-Expression|\biex\b/i.test(s), `${name} uses Invoke-Expression`);
      assert.ok(s.trimEnd().endsWith('}'), `${name} must end with the catch block`);
    }
  });

  it('C# is C# 5 compatible', () => {
    assert.ok(!/\$"/.test(NATIVE_CS), 'string interpolation');
    assert.ok(!/=>/.test(NATIVE_CS), 'lambda / expression-bodied member');
    assert.ok(!/out var /.test(NATIVE_CS), 'out var');
    assert.ok(!/\?\./.test(NATIVE_CS), 'null-conditional');
    assert.ok(!/nameof\(/.test(NATIVE_CS));
    assert.ok(!NATIVE_CS.includes('\n@'), 'here-string terminator hazard');
    assert.ok(!/^'@/m.test(NATIVE_CS), "'@ at line start would end the here-string");
  });

  it('PowerShell 5.1 hazards are absent', () => {
    for (const [name, s] of Object.entries(ALL_SCRIPTS)) {
      assert.ok(!/\?\?/.test(s), `${name}: ?? operator`);
      assert.ok(!/-Parallel/.test(s), `${name}: -Parallel`);
    }
  });

  it('user input only reaches the runner as the JSON input, never inside script text', async () => {
    hooks.isWindows = () => true;
    const seen: { script: string; input: unknown }[] = [];
    const stub: PsRunner = async (script, input) => {
      seen.push({ script, input });
      return {
        b64: 'AAAA', mime: 'image/png', x: 0, y: 0, width: 10, height: 10, outWidth: 10, outHeight: 10, source: 's',
        lines: [], windows: [], text: '', files: [], ok: true,
      };
    };
    hooks.run = stub;
    const tools = Object.fromEntries(desktopTools().map((t) => [t.name, t]));
    const calls: [string, Record<string, unknown>][] = [
      ['desktop_screenshot', { window: EVIL }],
      ['desktop_ocr', { window: EVIL, find: EVIL }],
      ['desktop_list_windows', { filter: EVIL }],
      ['desktop_window', { action: 'focus', title: EVIL }],
      ['desktop_keyboard', { action: 'type', text: EVIL }],
      ['desktop_clipboard_set', { text: EVIL }],
      ['desktop_open', { target: EVIL.replace(/^'/, 'x'), args: [EVIL] }],
      ['desktop_notify', { title: 'hi', message: EVIL }],
    ];
    for (const [name, args] of calls) {
      const before = seen.length;
      await tools[name]!.handler(args, ctx);
      assert.equal(seen.length, before + 1, `${name} did not call the runner`);
      const { script, input } = seen[seen.length - 1]!;
      assert.ok(!script.includes('Remove-Item'), `${name}: user text leaked into script`);
      assert.ok(!script.includes('whoami'), name);
      assert.ok(JSON.stringify(input).includes('Remove-Item'), `${name}: input should carry the user text`);
    }
    // the evil text really was carried in the JSON input
    const kb = seen.find((s) => s.script.includes("kind -eq 'type'"))!;
    assert.equal((kb.input as { text: string }).text, EVIL);
  });

  it('invalid args are rejected before the runner is called', async () => {
    hooks.isWindows = () => true;
    let called = 0;
    hooks.run = async () => {
      called++;
      return {};
    };
    const tools = Object.fromEntries(desktopTools().map((t) => [t.name, t]));
    for (const [name, args] of [
      ['desktop_mouse', { action: 'click', x: 'abc', y: 1 }],
      ['desktop_keyboard', { action: 'hotkey', keys: 'ctrl+nope' }],
      ['desktop_window', { action: 'focus' }],
      ['desktop_wait', { ms: -5 }],
    ] as const) {
      const r = await tools[name]!.handler({ ...args }, ctx);
      assert.equal(r.isError, true, name);
    }
    assert.equal(called, 0);
  });

  it('screenshot handler builds a caption with scale and offset', async () => {
    hooks.isWindows = () => true;
    hooks.run = async () => ({ b64: 'QUJD', mime: 'image/jpeg', x: -1920, y: 0, width: 1920, height: 1080, outWidth: 960, outHeight: 540, source: 'monitor 1' });
    const r = await desktopTools().find((t) => t.name === 'desktop_screenshot')!.handler({}, ctx);
    assert.equal(r.isError, undefined);
    assert.equal(r.content[0]!.type, 'image');
    const cap = (r.content[1] as { text: string }).text;
    assert.match(cap, /960x540/);
    assert.match(cap, /\(-1920, 0\)/);
    assert.match(cap, /0\.5000/);
  });

  it('desktop_wait works on the Windows path and aborts', async () => {
    hooks.isWindows = () => true;
    const t = desktopTools().find((x) => x.name === 'desktop_wait')!;
    const t0 = Date.now();
    const r = await t.handler({ ms: 30 }, ctx);
    assert.ok(Date.now() - t0 >= 25);
    assert.match((r.content[0] as { text: string }).text, /Waited 30 ms/);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const t1 = Date.now();
    await t.handler({ ms: 20000 }, { ...ctx, signal: ac.signal });
    assert.ok(Date.now() - t1 < 2000);
  });
});

describe('PowerShell output parsing', () => {
  it('parses last JSON line, strips BOM, ignores noise', () => {
    const o = parsePsOutput('\uFEFFnoise\n{"a":1}\r\n', '', 0);
    assert.deepEqual(o, { a: 1 });
  });
  it('turns neoError into PsError', () => {
    assert.throws(() => parsePsOutput('{"neoError":"boom"}', '', 0), (e) => e instanceof PsError && e.message === 'boom');
  });
  it('reports stderr when no JSON', () => {
    assert.throws(() => parsePsOutput('', 'syntax error', 1), /syntax error/);
  });
});
