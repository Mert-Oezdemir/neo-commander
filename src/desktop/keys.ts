/**
 * Key-name -> Windows virtual-key map and hotkey parsing. Pure functions (testable on any OS).
 */

export interface KeyInfo {
  vk: number;
  /** Needs KEYEVENTF_EXTENDEDKEY. */
  ext?: boolean;
}

/** One low-level keyboard event. */
export interface KeyEvent {
  vk: number;
  ext: boolean;
  up: boolean;
}

export const KEYEVENTF_EXTENDEDKEY = 1;
export const KEYEVENTF_KEYUP = 2;

export class KeyError extends Error {}

const K: Record<string, KeyInfo> = {};

function add(names: string[], vk: number, ext = false): void {
  for (const n of names) K[n] = ext ? { vk, ext: true } : { vk };
}

// Modifiers (left variants are used for injection).
add(['ctrl', 'control', 'lctrl', 'lcontrol'], 0xa2);
add(['rctrl', 'rcontrol'], 0xa3, true);
add(['shift', 'lshift'], 0xa0);
add(['rshift'], 0xa1);
add(['alt', 'menu', 'lalt', 'lmenu'], 0xa4);
add(['ralt', 'altgr', 'rmenu'], 0xa5, true);
add(['win', 'windows', 'meta', 'super', 'cmd', 'lwin'], 0x5b, true);
add(['rwin'], 0x5c, true);

// Editing / navigation.
add(['enter', 'return'], 0x0d);
add(['esc', 'escape'], 0x1b);
add(['tab'], 0x09);
add(['space', 'spacebar'], 0x20);
add(['backspace', 'bksp', 'back'], 0x08);
add(['delete', 'del'], 0x2e, true);
add(['insert', 'ins'], 0x2d, true);
add(['home'], 0x24, true);
add(['end'], 0x23, true);
add(['pageup', 'pgup', 'prior'], 0x21, true);
add(['pagedown', 'pgdn', 'pgdown', 'next'], 0x22, true);
add(['up', 'uparrow'], 0x26, true);
add(['down', 'downarrow'], 0x28, true);
add(['left', 'leftarrow'], 0x25, true);
add(['right', 'rightarrow'], 0x27, true);
add(['capslock', 'caps'], 0x14);
add(['numlock'], 0x90, true);
add(['scrolllock', 'scroll'], 0x91);
add(['printscreen', 'prtsc', 'prtscr', 'snapshot'], 0x2c, true);
add(['pause', 'break'], 0x13);
add(['apps', 'contextmenu'], 0x5d, true);

// Numpad.
for (let i = 0; i <= 9; i++) add([`numpad${i}`, `num${i}`], 0x60 + i);
add(['multiply', 'nummultiply', 'numpadmultiply'], 0x6a);
add(['add', 'numadd', 'numpadadd'], 0x6b);
add(['subtract', 'numsubtract', 'numpadsubtract'], 0x6d);
add(['decimal', 'numdecimal', 'numpaddecimal'], 0x6e);
add(['divide', 'numdivide', 'numpaddivide'], 0x6f, true);

// Punctuation (US layout virtual keys).
add([';', 'semicolon'], 0xba);
add(['=', 'equals', 'equal', 'plus', '+'], 0xbb);
add([',', 'comma'], 0xbc);
add(['-', 'minus', 'dash', 'hyphen'], 0xbd);
add(['.', 'period', 'dot'], 0xbe);
add(['/', 'slash'], 0xbf);
add(['`', 'backtick', 'grave', 'tilde'], 0xc0);
add(['[', 'lbracket', 'openbracket'], 0xdb);
add(['\\', 'backslash'], 0xdc);
add([']', 'rbracket', 'closebracket'], 0xdd);
add(["'", 'quote', 'apostrophe'], 0xde);

// Media / browser.
add(['volumemute', 'mute'], 0xad);
add(['volumedown'], 0xae);
add(['volumeup'], 0xaf);
add(['medianext', 'nexttrack'], 0xb0);
add(['mediaprev', 'prevtrack'], 0xb1);
add(['mediastop'], 0xb2);
add(['mediaplaypause', 'playpause'], 0xb3);
add(['browserback'], 0xa6);
add(['browserforward'], 0xa7);
add(['browserrefresh'], 0xa8);
add(['browserhome'], 0xac);

// Letters and digits.
for (let c = 0x41; c <= 0x5a; c++) add([String.fromCharCode(c).toLowerCase()], c);
for (let d = 0; d <= 9; d++) add([String(d)], 0x30 + d);
// Function keys F1..F24.
for (let f = 1; f <= 24; f++) add([`f${f}`], 0x6f + f);

