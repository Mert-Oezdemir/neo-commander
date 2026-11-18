import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { imageResult, textResult, type Risk, type ToolContext, type ToolDef } from '../tools/types.js';
import { KeyError } from './keys.js';
import {
  findInOcr,
  keyboardTimeoutMs,
  normalizeOcrLines,
  parseClipboardGet,
  parseClipboardSet,
  parseKeyboard,
  parseListWindows,
  parseMouse,
  parseNotify,
  parseOcr,
  parseOpen,
  parseScreenshot,
  parseWait,
  parseWindow,
} from './parse.js';
import { hooks, PsError, WINDOWS_ONLY } from './ps.js';
import {
  SCRIPT_CLIPBOARD_GET,
  SCRIPT_CLIPBOARD_SET,
  SCRIPT_KEYBOARD,
  SCRIPT_LIST_WINDOWS,
  SCRIPT_MONITORS,
  SCRIPT_MOUSE,
  SCRIPT_NOTIFY,
  SCRIPT_OCR,
  SCRIPT_OPEN,
  SCRIPT_SCREENSHOT,
  SCRIPT_SYSTEM_INFO,
  SCRIPT_WINDOW,
} from './scripts.js';
import { ArgError, type Args } from './validate.js';

const DEFAULT_TIMEOUT = 20000;
const OCR_TIMEOUT = 30000;

type Run = (args: Args, ctx: ToolContext) => Promise<CallToolResult>;

/** Input tools must not interleave (two simultaneous SendInput streams would garble each other). */
let inputQueue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = inputQueue.then(fn, fn);
  inputQueue = next.catch(() => undefined);
  return next;
}

function json(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function define(
  def: Omit<ToolDef, 'handler'> & { run: Run; serialized?: boolean },
): ToolDef {
  const { run, serialized, ...rest } = def;
  return {
    ...rest,
    async handler(args, ctx) {
      if (!hooks.isWindows()) return textResult(WINDOWS_ONLY, true);
      const exec = async (): Promise<CallToolResult> => {
        try {
          return await run(args ?? {}, ctx);
        } catch (e) {
          if (e instanceof ArgError || e instanceof KeyError || e instanceof PsError) {
            return textResult(e.message, true);
          }
          return textResult(`Unexpected error: ${(e as Error).message}`, true);
        }
      };
      return serialized ? serial(exec) : exec();
    },
  };
}

function ps(script: string, input: unknown, ctx: ToolContext, timeoutMs = DEFAULT_TIMEOUT) {
  return hooks.run(script, input, { timeoutMs, signal: ctx.signal });
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v);
}

const COORD_NOTE =
  'Coordinates are physical screen pixels in the Windows virtual desktop: origin (0,0) is the top-left of the PRIMARY monitor; ' +
  'monitors left of / above it have negative coordinates. The process is DPI-aware, so these match screenshot pixels at scale 1.';

const WORKFLOW =
  'Recommended workflow: desktop_screenshot -> locate the target (use desktop_ocr for exact text positions) -> act with desktop_mouse / desktop_keyboard -> verify with another desktop_screenshot.';

const targetProps = {
  monitor: { type: 'integer', minimum: 0, description: 'Monitor index from desktop_list_monitors (default: primary monitor).' },
  region: {
    type: 'object',
    description: 'Capture only this rectangle, in screen coordinates.',
    properties: {
      x: { type: 'integer' },
      y: { type: 'integer' },
      width: { type: 'integer', minimum: 1 },
      height: { type: 'integer', minimum: 1 },
    },
    required: ['x', 'y', 'width', 'height'],
  },
  window: { type: 'string', description: 'Capture the visible window whose title contains this text (case-insensitive). The capture is of the screen area, so windows covering it appear too; focus it first if needed.' },
  handle: { type: 'integer', description: 'Capture the window with this handle (from desktop_list_windows).' },
};

