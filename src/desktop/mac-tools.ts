/**
 * macOS implementations of the desktop_* tools. Same tool names, argument schemas and result shapes as the Windows
 * implementation; the Windows code is untouched. Coordinates are screen POINTS (CG global, origin top-left of the
 * primary display), which is also what CGEvent mouse events use.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { imageResult, textResult, type ToolContext } from '../tools/types.js';
import {
  accessibilityMessage,
  execText,
  hostAppName,
  macHooks,
  MacError,
  screenRecordingMessage,
  UTF8_ENV,
} from './mac-exec.js';
import {
  planCapture,
  parseSipsDims,
  pngDims,
  screencaptureArgs,
  SCREENCAPTURE,
  sipsArgs,
  sipsDimsArgs,
  SIPS,
  ocrLanguageCandidates,
  type CapturePlan,
} from './mac-capture.js';
import {
  captureScale,
  filterWindows,
  maximizeTarget,
  parseGeometry,
  resolveMacWindow,
  visionToScreen,
  type Geometry,
  type Rect,
} from './mac-geometry.js';
import { OPEN, planOpen } from './mac-open.js';
import { macKeyboardTimeoutMs, parseKeyboardMac, parseMouseMac } from './mac-parse.js';
import { parseMacHotkey } from './mac-keys.js';
import {
  SCRIPT_CLIPBOARD_INFO,
  SCRIPT_GEOMETRY,
  SCRIPT_KEYBOARD,
  SCRIPT_MOUSE,
  SCRIPT_NOTIFY,
  SCRIPT_OCR,
  SCRIPT_WINDOW,
} from './mac-scripts.js';
import {
  parseBoottime,
  parseDf,
  parseIfconfig,
  parsePmsetBatt,
  parsePs,
  parseSwVers,
  parseVmStat,
  topByCpu,
  topByMemory,
} from './mac-sysinfo.js';
import {
  findInOcr,
  normalizeOcrLines,
  parseClipboardGet,
  parseClipboardSet,
  parseListWindows,
  parseNotify,
  parseOcr,
  parseOpen,
  parseScreenshot,
  parseWindow,
  type OcrLine,
} from './parse.js';
import { ArgError, type Args } from './validate.js';

type Run = (args: Args, ctx: ToolContext) => Promise<CallToolResult>;

const DEFAULT_TIMEOUT = 20000;
const OCR_TIMEOUT = 60000;

function json(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

async function jxa(script: string, input: unknown, ctx: ToolContext, timeoutMs = DEFAULT_TIMEOUT): Promise<Record<string, unknown>> {
  return macHooks.runJxa(script, input, { timeoutMs, signal: ctx.signal });
}

export async function readGeometry(ctx: ToolContext, windows = true): Promise<Geometry> {
  return parseGeometry(await jxa(SCRIPT_GEOMETRY, { windows }, ctx, 15000));
}

function requireScreenRecording(g: Geometry): void {
  if (g.screenRecording === false) throw new MacError(screenRecordingMessage(), 'PERM_SCREEN');
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

// ---------- capture ----------

interface Capture {
  dir: string;
  png: string;
  width: number;
  height: number;
}

async function capture(plan: CapturePlan, ctx: ToolContext): Promise<Capture> {
  const dir = mkdtempSync(join(tmpdir(), 'neo-cap-'));
  const png = join(dir, 'cap.png');
  try {
    const r = await macHooks.exec(SCREENCAPTURE, screencaptureArgs(plan, png), { timeoutMs: DEFAULT_TIMEOUT, signal: ctx.signal });
    if (r.code !== 0 || !existsSync(png)) {
      const detail = r.stderr.trim().slice(0, 300);
      throw new MacError(
        `screencapture failed (exit code ${r.code}). ${detail} ` +
          `If this persists, Screen Recording permission is probably missing: ${screenRecordingMessage()}`,
      );
    }
    const dims = pngDims(readFileSync(png));
    if (!dims) throw new MacError('screencapture produced an unreadable image.');
    return { dir, png, width: dims.width, height: dims.height };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

const screenshot: Run = async (args, ctx) => {
  const input = parseScreenshot(args);
  const g = await readGeometry(ctx);
  requireScreenRecording(g);
  const plan = planCapture(input, g);
  const cap = await capture(plan, ctx);
  try {
    const sp = sipsArgs({ format: input.format, quality: input.quality, maxWidth: input.maxWidth, srcPixelWidth: cap.width }, cap.png, join(cap.dir, input.format === 'jpeg' ? 'out.jpg' : 'out.png'));
    let file = cap.png;
    let outW = cap.width;
    let outH = cap.height;
    if (sp.needed) {
      file = sp.args[sp.args.length - 1] as string;
      await execText(SIPS, sp.args, { timeoutMs: DEFAULT_TIMEOUT, signal: ctx.signal });
      const d = parseSipsDims(await execText(SIPS, sipsDimsArgs(file), { timeoutMs: DEFAULT_TIMEOUT, signal: ctx.signal }));
      if (d) {
        outW = d.width;
        outH = d.height;
      } else if (cap.width > input.maxWidth) {
        outW = input.maxWidth;
        outH = Math.max(1, Math.round((cap.height * input.maxWidth) / cap.width));
      }
    }
    const b64 = readFileSync(file).toString('base64');
    const rect = plan.rect;
    const caption = screenshotCaption({
      source: plan.source,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      outW,
      outH,
      nativeW: cap.width,
      nativeH: cap.height,
    });
    return imageResult(b64, caption, input.format === 'jpeg' ? 'image/jpeg' : 'image/png');
  } finally {
    cleanup(cap.dir);
  }
};

export function screenshotCaption(c: {
  source: string;
  width: number;
  height: number;
  x: number;
  y: number;
  outW: number;
  outH: number;
  nativeW: number;
  nativeH: number;
}): string {
  const scale = captureScale(c.outW, c.width);
  const retina = c.width > 0 ? c.nativeW / c.width : 1;
  return (
    `Screenshot of ${c.source}. Image: ${c.outW}x${c.outH}px. ` +
    `Original capture: ${c.width}x${c.height} screen points (${c.nativeW}x${c.nativeH} native pixels, backing scale ${retina.toFixed(2)}) at screen offset (${c.x}, ${c.y}). ` +
    `Scale: ${scale.toFixed(4)} (image px = screen points * scale; mouse coordinates are screen points). ` +
    `To convert an image point to screen coordinates: screenX = ${c.x} + imageX / ${scale.toFixed(4)}, screenY = ${c.y} + imageY / ${scale.toFixed(4)}.`
  );
}

/** Vision lines (normalized, bottom-left origin) -> OcrLine in screen points. */
export function visionLines(raw: unknown, region: Rect): OcrLine[] {
  const arr = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const conv = (o: Record<string, unknown>): Rect =>
    visionToScreen({ nx: num(o['nx']), ny: num(o['ny']), nw: num(o['nw']), nh: num(o['nh']) }, region);
  const lines = arr.map((l) => {
    const b = conv(l);
    const words = (Array.isArray(l['words']) ? (l['words'] as Record<string, unknown>[]) : []).map((w) => ({ text: String(w['text'] ?? ''), ...conv(w) }));
    return { text: String(l['text'] ?? ''), ...b, words };
  });
  return normalizeOcrLines(lines).sort((a, b) => a.y - b.y || a.x - b.x);
}