/** Modifier names accepted in hotkeys (canonical lowercase). */
const MODIFIER_NAMES = new Set([
  'ctrl', 'control', 'lctrl', 'lcontrol', 'rctrl', 'rcontrol',
  'shift', 'lshift', 'rshift',
  'alt', 'menu', 'lalt', 'lmenu', 'ralt', 'altgr', 'rmenu',
  'win', 'windows', 'meta', 'super', 'cmd', 'lwin', 'rwin',
]);

export function isModifierName(name: string): boolean {
  return MODIFIER_NAMES.has(name.trim().toLowerCase());
}

export function lookupKey(name: string): KeyInfo | undefined {
  const k = name.trim().toLowerCase();
  const hit = Object.prototype.hasOwnProperty.call(K, k) ? K[k] : undefined;
  return hit;
}

export function knownKeyNames(): string[] {
  return Object.keys(K);
}

function mustLookup(name: string): KeyInfo {
  const info = lookupKey(name);
  if (!info) {
    throw new KeyError(
      `Unknown key "${name}". Use names like ctrl, shift, alt, win, enter, esc, tab, space, backspace, delete, ` +
        `home, end, pageup, pagedown, up/down/left/right, f1..f24, a..z, 0..9, numpad0..9, or punctuation. ` +
        `To enter literal text use the "type" action instead.`,
    );
  }
  return info;
}

/** Split "ctrl+shift+esc" into tokens; supports a literal plus key ("ctrl++" or "ctrl+plus"). */
export function splitHotkey(spec: string): string[] {
  let s = spec.trim();
  if (!s) throw new KeyError('Hotkey is empty. Example: "ctrl+shift+esc".');
  const tokens: string[] = [];
  if (s === '+') return ['plus'];
  if (s.endsWith('++')) {
    s = s.slice(0, -2);
    tokens.push(...s.split('+'), 'plus');
  } else {
    tokens.push(...s.split('+'));
  }
  const out = tokens.map((t) => t.trim().toLowerCase());
  if (out.some((t) => t === '')) throw new KeyError(`Malformed hotkey "${spec}". Example: "ctrl+shift+esc".`);
  return out;
}

/**
 * Parse a hotkey string into the exact key-event sequence:
 * modifiers down (in order), main key down, main key up, modifiers up (reverse order).
 */
export function parseHotkey(spec: string): KeyEvent[] {
  const tokens = splitHotkey(spec);
  const main = tokens[tokens.length - 1] as string;
  const mods = tokens.slice(0, -1);
  for (const m of mods) {
    if (!isModifierName(m)) {
      throw new KeyError(
        `"${m}" in "${spec}" is not a modifier. Only ctrl, shift, alt and win may precede the final key.`,
      );
    }
  }
  const events: KeyEvent[] = [];
  const modInfos = mods.map(mustLookup);
  const mainInfo = mustLookup(main);
  for (const m of modInfos) events.push({ vk: m.vk, ext: !!m.ext, up: false });
  events.push({ vk: mainInfo.vk, ext: !!mainInfo.ext, up: false });
  events.push({ vk: mainInfo.vk, ext: !!mainInfo.ext, up: true });
  for (const m of [...modInfos].reverse()) events.push({ vk: m.vk, ext: !!m.ext, up: true });
  return events;
}

/** Press a single key `repeat` times (down+up each). */
export function pressKey(name: string, repeat = 1): KeyEvent[] {
  const info = mustLookup(name);
  const events: KeyEvent[] = [];
  for (let i = 0; i < repeat; i++) {
    events.push({ vk: info.vk, ext: !!info.ext, up: false });
    events.push({ vk: info.vk, ext: !!info.ext, up: true });
  }
  return events;
}

/** Hold-modifier events for mouse actions (down list, up list in reverse). */
export function modifierVks(mods: string[]): number[] {
  return mods.map((m) => {
    if (!isModifierName(m)) throw new KeyError(`"${m}" is not a modifier (use ctrl, shift, alt, win).`);
    return mustLookup(m).vk;
  });
}

/** Convert events to the parallel arrays the PowerShell side consumes. */
export function toArrays(events: KeyEvent[]): { vks: number[]; flags: number[] } {
  return {
    vks: events.map((e) => e.vk),
    flags: events.map((e) => (e.ext ? KEYEVENTF_EXTENDEDKEY : 0) | (e.up ? KEYEVENTF_KEYUP : 0)),
  };
}
