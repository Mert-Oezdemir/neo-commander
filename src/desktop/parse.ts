/** Per-tool argument parsing: validates, applies defaults, and builds the JSON blob sent to PowerShell. */
import { modifierVks, parseHotkey, pressKey, toArrays } from './keys.js';
import { center, unionBox, type Box } from './math.js';
import {
  ArgError,
  enumOf,
  optBool,
  optHandle,
  optInt,
  optRegion,
  optString,
  optStringArray,
  reqInt,
  reqString,
  type Args,
  type Region,
} from './validate.js';

export interface Target {
  monitor?: number;
  region?: Region;
  title?: string;
  handle?: number;
}

/** monitor | region | window(title) | handle — shared by screenshot and OCR. */
export function parseTarget(a: Args): Target {
  const monitor = optInt(a, 'monitor', 0, 63);
  const region = optRegion(a, 'region');
  const title = optString(a, 'window', 500);
  const handle = optHandle(a, 'handle');
  const chosen = [region ? 'region' : '', title || handle ? 'window/handle' : '', monitor !== undefined ? 'monitor' : ''].filter(Boolean);
  if (chosen.length > 1) {
    throw new ArgError(`Specify only one capture target; got: ${chosen.join(', ')}.`);
  }
  const t: Target = {};
  if (monitor !== undefined) t.monitor = monitor;
  if (region) t.region = region;
  if (title) t.title = title;
  if (handle !== undefined) t.handle = handle;
  return t;
}

export interface ScreenshotInput extends Target {
  maxWidth: number;
  format: 'png' | 'jpeg';
  quality: number;
}

export function parseScreenshot(a: Args): ScreenshotInput {
  return {
    ...parseTarget(a),
    maxWidth: optInt(a, 'maxWidth', 100, 8000) ?? 1600,
    format: enumOf(a, 'format', ['png', 'jpeg'] as const, 'jpeg'),
    quality: optInt(a, 'quality', 1, 100) ?? 80,
  };
}

export interface OcrInput extends Target {
  language?: string;
  find?: string;
}

export function parseOcr(a: Args): OcrInput {
  const out: OcrInput = { ...parseTarget(a) };
  const language = optString(a, 'language', 35);
  if (language) {
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) {
      throw new ArgError('"language" must be a BCP-47 tag such as "en-US" or "tr".');
    }
    out.language = language;
  }
  const find = optString(a, 'find', 500);
  if (find) out.find = find;
  return out;
}

// ---------- mouse ----------

