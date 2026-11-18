import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import vm from 'node:vm';
import { desktopTools } from './index.js';
import { accessibilityMessage, macHooks, MacError, parseJxaOutput, screenRecordingMessage, type ExecResult } from './mac-exec.js';
import { ALL_MAC_SCRIPTS, SCRIPT_GEOMETRY, SCRIPT_KEYBOARD, SCRIPT_PASTE, SCRIPT_MOUSE, SCRIPT_NOTIFY, SCRIPT_OCR, SCRIPT_WINDOW } from './mac-scripts.js';
import { openHooks, screenshotCaption, visionLines } from './mac-tools.js';
import { hooks, WINDOWS_ONLY, type PsRunner } from './ps.js';

const ctx = { allowedDirectories: [], signal: new AbortController().signal, stateDir: '/tmp' };
const EVIL = `'; do shell script "rm -rf /"; $(whoami) \`id\` " \\ "; tell application "Finder" to quit; //`;

const origMac = hooks.isMac;
const origWin = hooks.isWindows;
const origRun = hooks.run;
const orig = { exec: macHooks.exec, runJxa: macHooks.runJxa, sleep: macHooks.sleep };
const origSpawn = openHooks.spawnDetached;
afterEach(() => {
  hooks.isMac = origMac;
  hooks.isWindows = origWin;
  hooks.run = origRun;
  macHooks.exec = orig.exec;
  macHooks.runJxa = orig.runJxa;
  macHooks.sleep = orig.sleep;
  openHooks.spawnDetached = origSpawn;
});
beforeEach(() => {
  hooks.isWindows = () => false;
  hooks.isMac = () => true;
  macHooks.sleep = async () => undefined;
});

const tool = (name: string) => desktopTools('darwin').find((t) => t.name === name)!;
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

const GEO = {
  screens: [
    { frame: { x: 0, y: 0, width: 1512, height: 982 }, visible: { x: 0, y: 0, width: 1512, height: 920 }, scale: 2, name: 'Built-in' },
    { frame: { x: -1920, y: -98, width: 1920, height: 1080 }, visible: { x: -1920, y: -98, width: 1920, height: 1080 }, scale: 1, name: 'LG' },
  ],
  cursor: { x: 100, y: 200 },
  ax: true,
  screen: true,
  frontPid: 7,
  windows: [
    { id: 42, pid: 7, owner: 'Safari', title: 'Apple', x: 100, y: 80, w: 900, h: 700, layer: 0, onscreen: true, alpha: 1 },
    { id: 50, pid: 9, owner: 'Notes', title: 'Note', x: 0, y: 0, w: 300, h: 300, layer: 0, onscreen: false, alpha: 1 },
  ],
};