const ocr: Run = async (args, ctx) => {
  const input = parseOcr(args);
  const g = await readGeometry(ctx);
  requireScreenRecording(g);
  const plan = planCapture(input, g);
  const cap = await capture(plan, ctx);
  try {
    const languages = ocrLanguageCandidates(input.language, process.env);
    const r = await jxa(SCRIPT_OCR, { imagePath: cap.png, languages, autoDetect: !input.language }, ctx, OCR_TIMEOUT);
    const lines = visionLines(r['lines'], plan.rect);
    const region = { x: Math.round(plan.rect.x), y: Math.round(plan.rect.y), width: Math.round(plan.rect.width), height: Math.round(plan.rect.height) };
    if (input.find) {
      const matches = findInOcr(lines, input.find);
      return json({ language: r['language'], region, find: input.find, matchCount: matches.length, matches });
    }
    return json({
      language: r['language'],
      region,
      lineCount: lines.length,
      lines: lines.map((l) => ({ text: l.text, x: l.x, y: l.y, width: l.width, height: l.height })),
    });
  } finally {
    cleanup(cap.dir);
  }
};

// ---------- monitors / windows ----------

const listMonitors: Run = async (_args, ctx) => {
  const g = await readGeometry(ctx, false);
  return json({
    units: 'points',
    virtualScreen: g.virtual,
    cursor: g.cursor,
    monitors: g.screens.map((s) => ({
      index: s.index,
      primary: s.primary,
      name: s.name,
      x: s.frame.x,
      y: s.frame.y,
      width: s.frame.width,
      height: s.frame.height,
      workArea: { ...s.visible },
      scaleFactor: s.scale,
      pixelWidth: Math.round(s.frame.width * s.scale),
      pixelHeight: Math.round(s.frame.height * s.scale),
    })),
  });
};

