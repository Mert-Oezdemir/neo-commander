// Manual smoke test for src/desktop. Run on Windows after `npm run build`:
//   node scripts/desktop-smoke.mjs
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopTools } from '../dist/desktop/index.js';

const tools = Object.fromEntries(desktopTools().map((t) => [t.name, t]));
const ctx = { allowedDirectories: [], signal: new AbortController().signal, stateDir: tmpdir() };
let failed = 0;

async function step(name, tool, args, check) {
  const t0 = Date.now();
  try {
    const r = await tools[tool].handler(args, ctx);
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(text);
    const detail = check ? await check(r, text) : '';
    console.log(`PASS ${name} (${Date.now() - t0} ms)${detail ? ' - ' + detail : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name} (${Date.now() - t0} ms): ${e.message}`);
  }
}

if (process.platform !== 'win32') {
  console.log('Not Windows - expecting the Windows-only error from every tool.');
}

await step('list_monitors', 'desktop_list_monitors', {}, (_r, text) => {
  const o = JSON.parse(text);
  if (!o.monitors?.length) throw new Error('no monitors');
  return `${o.monitors.length} monitor(s), virtual ${o.virtualScreen.width}x${o.virtualScreen.height}`;
});

await step('list_windows', 'desktop_list_windows', {}, (_r, text) => {
  const o = JSON.parse(text);
  if (!(o.count > 0)) throw new Error('no windows');
  return `${o.count} window(s); focused: ${o.windows.find((w) => w.focused)?.title ?? '?'}`;
});

await step('screenshot', 'desktop_screenshot', { maxWidth: 800, format: 'png' }, (r) => {
  const img = r.content.find((c) => c.type === 'image');
  if (!img || img.data.length < 1000) throw new Error('no image data');
  const file = join(tmpdir(), 'neo-desktop-smoke.png');
  writeFileSync(file, Buffer.from(img.data, 'base64'));
  return `saved ${file} (${img.data.length} b64 chars); ${r.content.at(-1).text.slice(0, 90)}...`;
});

await step('ocr', 'desktop_ocr', {}, (_r, text) => {
  const o = JSON.parse(text);
  return `lang ${o.language}, ${o.lineCount} line(s)`;
});

await step('system_info', 'desktop_system_info', {}, (_r, text) => {
  const o = JSON.parse(text);
  if (!o.os?.name) throw new Error('missing os');
  return `${o.os.name}, ${o.memory.totalMB} MB RAM, ${o.disks.length} disk(s), top cpu: ${o.topProcessesByCpu[0]?.name ?? 'n/a'}`;
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

await step('wait', 'desktop_wait', { ms: 100 });

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
console.log('Not exercised automatically (manual): desktop_window, mouse click/drag, keyboard, open, notify.');
process.exit(failed === 0 ? 0 : 1);
