/**
 * Pure coordinate / window model helpers for macOS.
 *
 * Coordinate systems:
 *  - CG global ("screen coordinates" everywhere in the tools): origin = top-left of the PRIMARY display, y grows
 *    downwards, unit = POINTS (logical pixels). CGEvent mouse events, CGWindowList bounds, screencapture -R and
 *    System Events positions all use this system.
 *  - NSScreen frames: origin = bottom-left of the primary display, y grows upwards, unit = points.
 *  - Screenshot pixels = points * backingScaleFactor (2 on Retina). Screenshot captions report the capture size in
 *    POINTS and the (downscaled) image size in pixels, so "image px = screen pt * scale" stays true.
 *  - Vision bounding boxes: normalized 0..1 relative to the image, origin bottom-left.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NormBox {
  nx: number;
  ny: number;
  nw: number;
  nh: number;
}

/** NSScreen rect (bottom-left origin, relative to the primary screen) -> CG global rect (top-left origin). */
export function nsRectToCg(r: Rect, primaryHeight: number): Rect {
  return { x: r.x, y: primaryHeight - (r.y + r.height), width: r.width, height: r.height };
}

/** CG global rect -> NSScreen rect (inverse of nsRectToCg). */
export function cgRectToNs(r: Rect, primaryHeight: number): Rect {
  return { x: r.x, y: primaryHeight - (r.y + r.height), width: r.width, height: r.height };
}