const listWindows: Run = async (args, ctx) => {
  const input = parseListWindows(args);
  const g = await readGeometry(ctx);
  let windows = filterWindows(g.windows, input.filter);
  if (!input.includeMinimized) windows = windows.filter((w) => !w.minimized);
  const note =
    g.screenRecording === false
      ? 'Screen Recording permission is not granted: window titles of other apps are empty (filter matches the application name too). ' + screenRecordingMessage()
      : undefined;
  return json({ count: windows.length, windows, ...(note ? { note } : {}) });
};

/** Frames remembered when a window is maximized, so "restore" can put it back. */
const prevFrames = new Map<number, Rect>();

const windowTool: Run = async (args, ctx) => {
  const input = parseWindow(args);
  const g = await readGeometry(ctx);
  const sel: { handle?: number; title?: string } = {};
  if (input.handle !== undefined) sel.handle = input.handle;
  if (input.title) sel.title = input.title;
  const w = resolveMacWindow(g.windows, sel);
  if (!w) throw new ArgError('No visible window matches the given title/handle. Use desktop_list_windows.');
  const payload: Record<string, unknown> = { pid: w.pid, title: w.title, bx: w.x, by: w.y, bw: w.width, bh: w.height };
  switch (input.action) {
    case 'focus':
    case 'minimize':
    case 'close':
      payload['action'] = input.action;
      break;
    case 'maximize': {
      const t = maximizeTarget(w, g.screens);
      if (!t) throw new MacError('No display found.');
      if (!w.maximized) prevFrames.set(w.handle, { x: w.x, y: w.y, width: w.width, height: w.height });
      Object.assign(payload, { action: 'frame', x: t.x, y: t.y, width: t.width, height: t.height });
      break;
    }
    case 'restore': {
      const prev = prevFrames.get(w.handle);
      if (w.minimized) payload['action'] = 'unminimize';
      else if (prev) {
        Object.assign(payload, { action: 'frame', x: prev.x, y: prev.y, width: prev.width, height: prev.height });
        prevFrames.delete(w.handle);
      } else payload['action'] = 'exitfullscreen';
      break;
    }
    case 'move':
      Object.assign(payload, { action: 'frame', x: input.x, y: input.y });
      break;
    case 'resize':
      Object.assign(payload, { action: 'frame', width: input.width, height: input.height });
      break;
  }
  const r = await jxa(SCRIPT_WINDOW, payload, ctx);
  await macHooks.sleep(250);
  const g2 = await readGeometry(ctx);
  const info = g2.windows.find((x) => x.handle === w.handle) ?? null;
  const ok = r['ok'] !== false && (input.action !== 'focus' || g2.frontPid === w.pid);
  return json({ action: input.action, ok, window: info, targetHandle: w.handle });
};