export function desktopTools(): ToolDef[] {
  const tools: ToolDef[] = [];
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const t = (risk: Risk, def: Omit<ToolDef, 'risk' | 'handler'> & { run: Run; serialized?: boolean }): void => {
    tools.push(define({ ...def, risk }));
  };

  t('read', {
    name: 'desktop_screenshot',
    description:
      'Capture the Windows screen (a monitor, a region, or a window) and return it as an image. ' +
      'The caption states the original capture size, the scale factor and the screen-coordinate offset of the image\'s top-left corner, so you can map image pixels back to screen coordinates: ' +
      'screenX = offsetX + imageX / scale, screenY = offsetY + imageY / scale. ' +
      `${COORD_NOTE} Large captures are downscaled to maxWidth (default 1600) to save tokens; pass a smaller region or a larger maxWidth for fine detail. ` +
      `Default format is JPEG quality 80; use png for pixel-exact text. ${WORKFLOW}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...targetProps,
        maxWidth: { type: 'integer', minimum: 100, maximum: 8000, default: 1600, description: 'Downscale the image to at most this width (never upscales).' },
        format: { type: 'string', enum: ['png', 'jpeg'], default: 'jpeg' },
        quality: { type: 'integer', minimum: 1, maximum: 100, default: 80, description: 'JPEG quality.' },
      },
    },
    annotations: { ...readOnly, title: 'Screenshot' },
    async run(args, ctx) {
      const input = parseScreenshot(args);
      const r = await ps(SCRIPT_SCREENSHOT, input, ctx);
      const width = num(r['width']);
      const height = num(r['height']);
      const outW = num(r['outWidth']);
      const outH = num(r['outHeight']);
      const scale = outW / width;
      const x = num(r['x']);
      const y = num(r['y']);
      const caption =
        `Screenshot of ${String(r['source'])}. Image: ${outW}x${outH}px. Original capture: ${width}x${height}px at screen offset (${x}, ${y}). ` +
        `Scale: ${scale.toFixed(4)} (image px = screen px * scale). ` +
        `To convert an image point to screen coordinates: screenX = ${x} + imageX / ${scale.toFixed(4)}, screenY = ${y} + imageY / ${scale.toFixed(4)}.`;
      return imageResult(String(r['b64']), caption, String(r['mime']));
    },
  });

  t('read', {
    name: 'desktop_ocr',
    description:
      'Run Windows OCR (Windows.Media.Ocr) on the screen, a monitor, a region or a window and return text lines with bounding boxes in SCREEN coordinates (x, y, width, height). ' +
      'Use `find` to return only the lines/words containing that text (case-insensitive) together with their center point (centerX, centerY), which you can pass straight to desktop_mouse click. ' +
      'Uses the user profile language, falling back to en-US; pass `language` (e.g. "tr", "en-US") to override if that language pack is installed. ' +
      `${COORD_NOTE} OCR can miss small, low-contrast or stylised text - verify with desktop_screenshot before clicking.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...targetProps,
        find: { type: 'string', description: 'Only return matches containing this text (case-insensitive).' },
        language: { type: 'string', description: 'BCP-47 OCR language tag, e.g. "en-US" or "tr".' },
      },
    },
    annotations: { ...readOnly, title: 'OCR' },
    async run(args, ctx) {
      const input = parseOcr(args);
      const r = await ps(SCRIPT_OCR, input, ctx, OCR_TIMEOUT);
      const lines = normalizeOcrLines(r['lines']);
      if (input.find) {
        const matches = findInOcr(lines, input.find);
        return json({ language: r['language'], region: r['region'], find: input.find, matchCount: matches.length, matches });
      }
      return json({
        language: r['language'],
        region: r['region'],
        lineCount: lines.length,
        lines: lines.map((l) => ({ text: l.text, x: l.x, y: l.y, width: l.width, height: l.height })),
      });
    },
  });

  t('read', {
    name: 'desktop_list_monitors',
    description:
      'List all monitors with index, primary flag, bounds and work area in screen coordinates, plus the virtual-screen rectangle and current cursor position. ' +
      COORD_NOTE,
    inputSchema: { type: 'object', properties: {} },
    annotations: { ...readOnly, title: 'List monitors' },
    async run(_args, ctx) {
      return json(await ps(SCRIPT_MONITORS, {}, ctx));
    },
  });

  t('read', {
    name: 'desktop_list_windows',
    description:
      'List visible top-level windows (front-to-back z-order): handle, title, process name, pid, rectangle (screen coords), minimized, maximized and focused flags. ' +
      'Use the handle with desktop_window / desktop_screenshot for unambiguous targeting. Optional `filter` keeps only titles containing that text.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Only windows whose title contains this text (case-insensitive).' },
        include_minimized: { type: 'boolean', default: true },
      },
    },
    annotations: { ...readOnly, title: 'List windows' },
    async run(args, ctx) {
      const input = parseListWindows(args);
      const r = await ps(SCRIPT_LIST_WINDOWS, input.filter ? { filter: input.filter } : {}, ctx);
      let windows = Array.isArray(r['windows']) ? (r['windows'] as Record<string, unknown>[]) : r['windows'] ? [r['windows'] as Record<string, unknown>] : [];
      if (!input.includeMinimized) windows = windows.filter((w) => !w['minimized']);
      return json({ count: windows.length, windows });
    },
  });

  t('control', {
    name: 'desktop_window',
    description:
      'Control a window: focus (reliably brings it to the foreground, restoring it if minimized), minimize, maximize, restore, close (sends WM_CLOSE - the app may ask to save), ' +
      'move (needs x,y) or resize (needs width,height). Identify the window by `handle` (preferred, from desktop_list_windows) or by `title` substring (case-insensitive; the focused match wins). ' +
      'Returns the window state afterwards. Focus a window before typing into it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['focus', 'minimize', 'maximize', 'restore', 'close', 'move', 'resize'] },
        handle: { type: 'integer' },
        title: { type: 'string', description: 'Substring of the window title.' },
        x: { type: 'integer', description: 'New left edge (move).' },
        y: { type: 'integer', description: 'New top edge (move).' },
        width: { type: 'integer', description: 'New width (resize).' },
        height: { type: 'integer', description: 'New height (resize).' },
      },
      required: ['action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, title: 'Window control' },
    serialized: true,
    async run(args, ctx) {
      return json(await ps(SCRIPT_WINDOW, parseWindow(args), ctx));
    },
  });

  t('control', {
    name: 'desktop_mouse',
    description:
      'Move/click/drag/scroll the mouse with real input events (SendInput). Actions: move, click, double_click, right_click, middle_click, drag (from x,y or current position to to_x,to_y), ' +
      'scroll (amount in wheel notches: positive = up, negative = down; set horizontal for sideways), position (read the cursor). ' +
      'x,y are screen coordinates (omit both to act at the current cursor position). Optional `modifiers` (ctrl, shift, alt, win) are held during the action, e.g. ctrl+click. ' +
      `${COORD_NOTE} ${WORKFLOW}`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'click', 'double_click', 'right_click', 'middle_click', 'drag', 'scroll', 'position'] },
        x: { type: 'integer', description: 'Target X in screen pixels.' },
        y: { type: 'integer', description: 'Target Y in screen pixels.' },
        to_x: { type: 'integer', description: 'Drag end X.' },
        to_y: { type: 'integer', description: 'Drag end Y.' },
        amount: { type: 'integer', minimum: -100, maximum: 100, description: 'Scroll notches: + up, - down.' },
        horizontal: { type: 'boolean', description: 'Scroll horizontally instead of vertically.' },
        modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'win'] }, description: 'Keys held during the action.' },
      },
      required: ['action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, title: 'Mouse' },
    serialized: true,
    async run(args, ctx) {
      return json(await ps(SCRIPT_MOUSE, parseMouse(args), ctx));
    },
  });

  t('control', {
    name: 'desktop_keyboard',
    description:
      'Send real keyboard input to the focused window. Actions: ' +
      '"type" - types literal Unicode text (any language, incl. Turkish characters; newline = Enter, tab = Tab; up to 10000 chars); ' +
      '"hotkey" - a key combination such as "ctrl+shift+esc", "win+r", "alt+tab", "ctrl+c", "alt+f4", "enter", "f5" (modifiers ctrl/shift/alt/win then one key); ' +
      '"press" - a single key, optionally repeated (e.g. key "down", repeat 5). Key names: a-z, 0-9, f1-f24, enter, esc, tab, space, backspace, delete, insert, home, end, pageup, pagedown, up/down/left/right, numpad0-9, volumeup/down/mute, punctuation. ' +
      'Make sure the right window has focus first (desktop_window focus) and verify with a screenshot. For very long text prefer desktop_clipboard_set then hotkey ctrl+v.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['type', 'hotkey', 'press'] },
        text: { type: 'string', description: 'Text to type (action "type").' },
        keys: { type: 'string', description: 'Hotkey like "ctrl+shift+esc" (action "hotkey").' },
        key: { type: 'string', description: 'Single key name (action "press").' },
        repeat: { type: 'integer', minimum: 1, maximum: 200, default: 1, description: 'Repeat count for "press".' },
        delay_ms: { type: 'integer', minimum: 0, maximum: 200, description: 'Delay between key events (default 8 for type, 15 otherwise).' },
      },
      required: ['action'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, title: 'Keyboard' },
    serialized: true,
    async run(args, ctx) {
      const input = parseKeyboard(args);
      return json(await ps(SCRIPT_KEYBOARD, input, ctx, keyboardTimeoutMs(input)));
    },
  });

  t('read', {
    name: 'desktop_clipboard_get',
    description:
      'Read the Windows clipboard text. Also reports whether the clipboard holds an image (with its size) or a list of files (with paths), which are not returned as content. Text is truncated to maxChars (default 20000).',
    inputSchema: { type: 'object', properties: { maxChars: { type: 'integer', minimum: 1, maximum: 1000000, default: 20000 } } },
    annotations: { ...readOnly, title: 'Clipboard (read)' },
    async run(args, ctx) {
      const { maxChars } = parseClipboardGet(args);
      const r = await ps(SCRIPT_CLIPBOARD_GET, {}, ctx);
      const text = typeof r['text'] === 'string' ? r['text'] : '';
      const truncated = text.length > maxChars;
      const files = Array.isArray(r['files']) ? r['files'] : r['files'] ? [r['files']] : [];
      return json({
        hasText: r['hasText'],
        text: truncated ? text.slice(0, maxChars) : text,
        truncated,
        totalLength: text.length,
        hasImage: r['hasImage'],
        ...(r['hasImage'] ? { imageWidth: r['imageWidth'], imageHeight: r['imageHeight'] } : {}),
        hasFiles: r['hasFiles'],
        files,
      });
    },
  });

  t('control', {
    name: 'desktop_clipboard_set',
    description: 'Replace the Windows clipboard contents with the given text (max 25000 characters; empty string clears it). Useful with desktop_keyboard hotkey ctrl+v to paste long text.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to place on the clipboard.' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, title: 'Clipboard (write)' },
    serialized: true,
    async run(args, ctx) {
      return json(await ps(SCRIPT_CLIPBOARD_SET, parseClipboardSet(args), ctx));
    },
  });

  t('exec', {
    name: 'desktop_open',
    description:
      'Open a URL (default browser), a file or folder (default app / Explorer), or launch an application by name ("notepad", "calc", "chrome", "code") or full path, via Start-Process. ' +
      'Optional `args` (array of strings; a plain string is split on spaces, honouring double quotes) are passed to the program. Returns the pid when Windows provides one (URLs and documents often have none). ' +
      'Follow with desktop_list_windows / desktop_screenshot to see the result.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'URL, file, folder, app name or full path to an executable.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments for the program.' },
      },
      required: ['target'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, title: 'Open' },
    async run(args, ctx) {
      return json(await ps(SCRIPT_OPEN, parseOpen(args), ctx));
    },
  });

  t('read', {
    name: 'desktop_system_info',
    description:
      'Snapshot of the PC: OS version, hostname, user, CPU model/cores/load, RAM total/free, fixed disks with free space, uptime, battery (if any), top 10 processes by CPU (percent of one core) and by memory, and IPv4 addresses of network adapters.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { ...readOnly, title: 'System info' },
    async run(_args, ctx) {
      return json(await ps(SCRIPT_SYSTEM_INFO, {}, ctx, 30000));
    },
  });

  t('control', {
    name: 'desktop_notify',
    description:
      'Show a Windows toast/balloon notification to the owner (title max 63 chars, message max 255). Use it to get the owner\'s attention or report completion; it does not wait for a click.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 63 },
        message: { type: 'string', maxLength: 255 },
      },
      required: ['title', 'message'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, title: 'Notify' },
    async run(args, ctx) {
      return json(await ps(SCRIPT_NOTIFY, parseNotify(args), ctx));
    },
  });

  t('read', {
    name: 'desktop_wait',
    description: 'Sleep for N milliseconds (1-30000) - use it to let a UI settle (app launch, page load, animation) before the next screenshot.',
    inputSchema: {
      type: 'object',
      properties: { ms: { type: 'integer', minimum: 1, maximum: 30000, description: 'Milliseconds to wait.' } },
      required: ['ms'],
    },
    annotations: { ...readOnly, title: 'Wait' },
    async run(args, ctx) {
      const { ms } = parseWait(args);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, ms);
        function done(): void {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', done);
          resolve();
        }
        ctx.signal?.addEventListener('abort', done, { once: true });
      });
      return textResult(ctx.signal?.aborted ? 'Wait aborted.' : `Waited ${ms} ms.`);
    },
  });

  return tools;
}
