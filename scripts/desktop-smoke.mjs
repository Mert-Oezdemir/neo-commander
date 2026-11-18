// Smoke test for src/desktop. Run on Windows or macOS after `npm run build`:
//   node scripts/desktop-smoke.mjs
// macOS: steps that need a permission which is not granted (Screen Recording, Accessibility) are reported as SKIP,
// not FAIL, so CI runners without those permissions still pass. Linux: expects the unsupported-platform error.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopTools } from '../dist/desktop/index.js';

const tools = Object.fromEntries(desktopTools().map((t) => [t.name, t]));
const ctx = { allowedDirectories: [], signal: new AbortController().signal, stateDir: tmpdir() };
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
let failed = 0;
let skipped = 0;
const PERM_SCREEN = /Screen Recording|Ekran Kaydı/;
const PERM_AX = /Accessibility permission|Erişilebilirlik izni/;

/** perm: 'screen' | 'ax' - on macOS a matching permission error is a SKIP, not a failure. */
async function step(name, tool, args, check, perm) {
  const t0 = Date.now();
  try {
    const r = await tools[tool].handler(args, ctx);
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) {
      const re = perm === 'screen' ? PERM_SCREEN : perm === 'ax' ? PERM_AX : null;
      if (isMac && re && re.test(text)) {
        skipped++;
        console.log(`SKIP ${name} (${Date.now() - t0} ms) - permission not granted: ${text.split(/[.\n]/)[0]}`);
        return;
      }
      throw new Error(text);
    }
    const detail = check ? await check(r, text) : '';
    console.log(`PASS ${name} (${Date.now() - t0} ms)${detail ? ' - ' + detail : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} (${Date.now() - t0} ms): ${e.message}`);
  }
}

if (!isWin && !isMac) {
  console.log('Not Windows or macOS - expecting the unsupported-platform error from every tool.');
}
if (isMac) console.log('macOS - coordinates are screen points; permission-gated steps are skipped when not granted.');

await step('list_monitors', 'desktop_list_monitors', {}, (_r, text) => {
  const o = JSON.parse(text);
  if (!o.monitors?.length) throw new Error('no monitors');
  return `${o.monitors.length} monitor(s), virtual ${o.virtualScreen.width}x${o.virtualScreen.height}${o.units ? ' ' + o.units : ''}`;
});

await step('list_windows', 'desktop_list_windows', {}, (_r, text) => {
  const o = JSON.parse(text);
  // A headless macOS CI runner may have no application windows at all.
  if (!(o.count > 0) && !isMac) throw new Error('no windows');
  return `${o.count} window(s); focused: ${o.windows.find((w) => w.focused)?.title ?? '?'}${o.note ? ' [titles hidden: no Screen Recording]' : ''}`;
});

await step('screenshot', 'desktop_screenshot', { maxWidth: 800, format: 'png' }, (r) => {
  const img = r.content.find((c) => c.type === 'image');
  if (!img || img.data.length < 1000) throw new Error('no image data');
  const file = join(tmpdir(), 'neo-desktop-smoke.png');
  writeFileSync(file, Buffer.from(img.data, 'base64'));
  return `saved ${file} (${img.data.length} b64 chars); ${r.content.at(-1).text.slice(0, 90)}...`;
}, 'screen');

await step('ocr', 'desktop_ocr', {}, (_r, text) => {
  const o = JSON.parse(text);
  return `lang ${o.language}, ${o.lineCount} line(s)`;
}, 'screen');

await step('system_info', 'desktop_system_info', {}, (_r, text) => {
  const o = JSON.parse(text);
  if (!o.os?.name) throw new Error('missing os');
  const perms = o.permissions
    ? `; permissions: accessibility=${o.permissions.accessibility}, screenRecording=${o.permissions.screenRecording} (host: ${o.permissions.hostApp})`
    : '';
  return `${o.os.name}, ${o.memory.totalMB} MB RAM, ${o.disks.length} disk(s), top cpu: ${o.topProcessesByCpu[0]?.name ?? 'n/a'}${perms}`;
});

const probe = `neo-smoke-${Date.now()} Merhaba ğüşiöçİ`;
await step('clipboard_set', 'desktop_clipboard_set', { text: probe });
await step('clipboard_get', 'desktop_clipboard_get', {}, (_r, text) => {
  const o = JSON.parse(text);
  if (o.text !== probe) throw new Error(`roundtrip mismatch: ${JSON.stringify(o.text)}`);
  return 'roundtrip ok (incl. Turkish chars)';
});

await step('mouse position', 'desktop_mouse', { action: 'position' }, (_r, text) => {
  const o = JSON.parse(text);
  return `cursor at ${o.x},${o.y}`;
});

if (isMac) {
  // Input control needs Accessibility; a no-op move to the current cursor position is harmless where it is granted.
  let pos = null;
  try {
    pos = JSON.parse((await tools.desktop_mouse.handler({ action: 'position' }, ctx)).content[0].text);
  } catch {
    /* reported by the 'mouse position' step above */
  }
  if (pos) {
    await step('mouse move (no-op)', 'desktop_mouse', { action: 'move', x: pos.x, y: pos.y }, (_r, text) => {
      const o = JSON.parse(text);
      return `cursor at ${o.x},${o.y}`;
    }, 'ax');
  }
}

await step('wait', 'desktop_wait', { ms: 100 });

console.log(failed === 0 ? `\nALL PASS${skipped ? ` (${skipped} skipped: missing macOS permissions)` : ''}` : `\n${failed} FAILED`);
console.log('Not exercised automatically (manual): desktop_window, mouse click/drag, keyboard, open, notify.');
process.exit(failed === 0 ? 0 : 1);