// ---------- input ----------

const mouse: Run = async (args, ctx) => {
  const input = parseMouseMac(args);
  return json(await jxa(SCRIPT_MOUSE, input, ctx));
};

async function pasteText(text: string, ctx: ToolContext): Promise<void> {
  const prev = await execText('/usr/bin/pbpaste', [], { signal: ctx.signal }).catch(() => '');
  await execText('/usr/bin/pbcopy', [], { input: text, signal: ctx.signal });
  try {
    await jxa(SCRIPT_KEYBOARD, { kind: 'hotkey', events: parseMacHotkey('cmd+v'), delay: 15 }, ctx);
    await macHooks.sleep(300);
  } finally {
    await execText('/usr/bin/pbcopy', [], { input: prev, signal: ctx.signal }).catch(() => undefined);
  }
}

const keyboard: Run = async (args, ctx) => {
  const input = parseKeyboardMac(args);
  const timeout = macKeyboardTimeoutMs(input);
  const payload = input.kind === 'type' ? { kind: 'type', text: input.text, delay: input.delay } : { kind: input.kind, events: input.events, delay: input.delay };
  try {
    return json(await jxa(SCRIPT_KEYBOARD, payload, ctx, timeout));
  } catch (e) {
    // JXA could not bridge CGEventKeyboardSetUnicodeString: nothing was typed yet; paste through the clipboard instead.
    if (input.kind === 'type' && e instanceof MacError && e.code === 'UNICODE_BRIDGE') {
      await pasteText(input.text ?? '', ctx);
      return json({ action: 'type', chars: (input.text ?? '').length, method: 'paste' });
    }
    throw e;
  }
};

// ---------- clipboard ----------

const clipboardGet: Run = async (args, ctx) => {
  const { maxChars } = parseClipboardGet(args);
  const info = await jxa(SCRIPT_CLIPBOARD_INFO, {}, ctx);
  const hasText = info['hasText'] === true;
  const text = hasText ? await execText('/usr/bin/pbpaste', [], { signal: ctx.signal, maxBuffer: 32 * 1024 * 1024 }) : '';
  const truncated = text.length > maxChars;
  const files = Array.isArray(info['files']) ? info['files'] : [];
  return json({
    hasText: hasText || text.length > 0,
    text: truncated ? text.slice(0, maxChars) : text,
    truncated,
    totalLength: text.length,
    hasImage: info['hasImage'] === true,
    ...(info['hasImage'] === true ? { imageWidth: info['imageWidth'], imageHeight: info['imageHeight'] } : {}),
    hasFiles: info['hasFiles'] === true,
    files,
  });
};

const clipboardSet: Run = async (args, ctx) => {
  const { text } = parseClipboardSet(args);
  await execText('/usr/bin/pbcopy', [], { input: text, signal: ctx.signal });
  return json({ ok: true, length: text.length });
};

// ---------- open / notify ----------

async function spawnDetached(file: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', env: { ...process.env, ...UTF8_ENV } });
    child.once('error', (e) => reject(new MacError(`Could not start ${file}: ${e.message}`)));
    child.once('spawn', () => {
      const pid = child.pid ?? null;
      child.unref();
      resolve(pid);
    });
  });
}

export const openHooks = { spawnDetached };

const open: Run = async (args, ctx) => {
  const input = parseOpen(args);
  const plan = planOpen(input.target, input.args);
  if (plan.spawn) {
    const pid = await openHooks.spawnDetached(plan.file, plan.args);
    return json({ opened: input.target, pid, process: plan.file.split('/').pop() ?? null });
  }
  const r = await macHooks.exec(OPEN, plan.args, { timeoutMs: DEFAULT_TIMEOUT, signal: ctx.signal, env: UTF8_ENV });
  if (r.code !== 0) {
    throw new MacError(`open failed (exit code ${r.code}): ${(r.stderr.trim() || r.stdout.toString('utf8').trim()).slice(0, 400)}`);
  }
  return json({ opened: input.target, pid: null, process: null });
};