/** Vision normalized box (origin bottom-left) -> screen-point rect inside `region` (CG coords). */
export function visionToScreen(b: NormBox, region: Rect): Rect {
  const x = region.x + b.nx * region.width;
  const yTop = region.y + (1 - b.ny - b.nh) * region.height;
  const w = b.nw * region.width;
  const h = b.nh * region.height;
  return { x: Math.round(x), y: Math.round(yTop), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}

/** Image pixels per screen point for a capture. */
export function captureScale(outPixelWidth: number, widthPoints: number): number {
  return widthPoints > 0 ? outPixelWidth / widthPoints : 1;
}

export interface MacScreen {
  index: number;
  primary: boolean;
  name: string;
  scale: number;
  /** CG coords, points. */
  frame: Rect;
  /** Work area (excludes menu bar and Dock), CG coords, points. */
  visible: Rect;
}

export interface RawScreen {
  frame: Rect;
  visible: Rect;
  scale: number;
  name?: string;
}

/** `raw[0]` must be the primary screen (NSScreen.screens[0] always is). */
export function buildScreens(raw: RawScreen[]): MacScreen[] {
  if (raw.length === 0) return [];
  const primaryHeight = (raw[0] as RawScreen).frame.height;
  return raw.map((s, i) => ({
    index: i,
    primary: i === 0,
    name: s.name && s.name.length > 0 ? s.name : `Display ${i + 1}`,
    scale: s.scale > 0 ? s.scale : 1,
    frame: nsRectToCg(s.frame, primaryHeight),
    visible: nsRectToCg(s.visible, primaryHeight),
  }));
}

export function virtualScreen(screens: MacScreen[]): Rect {
  if (screens.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const s of screens) {
    x1 = Math.min(x1, s.frame.x);
    y1 = Math.min(y1, s.frame.y);
    x2 = Math.max(x2, s.frame.x + s.frame.width);
    y2 = Math.max(y2, s.frame.y + s.frame.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Screen with the largest overlap with `r` (falls back to the screen nearest to r's center, then primary). */
export function screenForRect(r: Rect, screens: MacScreen[]): MacScreen | undefined {
  let best: MacScreen | undefined;
  let bestArea = 0;
  for (const s of screens) {
    const a = overlapArea(r, s.frame);
    if (a > bestArea) {
      best = s;
      bestArea = a;
    }
  }
  if (best) return best;
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  let bestD = Infinity;
  for (const s of screens) {
    const dx = Math.max(s.frame.x - cx, 0, cx - (s.frame.x + s.frame.width));
    const dy = Math.max(s.frame.y - cy, 0, cy - (s.frame.y + s.frame.height));
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** Clip to the virtual screen (like the Windows implementation); undefined when empty. */
export function clipRect(r: Rect, virt: Rect): Rect | undefined {
  const x1 = Math.max(r.x, virt.x);
  const y1 = Math.max(r.y, virt.y);
  const x2 = Math.min(r.x + r.width, virt.x + virt.width);
  const y2 = Math.min(r.y + r.height, virt.y + virt.height);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return undefined;
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

// ---------- windows ----------

/** One entry of CGWindowListCopyWindowInfo, as emitted by the JXA geometry script. */
export interface RawWindow {
  id: number;
  pid: number;
  owner: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
  onscreen: boolean;
  alpha?: number;
}

export interface MacWindow {
  handle: number;
  title: string;
  process: string;
  pid: number;
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
  focused: boolean;
}

function near(a: number, b: number, tol: number): boolean {
  return Math.abs(a - b) <= tol;
}

export function isMaximized(w: Rect, screens: MacScreen[]): boolean {
  const s = screenForRect(w, screens);
  if (!s) return false;
  const v = s.visible;
  const f = s.frame;
  return (
    (near(w.width, v.width, 3) && near(w.height, v.height, 3) && near(w.x, v.x, 3) && near(w.y, v.y, 3)) ||
    (near(w.width, f.width, 3) && near(w.height, f.height, 3) && near(w.x, f.x, 3) && near(w.y, f.y, 3))
  );
}

/**
 * Normal top-level windows in front-to-back order: layer 0 only (menu bar, Dock, overlays have other layers).
 * On-screen windows come first (CG order = z-order); off-screen ones that still have a title (minimized or hidden
 * apps, other Spaces) follow, flagged `minimized`.
 */
export function buildWindows(raw: RawWindow[], screens: MacScreen[], frontPid: number | undefined): MacWindow[] {
  const on: MacWindow[] = [];
  const off: MacWindow[] = [];
  let focusedAssigned = false;
  for (const r of raw) {
    if (r.layer !== 0) continue;
    if (!(r.w >= 40 && r.h >= 20)) continue;
    if (r.alpha !== undefined && r.alpha <= 0) continue;
    const title = r.title ?? '';
    if (!r.onscreen && title.length === 0) continue;
    const win: MacWindow = {
      handle: r.id,
      title,
      process: r.owner ?? '',
      pid: r.pid,
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.w),
      height: Math.round(r.h),
      minimized: !r.onscreen,
      maximized: false,
      focused: false,
    };
    if (r.onscreen) {
      win.maximized = isMaximized(win, screens);
      if (!focusedAssigned && frontPid !== undefined && r.pid === frontPid) {
        win.focused = true;
        focusedAssigned = true;
      }
      on.push(win);
    } else {
      off.push(win);
    }
  }
  return [...on, ...off];
}

export interface WindowSelector {
  handle?: number;
  title?: string;
}

/**
 * Pick a window: by handle (CGWindowID), or by case-insensitive substring of the title OR the application name
 * (titles are empty without Screen Recording permission). Focused match wins, then on-screen front-most, then
 * minimized ones.
 */
export function resolveMacWindow(windows: MacWindow[], sel: WindowSelector): MacWindow | undefined {
  if (sel.handle !== undefined) return windows.find((w) => w.handle === sel.handle);
  if (!sel.title) return undefined;
  const needle = sel.title.toLowerCase();
  const hits = windows.filter((w) => w.title.toLowerCase().includes(needle) || w.process.toLowerCase().includes(needle));
  return hits.find((w) => w.focused && !w.minimized) ?? hits.find((w) => !w.minimized) ?? hits[0];
}

export function filterWindows(windows: MacWindow[], filter: string | undefined): MacWindow[] {
  if (!filter) return windows;
  const f = filter.toLowerCase();
  return windows.filter((w) => w.title.toLowerCase().includes(f) || w.process.toLowerCase().includes(f));
}

/** Work area rect (CG points) a "maximize" should fill: the visible frame of the screen the window is mostly on. */
export function maximizeTarget(win: Rect, screens: MacScreen[]): Rect | undefined {
  const s = screenForRect(win, screens);
  return s ? { ...s.visible } : undefined;
}

// ---------- geometry blob from the JXA script ----------

export interface Geometry {
  screens: MacScreen[];
  virtual: Rect;
  cursor: { x: number; y: number };
  windows: MacWindow[];
  frontPid: number | undefined;
  accessibility: boolean | null;
  screenRecording: boolean | null;
}

function num(v: unknown, d = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function rectOf(v: unknown): Rect {
  const o = (v ?? {}) as Record<string, unknown>;
  return { x: num(o['x']), y: num(o['y']), width: num(o['width']), height: num(o['height']) };
}

function tri(v: unknown): boolean | null {
  return v === true ? true : v === false ? false : null;
}

export function parseGeometry(r: Record<string, unknown>): Geometry {
  const rawScreens = (Array.isArray(r['screens']) ? (r['screens'] as Record<string, unknown>[]) : []).map((s) => ({
    frame: rectOf(s['frame']),
    visible: rectOf(s['visible']),
    scale: num(s['scale'], 1),
    name: typeof s['name'] === 'string' ? (s['name'] as string) : '',
  }));
  const screens = buildScreens(rawScreens);
  const rawWins: RawWindow[] = (Array.isArray(r['windows']) ? (r['windows'] as Record<string, unknown>[]) : []).map((w) => ({
    id: num(w['id']),
    pid: num(w['pid']),
    owner: typeof w['owner'] === 'string' ? (w['owner'] as string) : '',
    title: typeof w['title'] === 'string' ? (w['title'] as string) : '',
    x: num(w['x']),
    y: num(w['y']),
    w: num(w['w']),
    h: num(w['h']),
    layer: num(w['layer']),
    onscreen: w['onscreen'] === true,
    alpha: w['alpha'] === undefined ? undefined : num(w['alpha'], 1),
  }));
  const frontPid = typeof r['frontPid'] === 'number' && (r['frontPid'] as number) > 0 ? (r['frontPid'] as number) : undefined;
  const cur = (r['cursor'] ?? {}) as Record<string, unknown>;
  return {
    screens,
    virtual: virtualScreen(screens),
    cursor: { x: Math.round(num(cur['x'])), y: Math.round(num(cur['y'])) },
    windows: buildWindows(rawWins, screens, frontPid),
    frontPid,
    accessibility: tri(r['ax']),
    screenRecording: tri(r['screen']),
  };
}