export const MOUSE_ACTIONS = ['move', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll', 'position'] as const;
export type MouseAction = (typeof MOUSE_ACTIONS)[number];

export interface MouseInput {
  kind: MouseAction;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  amount?: number;
  horizontal?: boolean;
  mods?: number[];
}

const COORD = 100000;

export function parseMouse(a: Args): MouseInput {
  const kind = enumOf(a, 'action', MOUSE_ACTIONS);
  const x = optInt(a, 'x', -COORD, COORD);
  const y = optInt(a, 'y', -COORD, COORD);
  const out: MouseInput = { kind };
  if ((x === undefined) !== (y === undefined)) throw new ArgError('Provide both "x" and "y", or neither.');
  if (kind === 'move' && x === undefined) throw new ArgError('"x" and "y" are required for action "move".');
  if (x !== undefined && y !== undefined && kind !== 'position') {
    out.x = x;
    out.y = y;
  }
  if (kind === 'drag') {
    out.toX = reqInt(a, 'to_x', -COORD, COORD);
    out.toY = reqInt(a, 'to_y', -COORD, COORD);
  }
  if (kind === 'scroll') {
    const amount = reqInt(a, 'amount', -100, 100);
    if (amount === 0) throw new ArgError('"amount" must not be 0 (positive = up/left-to-right, negative = down).');
    out.amount = amount;
    if (optBool(a, 'horizontal')) out.horizontal = true;
  }
  const mods = optStringArray(a, 'modifiers', 4, 20);
  if (mods && mods.length > 0) {
    try {
      out.mods = modifierVks(mods);
    } catch (e) {
      throw new ArgError((e as Error).message);
    }
  }
  return out;
}

// ---------- keyboard ----------

export interface KeyboardInput {
  kind: 'type' | 'hotkey' | 'press';
  text?: string;
  vks?: number[];
  flags?: number[];
  delay: number;
}

export const MAX_TYPE_CHARS = 10000;

export function parseKeyboard(a: Args): KeyboardInput {
  const kind = enumOf(a, 'action', ['type', 'hotkey', 'press'] as const);
  const delayOpt = optInt(a, 'delay_ms', 0, 200);
  if (kind === 'type') {
    const text = reqString(a, 'text', MAX_TYPE_CHARS);
    return { kind, text, delay: delayOpt ?? 8 };
  }
  try {
    if (kind === 'hotkey') {
      const keys = reqString(a, 'keys', 100);
      return { kind, ...toArrays(parseHotkey(keys)), delay: delayOpt ?? 15 };
    }
    const key = reqString(a, 'key', 40);
    const repeat = optInt(a, 'repeat', 1, 200) ?? 1;
    return { kind, ...toArrays(pressKey(key, repeat)), delay: delayOpt ?? 15 };
  } catch (e) {
    if (e instanceof ArgError) throw e;
    throw new ArgError((e as Error).message);
  }
}

/** Timeout budget for a keyboard call. */
export function keyboardTimeoutMs(k: KeyboardInput): number {
  const events = k.kind === 'type' ? (k.text?.length ?? 0) * 2 : (k.vks?.length ?? 0);
  return Math.min(120000, Math.max(20000, 8000 + events * (k.delay + 3)));
}

// ---------- window ----------

export const WINDOW_ACTIONS = ['focus', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize'] as const;

export interface WindowInput {
  action: (typeof WINDOW_ACTIONS)[number];
  handle?: number;
  title?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export function parseWindow(a: Args): WindowInput {
  const action = enumOf(a, 'action', WINDOW_ACTIONS);
  const handle = optHandle(a, 'handle');
  const title = optString(a, 'title', 500);
  if (handle === undefined && !title) {
    throw new ArgError('Provide "handle" or "title" (substring) to identify the window. See desktop_list_windows.');
  }
  const out: WindowInput = { action };
  if (handle !== undefined) out.handle = handle;
  if (title) out.title = title;
  if (action === 'move') {
    out.x = reqInt(a, 'x', -100000, 100000);
    out.y = reqInt(a, 'y', -100000, 100000);
  }
  if (action === 'resize') {
    out.width = reqInt(a, 'width', 50, 30000);
    out.height = reqInt(a, 'height', 50, 30000);
  }
  return out;
}

// ---------- clipboard / open / notify / wait / list windows ----------

export const MAX_CLIPBOARD_SET = 25000;

export function parseClipboardSet(a: Args): { text: string } {
  const v = a['text'];
  if (typeof v !== 'string') throw new ArgError('"text" is required and must be a string (use "" to clear the clipboard).');
  if (v.length > MAX_CLIPBOARD_SET) {
    throw new ArgError(`"text" is too long (${v.length} > ${MAX_CLIPBOARD_SET}). Write large content to a file instead.`);
  }
  return { text: v };
}

export function parseClipboardGet(a: Args): { maxChars: number } {
  return { maxChars: optInt(a, 'maxChars', 1, 1000000) ?? 20000 };
}

/** Split a command-line style string into arguments, honouring double quotes. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  let has = false;
  for (const ch of s) {
    if (ch === '"') {
      inQ = !inQ;
      has = true;
    } else if (!inQ && /\s/.test(ch)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

export function parseOpen(a: Args): { target: string; args?: string[] } {
  const target = reqString(a, 'target', 2000);
  if (target.trim() !== target || target.startsWith('-')) {
    throw new ArgError('"target" must be a URL, file/folder path, or application name (no leading dash or surrounding spaces).');
  }
  let args: string[] | undefined;
  const raw = a['args'];
  if (typeof raw === 'string') args = raw.trim() ? splitArgs(raw) : undefined;
  else args = optStringArray(a, 'args', 32, 2000);
  const out: { target: string; args?: string[] } = { target };
  if (args && args.length > 0) out.args = args;
  return out;
}

export function parseNotify(a: Args): { title: string; message: string } {
  return { title: reqString(a, 'title', 63), message: reqString(a, 'message', 255) };
}

export function parseWait(a: Args): { ms: number } {
  return { ms: reqInt(a, 'ms', 1, 30000) };
}

export function parseListWindows(a: Args): { filter?: string; includeMinimized: boolean } {
  const out: { filter?: string; includeMinimized: boolean } = { includeMinimized: optBool(a, 'include_minimized') ?? true };
  const f = optString(a, 'filter', 500);
  if (f) out.filter = f;
  return out;
}

// ---------- OCR post-processing (pure) ----------

export interface OcrWord extends Box {
  text: string;
}
export interface OcrLine extends Box {
  text: string;
  words: OcrWord[];
}

function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v === undefined || v === null) return [];
  return [v as T];
}

export function normalizeOcrLines(raw: unknown): OcrLine[] {
  return asArray<Record<string, unknown>>(raw).map((l) => ({
    text: String(l['text'] ?? ''),
    x: Number(l['x']),
    y: Number(l['y']),
    width: Number(l['width']),
    height: Number(l['height']),
    words: asArray<Record<string, unknown>>(l['words']).map((w) => ({
      text: String(w['text'] ?? ''),
      x: Number(w['x']),
      y: Number(w['y']),
      width: Number(w['width']),
      height: Number(w['height']),
    })),
  }));
}

export interface OcrMatch extends Box {
  line: string;
  matchedText: string;
  centerX: number;
  centerY: number;
}

/** Case-insensitive search in OCR lines; returns word-level boxes where possible. */
export function findInOcr(lines: OcrLine[], find: string): OcrMatch[] {
  const needle = find.toLowerCase();
  const matches: OcrMatch[] = [];
  for (const line of lines) {
    const hay = line.words.map((w) => w.text).join(' ');
    const hayLower = hay.toLowerCase();
    let from = 0;
    let found = false;
    while (needle.length > 0) {
      const idx = hayLower.indexOf(needle, from);
      if (idx < 0) break;
      found = true;
      from = idx + Math.max(1, needle.length);
      const end = idx + needle.length;
      const hit: OcrWord[] = [];
      let pos = 0;
      for (const w of line.words) {
        const ws = pos;
        const we = pos + w.text.length;
        if (ws < end && we > idx) hit.push(w);
        pos = we + 1;
      }
      const box: Box = hit.length > 0 ? unionBox(hit) : { x: line.x, y: line.y, width: line.width, height: line.height };
      const c = center(box);
      matches.push({
        line: line.text,
        matchedText: hit.length > 0 ? hit.map((w) => w.text).join(' ') : line.text,
        ...box,
        centerX: c.x,
        centerY: c.y,
      });
    }
    if (!found && line.text.toLowerCase().includes(needle)) {
      const c = center(line);
      matches.push({ line: line.text, matchedText: line.text, x: line.x, y: line.y, width: line.width, height: line.height, centerX: c.x, centerY: c.y });
    }
  }
  return matches;
}
