/** Pure planning/argument construction for screencapture(1) and sips(1). */
import { ArgError } from './validate.js';
import type { Target } from './parse.js';
import {
  clipRect,
  resolveMacWindow,
  type Geometry,
  type Rect,
} from './mac-geometry.js';

export const SCREENCAPTURE = '/usr/sbin/screencapture';
export const SIPS = '/usr/bin/sips';

export interface CapturePlan {
  /** What is captured, in screen points (CG coordinates). Used for the caption / OCR coordinate mapping. */
  rect: Rect;
  source: string;
  /** Set when the capture is of one window (`screencapture -l <id>`); otherwise a rectangle (`-R`). */
  windowId?: number;
}

export function planCapture(t: Target, g: Geometry): CapturePlan {
  if (g.screens.length === 0) throw new ArgError('No display found.');
  if (t.region) {
    const r = clipRect({ x: t.region.x, y: t.region.y, width: t.region.width, height: t.region.height }, g.virtual);
    if (!r) throw new ArgError('The requested area is outside the virtual screen or empty.');
    return { rect: r, source: 'region' };
  }
  if (t.handle !== undefined || t.title) {
    const sel: { handle?: number; title?: string } = {};
    if (t.handle !== undefined) sel.handle = t.handle;
    if (t.title) sel.title = t.title;
    const w = resolveMacWindow(g.windows, sel);
    if (!w) throw new ArgError('No visible window matches the given title/handle. Use desktop_list_windows.');
    if (w.minimized) throw new ArgError('The window is minimized or hidden. Restore or focus it first (desktop_window).');
    return {
      rect: { x: w.x, y: w.y, width: w.width, height: w.height },
      source: `window: ${w.title || w.process}`,
      windowId: w.handle,
    };
  }
  if (t.monitor !== undefined) {
    const s = g.screens[t.monitor];
    if (!s) throw new ArgError(`Monitor index out of range (0..${g.screens.length - 1}).`);
    return { rect: { ...s.frame }, source: `monitor ${t.monitor}` };
  }
  const p = g.screens[0]!;
  return { rect: { ...p.frame }, source: 'primary monitor' };
}

/**
 * screencapture arguments. `-x` silences the shutter sound; `-t png` keeps it lossless (jpeg conversion and
 * downscaling happen afterwards with sips so quality is controllable). A rectangle uses `-R x,y,w,h` (global
 * point coordinates; used for monitors too so the mapping is exact regardless of display numbering), a window
 * uses `-l <id> -o` (that window only, without its drop shadow, even when partially covered).
 */
export function screencaptureArgs(plan: CapturePlan, outFile: string): string[] {
  const args = ['-x', '-t', 'png'];
  if (plan.windowId !== undefined) {
    args.push('-o', '-l', String(plan.windowId));
  } else {
    const r = plan.rect;
    args.push('-R', `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`);
  }
  args.push(outFile);
  return args;
}

export interface SipsPlan {
  /** Run sips at all? (png without downscale needs no post-processing). */
  needed: boolean;
  args: string[];
}

/**
 * sips arguments to convert/downscale `inFile` -> `outFile`. Never upscales: pass the real capture pixel width.
 * jpeg quality goes through `-s formatOptions <1-100>`.
 */
export function sipsArgs(
  opts: { format: 'png' | 'jpeg'; quality: number; maxWidth: number; srcPixelWidth: number },
  inFile: string,
  outFile: string,
): SipsPlan {
  const args: string[] = [];
  const resize = opts.srcPixelWidth > opts.maxWidth;
  if (opts.format === 'jpeg') args.push('-s', 'format', 'jpeg', '-s', 'formatOptions', String(opts.quality));
  if (resize) args.push('--resampleWidth', String(opts.maxWidth));
  const needed = opts.format === 'jpeg' || resize;
  args.push(inFile, '--out', outFile);
  return { needed, args };
}

/** `sips -g pixelWidth -g pixelHeight <file>` */
export function sipsDimsArgs(file: string): string[] {
  return ['-g', 'pixelWidth', '-g', 'pixelHeight', file];
}

export function parseSipsDims(out: string): { width: number; height: number } | undefined {
  const w = /pixelWidth:\s*(\d+)/.exec(out);
  const h = /pixelHeight:\s*(\d+)/.exec(out);
  if (!w || !h) return undefined;
  return { width: Number(w[1]), height: Number(h[1]) };
}

/** Read width/height from a PNG header (IHDR). */
export function pngDims(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24) return undefined;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return undefined;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** BCP-47 candidates for Vision: explicit language, else the user's locale then en-US. */
export function ocrLanguageCandidates(explicit: string | undefined, env: Record<string, string | undefined>): string[] {
  if (explicit) return [explicit];
  const raw = env['LC_ALL'] || env['LC_MESSAGES'] || env['LANG'] || '';
  const m = /^([a-z]{2,3})(?:[_-]([A-Za-z]{2,4}))?/.exec(raw);
  const out: string[] = [];
  if (m && m[1] && m[1] !== 'C' && m[1] !== 'POSIX') out.push(m[2] ? `${m[1]}-${m[2].toUpperCase()}` : m[1]);
  if (!out.includes('en-US')) out.push('en-US');
  return out;
}