function pngBuffer(w: number, h: number): Buffer {
  const b = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

interface Call {
  script?: string;
  input?: unknown;
  file?: string;
  args?: string[];
  opts?: unknown;
}

/** Stub both runners. `jxa` maps script -> result; `execs` records command lines. */
function stub(jxa: (script: string, input: unknown) => Record<string, unknown> | Error, nativePx = { w: 3024, h: 1964 }) {
  const calls: Call[] = [];
  macHooks.runJxa = async (script, input) => {
    calls.push({ script, input });
    const r = jxa(script, input);
    if (r instanceof Error) throw r;
    return r;
  };
  macHooks.exec = async (file, args, opts): Promise<ExecResult> => {
    calls.push({ file, args, opts });
    const ok = (s = ''): ExecResult => ({ stdout: Buffer.from(s), stderr: '', code: 0 });
    if (file.endsWith('screencapture')) {
      writeFileSync(args[args.length - 1]!, pngBuffer(nativePx.w, nativePx.h));
      return ok();
    }
    if (file.endsWith('sips')) {
      if (args[0] === '-g') return ok(`${args[args.length - 1]}\n  pixelWidth: 1600\n  pixelHeight: 1039\n`);
      writeFileSync(args[args.length - 1]!, Buffer.from('IMG'));
      return ok();
    }
    if (file.endsWith('pbpaste')) return ok('héllo ğ');
    return ok();
  };
  return calls;
}

const geoOnly = (script: string): Record<string, unknown> | undefined => (script === SCRIPT_GEOMETRY ? (GEO as unknown as Record<string, unknown>) : undefined);

describe('platform dispatch', () => {
  it('darwin picks the mac implementation and never touches PowerShell', async () => {
    let psCalled = false;
    hooks.run = (async () => {
      psCalled = true;
      return {};
    }) as PsRunner;
    const calls = stub((s) => geoOnly(s) ?? { ok: true });
    const r = await tool('desktop_list_monitors').handler({}, ctx);
    assert.equal(r.isError, undefined);
    assert.equal(psCalled, false);
    assert.equal(calls.length, 1);
    const o = JSON.parse(textOf(r));
    assert.equal(o.units, 'points');
    assert.equal(o.monitors.length, 2);
    assert.deepEqual(o.virtualScreen, { x: -1920, y: 0, width: 3432, height: 1080 });
    assert.equal(o.monitors[1].x, -1920);
    assert.equal(o.monitors[0].pixelWidth, 3024);
  });
  it('windows still dispatches to PowerShell, not to macOS code', async () => {
    hooks.isWindows = () => true;
    hooks.isMac = () => true;
    let jxaCalled = false;
    macHooks.runJxa = async () => {
      jxaCalled = true;
      return {};
    };
    hooks.run = (async () => ({ windows: [], monitors: [], virtualScreen: {}, cursor: {} })) as PsRunner;
    await tool('desktop_list_monitors').handler({}, ctx);
    assert.equal(jxaCalled, false);
  });
  it('other platforms get the unsupported error (now mentioning macOS)', async () => {
    hooks.isMac = () => false;
    const r = await tool('desktop_list_monitors').handler({}, ctx);
    assert.equal(r.isError, true);
    assert.equal(textOf(r), WINDOWS_ONLY);
    assert.match(WINDOWS_ONLY, /macOS/);
  });
  it('wait works unchanged on macOS', async () => {
    const r = await tool('desktop_wait').handler({ ms: 5 }, ctx);
    assert.match(textOf(r), /Waited 5 ms/);
  });
});

/** Property descriptions legitimately differ per OS (points vs pixels, etc.); everything else must be identical. */
function stripDescriptions(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripDescriptions);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, x]) => !(k === 'description' && typeof x === 'string')).map(([k, x]) => [k, stripDescriptions(x)]));
  }
  return v;
}

describe('tool contract parity', () => {
  it('same names, schemas, risk and policy flags on both platforms; descriptions follow the OS', () => {
    const win = desktopTools('win32');
    const mac = desktopTools('darwin');
    assert.deepEqual(mac.map((t) => t.name), win.map((t) => t.name));
    for (let i = 0; i < win.length; i++) {
      assert.deepEqual(stripDescriptions(mac[i]!.inputSchema), stripDescriptions(win[i]!.inputSchema), win[i]!.name);
      assert.equal(mac[i]!.risk, win[i]!.risk);
      assert.deepEqual(mac[i]!.commandArgs, win[i]!.commandArgs);
      assert.deepEqual(mac[i]!.annotations, win[i]!.annotations);
    }
    const by = (l: typeof mac) => Object.fromEntries(l.map((t) => [t.name, t.description]));
    assert.match(by(mac)['desktop_mouse']!, /points/i);
    assert.match(by(mac)['desktop_mouse']!, /cmd/);
    assert.match(by(mac)['desktop_keyboard']!, /cmd\+c/);
    assert.match(by(mac)['desktop_screenshot']!, /Screen Recording/);
    assert.match(by(mac)['desktop_ocr']!, /Vision/);
    assert.match(by(win)['desktop_mouse']!, /SendInput/);
    assert.ok(!/Windows/.test(by(mac)['desktop_clipboard_get']!));
    assert.match(by(mac)['desktop_system_info']!, /Accessibility/);
  });
  it('default platform follows hooks.isMac', () => {
    hooks.isMac = () => true;
    assert.match(desktopTools().find((t) => t.name === 'desktop_clipboard_get')!.description, /macOS/);
    hooks.isMac = () => false;
    assert.match(desktopTools().find((t) => t.name === 'desktop_clipboard_get')!.description, /Windows/);
  });
});