const notify: Run = async (args, ctx) => {
  return json(await jxa(SCRIPT_NOTIFY, parseNotify(args), ctx));
};

// ---------- system info ----------

async function tryText(file: string, args: string[], ctx: ToolContext): Promise<string> {
  try {
    return await execText(file, args, { timeoutMs: 15000, signal: ctx.signal, maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return '';
  }
}

const systemInfo: Run = async (_args, ctx) => {
  const sysctl = (k: string): Promise<string> => tryText('/usr/sbin/sysctl', ['-n', k], ctx).then((s) => s.trim());
  const [sw, memsize, brand, ncpu, pcpu, model, boot, arch, vm, df, batt, ps, ifc, perms] = await Promise.all([
    tryText('/usr/bin/sw_vers', [], ctx),
    sysctl('hw.memsize'),
    sysctl('machdep.cpu.brand_string'),
    sysctl('hw.ncpu'),
    sysctl('hw.physicalcpu'),
    sysctl('hw.model'),
    sysctl('kern.boottime'),
    tryText('/usr/bin/uname', ['-m'], ctx).then((s) => s.trim()),
    tryText('/usr/bin/vm_stat', [], ctx),
    tryText('/bin/df', ['-k'], ctx),
    tryText('/usr/bin/pmset', ['-g', 'batt'], ctx),
    tryText('/bin/ps', ['-Ao', 'pid,pcpu,rss,comm', '-r'], ctx),
    tryText('/sbin/ifconfig', [], ctx),
    readGeometry(ctx, false).catch(() => undefined),
  ]);
  const os = parseSwVers(sw);
  const procs = parsePs(ps);
  const logical = Number(ncpu) || 0;
  const loadPercent = logical > 0 ? Math.min(100, Math.round(procs.reduce((a, p) => a + p.cpu, 0) / logical)) : 0;
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    user = process.env['USER'] ?? '';
  }
  return json({
    os: { name: `${os.name} ${os.version}`.trim(), version: os.version, build: os.build, architecture: arch },
    hostname: hostname(),
    user,
    manufacturer: 'Apple',
    model,
    cpu: { names: brand ? [brand] : [], cores: Number(pcpu) || logical, logicalProcessors: logical, loadPercent },
    memory: { totalMB: Math.round((Number(memsize) || 0) / 1048576), freeMB: parseVmStat(vm).freeMB },
    disks: parseDf(df),
    uptimeSeconds: parseBoottime(boot),
    battery: parsePmsetBatt(batt),
    topProcessesByCpu: topByCpu(procs),
    topProcessesByMemory: topByMemory(procs),
    network: parseIfconfig(ifc),
    permissions: {
      accessibility: perms ? perms.accessibility : null,
      screenRecording: perms ? perms.screenRecording : null,
      hostApp: hostAppName(),
      note:
        perms && (perms.accessibility === false || perms.screenRecording === false)
          ? [perms.accessibility === false ? accessibilityMessage() : '', perms.screenRecording === false ? screenRecordingMessage() : ''].filter(Boolean).join(' | ')
          : undefined,
    },
  });
};

export const macRuns: Record<string, Run> = {
  desktop_screenshot: screenshot,
  desktop_ocr: ocr,
  desktop_list_monitors: listMonitors,
  desktop_list_windows: listWindows,
  desktop_window: windowTool,
  desktop_mouse: mouse,
  desktop_keyboard: keyboard,
  desktop_clipboard_get: clipboardGet,
  desktop_clipboard_set: clipboardSet,
  desktop_open: open,
  desktop_system_info: systemInfo,
  desktop_notify: notify,
};