describe('JXA script safety', () => {
  it('scripts are constant, ASCII, read only NEO_ARGS and never interpolate input', () => {
    for (const [name, s] of Object.entries(ALL_MAC_SCRIPTS)) {
      // eslint-disable-next-line no-control-regex
      assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(s), `${name} has non-ASCII characters`);
      assert.ok(s.includes("objectForKey('NEO_ARGS')"), name);
      assert.ok(!s.includes('${'), `${name} contains \${`);
      assert.ok(!/\beval\s*\(|new Function|doShellScript|\.run\(\s*['"`]/.test(s), `${name} evaluates dynamic code`);
      assert.ok(!/\bdo shell script\b/i.test(s), name);
      assert.ok(s.includes('function main()'), name);
    }
  });
  it('every script parses as JavaScript', () => {
    for (const [name, s] of Object.entries(ALL_MAC_SCRIPTS)) {
      assert.doesNotThrow(() => new vm.Script(s, { filename: `${name}.js` }), name);
    }
  });
  it('uses only ES5 declarations (no let/const/arrow/template) for old JavaScriptCore safety', () => {
    for (const [name, s] of Object.entries(ALL_MAC_SCRIPTS)) {
      assert.ok(!/\b(let|const)\s/.test(s), `${name}: let/const`);
      assert.ok(!/=>/.test(s), `${name}: arrow function`);
      assert.ok(!/`/.test(s), `${name}: template literal`);
    }
  });

  /** Runs a script body against a permissive fake of the ObjC bridge: catches typos / undefined identifiers. */
  function sandbox(script: string, args: unknown): Record<string, unknown> {
    const mk = (): unknown => {
      const fn = function () {};
      const p: unknown = new Proxy(fn, {
        get(_t, k) {
          if (k === Symbol.toPrimitive) return () => 0;
          if (k === 'length' || k === 'count') return 0;
          if (k === 'then') return undefined;
          return p;
        },
        apply: () => p,
        construct: () => p as object,
      });
      return p;
    };
    const generic = mk();
    const $ = new Proxy(function () {}, {
      get(_t, k) {
        if (k === 'NSProcessInfo') return { processInfo: { environment: { objectForKey: () => 'ENVTOKEN' } } };
        return generic;
      },
      apply: () => generic,
    });
    const ObjC = {
      import() {},
      unwrap: (x: unknown) => (x === 'ENVTOKEN' ? JSON.stringify(args) : generic),
      deepUnwrap: () => [],
      castRefToObject: (x: unknown) => x,
      bindFunction() {},
    };
    const sb = { $, ObjC, Application: generic, Ref: () => generic, Math, JSON, String, Number, Array, Object, parseInt };
    const out = vm.runInNewContext(script + '\n;run();', sb, { timeout: 5000 }) as string;
    return JSON.parse(out) as Record<string, unknown>;
  }

  it('scripts run end-to-end against a fake bridge without reference errors', () => {
    const cases: [string, string, unknown][] = [
      ['geometry', SCRIPT_GEOMETRY, { windows: true }],
      ['mouse click', SCRIPT_MOUSE, { kind: 'click', x: 5, y: 6, flags: 0x100000 }],
      ['mouse double', SCRIPT_MOUSE, { kind: 'double_click' }],
      ['mouse right', SCRIPT_MOUSE, { kind: 'right_click', x: 1, y: 1 }],
      ['mouse drag', SCRIPT_MOUSE, { kind: 'drag', x: 1, y: 1, toX: 50, toY: 60 }],
      ['mouse scroll', SCRIPT_MOUSE, { kind: 'scroll', amount: -3 }],
      ['mouse hscroll', SCRIPT_MOUSE, { kind: 'scroll', amount: 2, horizontal: true }],
      ['mouse position', SCRIPT_MOUSE, { kind: 'position' }],
      ['kbd type', SCRIPT_KEYBOARD, { kind: 'type', text: 'a\r\nb\tğ😀', delay: 1 }],
      ['kbd events', SCRIPT_KEYBOARD, { kind: 'hotkey', events: [{ t: 'key', code: 8, down: true, flags: 1 }, { t: 'aux', aux: 0, down: true }], delay: 0 }],
      ['window focus', SCRIPT_WINDOW, { action: 'focus', pid: 7, bx: 0, by: 0, bw: 100, bh: 100, title: 't' }],
      ['ocr', SCRIPT_OCR, { imagePath: '/tmp/x.png', languages: ['en-US'], autoDetect: true }],
      ['notify', SCRIPT_NOTIFY, { title: 't', message: 'm' }],
    ];
    for (const [name, script, args] of cases) {
      const r = sandbox(script, args);
      const err = typeof r['neoError'] === 'string' ? (r['neoError'] as string) : '';
      assert.ok(!/ReferenceError|is not defined|SyntaxError|undefined is not/.test(err), `${name}: ${err}`);
    }
    // sanity: a script that cannot find a window reports a structured code, not a crash
    assert.equal(sandbox(SCRIPT_WINDOW, { action: 'close', pid: 1, bx: 0, by: 0, bw: 1, bh: 1 })['neoCode'], 'NO_WINDOW');
  });

  it('user text never appears in script text; it only travels in the input / argv', async () => {
    const calls = stub((s) => geoOnly(s) ?? { ok: true, action: 'x', hasText: true, files: [], lines: [], x: 0, y: 0 });
    const t = (n: string, a: Record<string, unknown>) => tool(n).handler(a, ctx);
    await t('desktop_keyboard', { action: 'type', text: EVIL });
    await t('desktop_notify', { title: 'hi', message: EVIL });
    await t('desktop_window', { action: 'focus', title: 'Apple' });
    await t('desktop_screenshot', { window: 'Apple' });
    await t('desktop_ocr', { window: 'Apple', find: EVIL });
    await t('desktop_clipboard_set', { text: EVIL });
    await t('desktop_open', { target: 'Safari', args: [EVIL] });
    for (const c of calls) {
      if (c.script) {
        assert.ok(!c.script.includes('rm -rf'), 'script text contains user input');
        assert.ok(!c.script.includes('whoami'));
      }
    }
    const kb = calls.find((c) => c.script === SCRIPT_KEYBOARD)!;
    assert.equal((kb.input as { text: string }).text, EVIL);
    const nt = calls.find((c) => c.script === SCRIPT_NOTIFY)!;
    assert.equal((nt.input as { message: string }).message, EVIL);
    // external commands receive user text as separate argv items / stdin, never through a shell
    const pb = calls.find((c) => c.file === '/usr/bin/pbcopy')!;
    assert.equal((pb.opts as { input: string }).input, EVIL);
    const op = calls.find((c) => c.file === '/usr/bin/open')!;
    assert.deepEqual(op.args, ['-a', 'Safari', '--args', EVIL]);
    for (const c of calls) assert.ok(!c.file || !/sh$/.test(c.file), `shell used: ${c.file}`);
  });
});

describe('JXA output parsing and permission errors', () => {
  it('parses the last JSON line from stdout or stderr and ignores noise', () => {
    assert.deepEqual(parseJxaOutput('noise\n{"a":1}\n', '', 0), { a: 1 });
    assert.deepEqual(parseJxaOutput('', 'warning\n{"b":2}', 0), { b: 2 });
    assert.throws(() => parseJxaOutput('', 'syntax error: boom', 1), /boom/);
  });
  it('maps permission codes to bilingual instructions naming the pane and the app', () => {
    for (const [code, pane, tr] of [
      ['PERM_AX', 'Privacy_Accessibility', 'Erişilebilirlik'],
      ['PERM_SCREEN', 'Privacy_ScreenCapture', 'Ekran Kaydı'],
    ] as const) {
      try {
        parseJxaOutput(JSON.stringify({ neoError: code, neoCode: code }), '', 0);
        assert.fail('should throw');
      } catch (e) {
        assert.ok(e instanceof MacError);
        assert.equal(e.code, code);
        assert.match(e.message, new RegExp(pane));
        assert.match(e.message, new RegExp(tr));
        assert.match(e.message, /System Settings/);
      }
    }
    assert.match(accessibilityMessage('Neo Commander'), /"Neo Commander"/);
    assert.match(screenRecordingMessage('Neo Commander'), /"Neo Commander"/);
  });
  it('mouse without Accessibility returns the error text, not a crash', async () => {
    stub((s) => (s === SCRIPT_MOUSE ? new MacError(accessibilityMessage(), 'PERM_AX') : (geoOnly(s) ?? {})));
    const r = await tool('desktop_mouse').handler({ action: 'click', x: 1, y: 1 }, ctx);
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Accessibility/);
    assert.match(textOf(r), /Erişilebilirlik/);
  });
  it('screenshot / ocr without Screen Recording fail before capturing anything', async () => {
    const calls = stub((s) => (s === SCRIPT_GEOMETRY ? ({ ...GEO, screen: false } as unknown as Record<string, unknown>) : {}));
    for (const n of ['desktop_screenshot', 'desktop_ocr']) {
      const r = await tool(n).handler({}, ctx);
      assert.equal(r.isError, true, n);
      assert.match(textOf(r), /Screen Recording/);
      assert.match(textOf(r), /Ekran Kaydı/);
    }
    assert.ok(!calls.some((c) => c.file?.endsWith('screencapture')));
  });
  it('invalid args are rejected before any process runs', async () => {
    const calls = stub(() => ({}));
    for (const [n, a] of [
      ['desktop_mouse', { action: 'click', x: 'abc', y: 1 }],
      ['desktop_keyboard', { action: 'hotkey', keys: 'cmd+nope' }],
      ['desktop_window', { action: 'focus' }],
      ['desktop_open', { target: '-a' }],
    ] as const) {
      const r = await tool(n).handler({ ...a }, ctx);
      assert.equal(r.isError, true, n);
    }
    assert.equal(calls.length, 0);
  });
});

describe('screenshot', () => {
  it('Retina: downscales with sips and reports a caption in points with the right scale/offset', async () => {
    const calls = stub((s) => geoOnly(s) ?? {});
    const r = await tool('desktop_screenshot').handler({}, ctx);
    assert.equal(r.isError, undefined);
    assert.equal(r.content[0]!.type, 'image');
    assert.equal((r.content[0] as { mimeType: string }).mimeType, 'image/jpeg');
    const cap = textOf(r);
    assert.match(cap, /1600x1039px/);
    assert.match(cap, /1512x982 screen points \(3024x1964 native pixels, backing scale 2\.00\)/);
    assert.match(cap, /offset \(0, 0\)/);
    assert.match(cap, /Scale: 1\.0582/);
    const sc = calls.find((c) => c.file?.endsWith('screencapture'))!;
    assert.deepEqual(sc.args!.slice(0, 5), ['-x', '-t', 'png', '-R', '0,0,1512,982']);
    const sips = calls.find((c) => c.file?.endsWith('sips') && c.args![0] === '-s')!;
    assert.ok(sips.args!.includes('--resampleWidth') && sips.args!.includes('1600'));
    assert.deepEqual(sips.args!.slice(0, 6), ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80']);
  });
  it('second monitor at negative offset: -R uses CG coordinates and the caption shows them', async () => {
    const calls = stub((s) => geoOnly(s) ?? {}, { w: 1920, h: 1080 });
    const r = await tool('desktop_screenshot').handler({ monitor: 1, format: 'png', maxWidth: 1920 }, ctx);
    assert.equal(r.isError, undefined);
    assert.match(textOf(r), /offset \(-1920, 0\)/);
    assert.match(textOf(r), /1920x1080 screen points/);
    assert.ok(!calls.some((c) => c.file?.endsWith('sips')), 'png at native size needs no sips');
    assert.ok(calls.find((c) => c.file?.endsWith('screencapture'))!.args!.includes('-1920,0,1920,1080'));
  });
  it('window capture uses -l id', async () => {
    const calls = stub((s) => geoOnly(s) ?? {});
    const r = await tool('desktop_screenshot').handler({ window: 'apple', format: 'png' }, ctx);
    assert.equal(r.isError, undefined);
    assert.match(textOf(r), /window: Apple/);
    assert.match(textOf(r), /offset \(100, 80\)/);
    assert.ok(calls.find((c) => c.file?.endsWith('screencapture'))!.args!.join(' ').includes('-o -l 42'));
  });
  it('caption formula maps image pixels back to points', () => {
    const c = screenshotCaption({ source: 's', width: 100, height: 50, x: 10, y: 20, outW: 200, outH: 100, nativeW: 200, nativeH: 100 });
    assert.match(c, /Scale: 2\.0000/);
    assert.match(c, /screenX = 10 \+ imageX \/ 2\.0000/);
  });
});

describe('ocr', () => {
  it('converts Vision boxes to screen points and supports find with center points', async () => {
    const lines = [
      {
        text: 'Save File',
        nx: 0.1, ny: 0.8, nw: 0.2, nh: 0.05,
        words: [
          { text: 'Save', nx: 0.1, ny: 0.8, nw: 0.08, nh: 0.05 },
          { text: 'File', nx: 0.2, ny: 0.8, nw: 0.1, nh: 0.05 },
        ],
      },
    ];
    stub((s) => (s === SCRIPT_OCR ? { language: 'en-US', lines } : (geoOnly(s) ?? {})));
    const all = JSON.parse(textOf(await tool('desktop_ocr').handler({}, ctx)));
    assert.equal(all.lineCount, 1);
    assert.deepEqual(all.lines[0], { text: 'Save File', x: 151, y: 147, width: 302, height: 49 });
    assert.deepEqual(all.region, { x: 0, y: 0, width: 1512, height: 982 });
    const found = JSON.parse(textOf(await tool('desktop_ocr').handler({ find: 'file' }, ctx)));
    assert.equal(found.matchCount, 1);
    assert.equal(found.matches[0].matchedText, 'File');
    const m = found.matches[0];
    assert.deepEqual([m.x, m.y, m.width, m.height], [302, 147, 151, 49]);
    assert.equal(m.centerX, Math.round(m.x + m.width / 2));
    assert.equal(m.centerY, Math.round(m.y + m.height / 2));
  });
  it('visionLines sorts top-to-bottom and tolerates empty input', () => {
    assert.deepEqual(visionLines(undefined, { x: 0, y: 0, width: 10, height: 10 }), []);
    const l = visionLines(
      [
        { text: 'bottom', nx: 0, ny: 0, nw: 1, nh: 0.1, words: [] },
        { text: 'top', nx: 0, ny: 0.9, nw: 1, nh: 0.1, words: [] },
      ],
      { x: 0, y: 0, width: 100, height: 100 },
    );
    assert.deepEqual(l.map((x) => x.text), ['top', 'bottom']);
  });
});

describe('input, windows, clipboard, open, system info', () => {
  it('mouse passes points and CGEventFlags to the script', async () => {
    const calls = stub((s) => (s === SCRIPT_MOUSE ? { action: 'click', x: 10, y: 20 } : {}));
    const r = await tool('desktop_mouse').handler({ action: 'click', x: 10, y: 20, modifiers: ['cmd'] }, ctx);
    assert.deepEqual(JSON.parse(textOf(r)), { action: 'click', x: 10, y: 20 });
    assert.deepEqual(calls[0]!.input, { kind: 'click', x: 10, y: 20, flags: 0x100000 });
  });
  it('keyboard falls back to clipboard paste when JXA cannot bridge the Unicode call', async () => {
    const calls = stub((s, input) =>
      s === SCRIPT_KEYBOARD && (input as { kind: string }).kind === 'type' ? new MacError('bridge', 'UNICODE_BRIDGE') : { action: 'hotkey', events: 4 },
    );
    const r = await tool('desktop_keyboard').handler({ action: 'type', text: 'Merhaba ğ' }, ctx);
    assert.equal(r.isError, undefined);
    assert.equal(JSON.parse(textOf(r)).method, 'paste');
    // No pbpaste/pbcopy: a text-only snapshot would lose images/files/rich text. One JXA run does it all.
    assert.equal(calls.filter((c) => c.file === '/usr/bin/pbcopy' || c.file === '/usr/bin/pbpaste').length, 0);
    const paste = calls.filter((c) => c.script === SCRIPT_PASTE);
    assert.equal(paste.length, 1);
    const pin = paste[0]!.input as { text: string; events: unknown[] };
    assert.equal(pin.text, 'Merhaba ğ');
    assert.equal(pin.events.length, 4);
  });
  it('SCRIPT_PASTE restores every pasteboard item/type and marks the temp item concealed + transient', () => {
    const run = (initial: { type: string; data: string }[][], clipboardChangesDuringPaste = false) => {
      type Entry = { type: string; data: string };
      const state = { items: initial.map((i) => i.map((e) => ({ ...e }))) as Entry[][], changeCount: 1, posted: 0, snapshotDuringPaste: [] as Entry[][] };
      class Item {
        entries: Entry[] = [];
        get types() { return { count: this.entries.length, objectAtIndex: (i: number) => this.entries[i]!.type }; }
        dataForType(t: string) { const e = this.entries.find((x) => x.type === t); return e ? { length: e.data.length, v: e.data } : undefined; }
        setDataForType(d: { v: string }, t: string) { this.entries.push({ type: t, data: d.v }); }
        setStringForType(s: { v: string }, t: string) { this.entries.push({ type: t, data: s.v }); }
      }
      const toItems = () => state.items.map((e) => { const it = new Item(); it.entries = e; return it; });
      const pb = {
        get pasteboardItems() { const its = toItems(); return { count: its.length, objectAtIndex: (i: number) => its[i] }; },
        get clearContents() { state.items = []; state.changeCount++; return 0; },
        writeObjects: (arr: { list: Item[] }) => { state.items = arr.list.map((i) => i.entries); state.changeCount++; return true; },
        get changeCount() { return state.changeCount; },
      };
      const mk = () => ({ list: [] as Item[], addObject(x: Item) { this.list.push(x); } });
      const $: any = (v: unknown) => ({ v });
      Object.assign($, {
        NSProcessInfo: { processInfo: { environment: { objectForKey: () => 'ENV' } } },
        NSThread: { sleepForTimeInterval: () => { if (clipboardChangesDuringPaste) state.changeCount++; } },
        NSPasteboard: { generalPasteboard: pb },
        NSPasteboardItem: { alloc: { get init() { return new Item(); } } },
        NSMutableArray: { alloc: { get init() { return mk(); } } },
        NSArray: { arrayWithObject: (x: Item) => ({ list: [x] }) },
        NSData: { data: { length: 0, v: '' } },
        AXIsProcessTrusted: () => true,
        CGEventCreateKeyboardEvent: () => ({}),
        CGEventSetFlags: () => undefined,
        CGEventPost: () => { state.posted++; state.snapshotDuringPaste = state.items.map((e) => e.map((x) => ({ ...x }))); },
      });
      const ObjC = {
        import() {},
        unwrap: (x: unknown) => (x === 'ENV' ? JSON.stringify({ text: 'SECRET', events: [{ t: 'key', code: 9, down: true, flags: 0x100000 }, { t: 'key', code: 9, down: false, flags: 0x100000 }], delay: 0, settleMs: 0 }) : x),
        deepUnwrap: () => [], castRefToObject: (x: unknown) => x, bindFunction() {},
      };
      const out = vm.runInNewContext(SCRIPT_PASTE + '\n;run();', { $, ObjC, Math, JSON, String, Number, Array, Object }, { timeout: 5000 }) as string;
      return { result: JSON.parse(out) as Record<string, unknown>, state };
    };

    const clip = [
      [{ type: 'public.utf8-plain-text', data: 'hello' }, { type: 'public.html', data: '<b>hello</b>' }, { type: 'public.png', data: 'PNGBYTES' }],
      [{ type: 'public.file-url', data: 'file:///tmp/a' }],
    ];
    const a = run(clip);
    assert.equal(a.result['neoError'], undefined);
    assert.deepEqual(a.state.items, clip, 'all items and all types restored');
    assert.equal(a.state.posted, 2);
    const during = a.state.snapshotDuringPaste;
    assert.equal(during.length, 1);
    const types = during[0]!.map((e) => e.type);
    assert.deepEqual(types.sort(), ['org.nspasteboard.ConcealedType', 'org.nspasteboard.TransientType', 'public.utf8-plain-text']);
    assert.equal(during[0]!.find((e) => e.type === 'public.utf8-plain-text')!.data, 'SECRET');

    // Empty clipboard stays empty afterwards (the secret must not linger).
    const b = run([]);
    assert.deepEqual(b.state.items, []);

    // Something else copied during the paste: do not overwrite it.
    const c = run(clip, true);
    assert.equal(c.state.items.length, 1);
    assert.equal(c.state.items[0]!.find((e) => e.type === 'public.utf8-plain-text')!.data, 'SECRET');
  });
  it('window maximize moves to the work area, restore returns to the previous frame', async () => {
    const calls = stub((s) => (s === SCRIPT_WINDOW ? { ok: true } : (geoOnly(s) ?? {})));
    let r = JSON.parse(textOf(await tool('desktop_window').handler({ action: 'maximize', title: 'apple' }, ctx)));
    assert.equal(r.targetHandle, 42);
    assert.equal(r.window.handle, 42);
    let w = calls.filter((c) => c.script === SCRIPT_WINDOW).pop()!.input as Record<string, unknown>;
    assert.deepEqual([w['action'], w['x'], w['y'], w['width'], w['height']], ['frame', 0, 62, 1512, 920]);
    assert.deepEqual([w['pid'], w['bx'], w['by'], w['bw'], w['bh']], [7, 100, 80, 900, 700]);
    r = JSON.parse(textOf(await tool('desktop_window').handler({ action: 'restore', handle: 42 }, ctx)));
    w = calls.filter((c) => c.script === SCRIPT_WINDOW).pop()!.input as Record<string, unknown>;
    assert.deepEqual([w['action'], w['x'], w['y'], w['width'], w['height']], ['frame', 100, 80, 900, 700]);
    // minimized window: restore un-minimizes; focus reports ok only when the app became frontmost
    await tool('desktop_window').handler({ action: 'restore', handle: 50 }, ctx);
    assert.equal((calls.filter((c) => c.script === SCRIPT_WINDOW).pop()!.input as Record<string, unknown>)['action'], 'unminimize');
    r = JSON.parse(textOf(await tool('desktop_window').handler({ action: 'focus', handle: 50 }, ctx)));
    assert.equal(r.ok, false);
    const bad = await tool('desktop_window').handler({ action: 'close', title: 'nothing-matches' }, ctx);
    assert.equal(bad.isError, true);
  });
  it('list_windows keeps the Windows shape, filters, and notes missing Screen Recording', async () => {
    stub((s) => (s === SCRIPT_GEOMETRY ? ({ ...GEO, screen: false } as unknown as Record<string, unknown>) : {}));
    const o = JSON.parse(textOf(await tool('desktop_list_windows').handler({ include_minimized: false }, ctx)));
    assert.equal(o.count, 1);
    assert.deepEqual(Object.keys(o.windows[0]).sort(), ['focused', 'handle', 'height', 'maximized', 'minimized', 'pid', 'process', 'title', 'width', 'x', 'y']);
    assert.match(o.note, /Screen Recording/);
    const f = JSON.parse(textOf(await tool('desktop_list_windows').handler({ filter: 'notes' }, ctx)));
    assert.equal(f.count, 1);
  });
  it('clipboard get/set via pbpaste/pbcopy with UTF-8 env', async () => {
    const calls = stub((s) => ({ hasText: true, hasImage: true, imageWidth: 10, imageHeight: 5, hasFiles: false, files: [], ...(s ? {} : {}) }));
    const o = JSON.parse(textOf(await tool('desktop_clipboard_get').handler({ maxChars: 3 }, ctx)));
    assert.equal(o.text, 'hé' + 'l');
    assert.equal(o.truncated, true);
    assert.equal(o.totalLength, 7);
    assert.equal(o.hasImage, true);
    assert.equal(o.imageWidth, 10);
    const pb = calls.find((c) => c.file === '/usr/bin/pbpaste')!;
    assert.equal((pb.opts as { env: Record<string, string> }).env['LANG'], 'en_US.UTF-8');
    const set = JSON.parse(textOf(await tool('desktop_clipboard_set').handler({ text: 'ğüş' }, ctx)));
    assert.deepEqual(set, { ok: true, length: 3 });
  });
  it('open: apps, URLs and spawn of executables', async () => {
    const calls = stub(() => ({}));
    let r = JSON.parse(textOf(await tool('desktop_open').handler({ target: 'https://example.com' }, ctx)));
    assert.equal(r.opened, 'https://example.com');
    assert.deepEqual(calls[0]!.args, ['https://example.com']);
    r = JSON.parse(textOf(await tool('desktop_open').handler({ target: 'chrome', args: '--incognito "a b"' }, ctx)));
    assert.deepEqual(calls[1]!.args, ['-a', 'Google Chrome', '--args', '--incognito', 'a b']);
    macHooks.exec = async () => ({ stdout: Buffer.alloc(0), stderr: "Unable to find application named 'Nope'", code: 1 });
    const bad = await tool('desktop_open').handler({ target: 'Nope' }, ctx);
    assert.equal(bad.isError, true);
    assert.match(textOf(bad), /Unable to find application/);
  });
  it('system_info gathers the documented commands and includes permission status', async () => {
    const out: Record<string, string> = {
      sw_vers: 'ProductName:\tmacOS\nProductVersion:\t14.5\nBuildVersion:\t23F79\n',
      'hw.memsize': '17179869184',
      'machdep.cpu.brand_string': 'Apple M2',
      'hw.ncpu': '8',
      'hw.physicalcpu': '8',
      'hw.model': 'Mac14,2',
      'kern.boottime': '{ sec = 1, usec = 0 }',
    };
    const cmds: string[] = [];
    macHooks.runJxa = async () => ({ ...GEO, ax: false } as unknown as Record<string, unknown>);
    macHooks.exec = async (file, args) => {
      cmds.push([file.split('/').pop(), ...args].join(' '));
      const name = file.split('/').pop()!;
      let s = '';
      if (name === 'sw_vers') s = out['sw_vers']!;
      else if (name === 'sysctl') s = out[args[1]!] ?? '';
      else if (name === 'uname') s = 'arm64';
      else if (name === 'vm_stat') s = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000.\n';
      else if (name === 'ps') s = '  PID %CPU RSS COMM\n  1  10.0 2048 /sbin/launchd\n';
      return { stdout: Buffer.from(s), stderr: '', code: 0 };
    };
    const o = JSON.parse(textOf(await tool('desktop_system_info').handler({}, ctx)));
    assert.equal(o.os.name, 'macOS 14.5');
    assert.equal(o.os.architecture, 'arm64');
    assert.equal(o.memory.totalMB, 16384);
    assert.equal(o.cpu.names[0], 'Apple M2');
    assert.equal(o.topProcessesByCpu[0].name, 'launchd');
    assert.equal(o.permissions.accessibility, false);
    assert.equal(o.permissions.screenRecording, true);
    assert.match(o.permissions.note, /Accessibility/);
    for (const c of ['sw_vers', 'sysctl -n hw.memsize', 'vm_stat', 'df -k', 'pmset -g batt', 'ps -Ao pid,pcpu,rss,comm -r', 'ifconfig']) {
      assert.ok(cmds.includes(c), `missing command: ${c}`);
    }
  });
});
