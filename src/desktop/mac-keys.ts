/**
 * macOS key-name -> CGKeyCode map and hotkey parsing. Pure functions (testable on any OS).
 *
 * Key codes are the ANSI/US-layout `kVK_*` virtual key codes from Carbon's Events.h. They are physical key
 * positions, so punctuation names refer to the US layout (like the Windows map). Modifiers are applied as
 * CGEventFlags on every posted event AND as real modifier key down/up events around the main key (needed by
 * system shortcuts such as cmd+tab).
 *
 * "ctrl" stays ctrl on macOS; "cmd" is the Command key; "win", "windows", "meta", "super" are accepted as aliases
 * of "cmd" so one hotkey string works on both platforms (win+r -> cmd+r is NOT remapped semantically, only the key).
 */
import { KeyError } from './keys.js';

export { KeyError };

/** CGEventFlags masks. */
export const FLAG_SHIFT = 0x20000;
export const FLAG_CTRL = 0x40000;
export const FLAG_ALT = 0x80000;
export const FLAG_CMD = 0x100000;
export const FLAG_FN = 0x800000;

export interface MacKeyInfo {
  /** kVK_* virtual key code (regular keys). */
  code?: number;
  /** NX_KEYTYPE_* media key (posted as NSSystemDefined event instead of a keyboard event). */
  aux?: number;
}

export interface MacModifierInfo {
  code: number;
  flag: number;
}

/** One low-level event the JXA side posts. */
export type MacKeyEvent =
  | { t: 'key'; code: number; down: boolean; flags: number }
  | { t: 'aux'; aux: number; down: boolean };

const K: Record<string, MacKeyInfo> = {};
const M: Record<string, MacModifierInfo> = {};

function add(names: string[], info: MacKeyInfo): void {
  for (const n of names) K[n] = info;
}
function addMod(names: string[], code: number, flag: number): void {
  for (const n of names) M[n] = { code, flag };
}

// Modifiers.
addMod(['ctrl', 'control', 'lctrl', 'lcontrol'], 59, FLAG_CTRL);
addMod(['rctrl', 'rcontrol'], 62, FLAG_CTRL);
addMod(['shift', 'lshift'], 56, FLAG_SHIFT);
addMod(['rshift'], 60, FLAG_SHIFT);
addMod(['alt', 'option', 'opt', 'menu', 'lalt', 'loption', 'lmenu'], 58, FLAG_ALT);
addMod(['ralt', 'roption', 'altgr', 'rmenu'], 61, FLAG_ALT);
addMod(['cmd', 'command', 'win', 'windows', 'meta', 'super', 'lcmd', 'lwin'], 55, FLAG_CMD);
addMod(['rcmd', 'rcommand', 'rwin'], 54, FLAG_CMD);
addMod(['fn', 'function'], 63, FLAG_FN);

// Editing / navigation.
add(['enter', 'return'], { code: 36 });
add(['esc', 'escape'], { code: 53 });
add(['tab'], { code: 48 });
add(['space', 'spacebar'], { code: 49 });
add(['backspace', 'bksp', 'back'], { code: 51 }); // the key labelled "delete" on a Mac keyboard
add(['delete', 'del', 'forwarddelete'], { code: 117 }); // forward delete (fn+delete), same as Windows "delete"
add(['insert', 'ins', 'help'], { code: 114 });
add(['home'], { code: 115 });
add(['end'], { code: 119 });
add(['pageup', 'pgup', 'prior'], { code: 116 });
add(['pagedown', 'pgdn', 'pgdown', 'next'], { code: 121 });
add(['up', 'uparrow'], { code: 126 });
add(['down', 'downarrow'], { code: 125 });
add(['left', 'leftarrow'], { code: 123 });
add(['right', 'rightarrow'], { code: 124 });
add(['capslock', 'caps'], { code: 57 });
add(['numlock'], { code: 71 }); // keypad clear
add(['apps', 'contextmenu'], { code: 110 });

// Numpad.
const KEYPAD = [82, 83, 84, 85, 86, 87, 88, 89, 91, 92];
KEYPAD.forEach((c, i) => add([`numpad${i}`, `num${i}`], { code: c }));
add(['multiply', 'nummultiply', 'numpadmultiply'], { code: 67 });
add(['add', 'numadd', 'numpadadd'], { code: 69 });
add(['subtract', 'numsubtract', 'numpadsubtract'], { code: 78 });
add(['decimal', 'numdecimal', 'numpaddecimal'], { code: 65 });
add(['divide', 'numdivide', 'numpaddivide'], { code: 75 });
add(['numpadenter'], { code: 76 });

// Punctuation (ANSI layout).
add([';', 'semicolon'], { code: 41 });
add(['=', 'equals', 'equal', 'plus', '+'], { code: 24 });
add([',', 'comma'], { code: 43 });
add(['-', 'minus', 'dash', 'hyphen'], { code: 27 });
add(['.', 'period', 'dot'], { code: 47 });
add(['/', 'slash'], { code: 44 });
add(['`', 'backtick', 'grave', 'tilde'], { code: 50 });
add(['[', 'lbracket', 'openbracket'], { code: 33 });
add(['\\', 'backslash'], { code: 42 });
add([']', 'rbracket', 'closebracket'], { code: 30 });
add(["'", 'quote', 'apostrophe'], { code: 39 });

// Media keys (NX_KEYTYPE_*).
add(['volumeup'], { aux: 0 });
add(['volumedown'], { aux: 1 });
add(['volumemute', 'mute'], { aux: 7 });
add(['mediaplaypause', 'playpause'], { aux: 16 });
add(['medianext', 'nexttrack'], { aux: 17 });
add(['mediaprev', 'prevtrack'], { aux: 18 });

// Letters (kVK_ANSI_*), in alphabetical order.
const LETTERS: Record<string, number> = {
  a: 0, b: 11, c: 8, d: 2, e: 14, f: 3, g: 5, h: 4, i: 34, j: 38, k: 40, l: 37, m: 46,
  n: 45, o: 31, p: 35, q: 12, r: 15, s: 1, t: 17, u: 32, v: 9, w: 13, x: 7, y: 16, z: 6,
};
for (const [l, c] of Object.entries(LETTERS)) add([l], { code: c });
// Digits (top row).
const DIGITS = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
DIGITS.forEach((c, d) => add([String(d)], { code: c }));
// Function keys F1..F20 (macOS has no F21..F24).
const FKEYS = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90];
FKEYS.forEach((c, i) => add([`f${i + 1}`], { code: c }));

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function isMacModifierName(name: string): boolean {
  return has(M, name.trim().toLowerCase());
}

export function lookupMacKey(name: string): MacKeyInfo | undefined {
  const k = name.trim().toLowerCase();
  return has(K, k) ? K[k] : undefined;
}

export function lookupMacModifier(name: string): MacModifierInfo | undefined {
  const k = name.trim().toLowerCase();
  return has(M, k) ? M[k] : undefined;
}

export function knownMacKeyNames(): string[] {
  return [...Object.keys(K), ...Object.keys(M)];
}

function unknownKey(name: string): KeyError {
  if (/^f(2[1-4])$/i.test(name.trim())) {
    return new KeyError(`Key "${name}" does not exist on macOS (function keys go up to f20).`);
  }
  return new KeyError(
    `Unknown key "${name}". Use names like ctrl, shift, alt (option), cmd (command; win/meta/super are aliases), fn, enter, esc, tab, space, ` +
      `backspace, delete (forward delete), home, end, pageup, pagedown, up/down/left/right, f1..f20, a..z, 0..9, numpad0..9, or punctuation. ` +
      `To enter literal text use the "type" action instead.`,
  );
}

function mustKey(name: string): MacKeyInfo {
  const info = lookupMacKey(name);
  if (info) return info;
  const mod = lookupMacModifier(name);
  if (mod) return { code: mod.code };
  throw unknownKey(name);
}

/** Split "cmd+shift+4" into lower-case tokens; supports literal plus ("cmd++" or "cmd+plus"). */
export function splitMacHotkey(spec: string): string[] {
  let s = spec.trim();
  if (!s) throw new KeyError('Hotkey is empty. Example: "cmd+shift+4".');
  if (s === '+') return ['plus'];
  const tokens: string[] = [];
  if (s.endsWith('++')) {
    s = s.slice(0, -2);
    tokens.push(...s.split('+'), 'plus');
  } else {
    tokens.push(...s.split('+'));
  }
  const out = tokens.map((t) => t.trim().toLowerCase());
  if (out.some((t) => t === '')) throw new KeyError(`Malformed hotkey "${spec}". Example: "cmd+shift+4".`);
  return out;
}

/** Sum of CGEventFlags for modifier names (ctrl, shift, alt/option, cmd/win/meta/super, fn). */
export function macModifierFlags(names: string[]): number {
  let flags = 0;
  for (const n of names) {
    const m = lookupMacModifier(n);
    if (!m) throw new KeyError(`"${n}" is not a modifier (use ctrl, shift, alt, cmd, fn; win/meta/super mean cmd).`);
    flags |= m.flag;
  }
  return flags;
}

function mainEvents(info: MacKeyInfo, flags: number, down: boolean): MacKeyEvent {
  if (info.aux !== undefined) return { t: 'aux', aux: info.aux, down };
  return { t: 'key', code: info.code as number, down, flags };
}

/**
 * Parse a hotkey into the exact event sequence: modifiers down (in order, cumulative flags), main key down+up
 * (carrying all flags), modifiers up (reverse order, shrinking flags).
 */
export function parseMacHotkey(spec: string): MacKeyEvent[] {
  const tokens = splitMacHotkey(spec);
  const main = tokens[tokens.length - 1] as string;
  const mods = tokens.slice(0, -1);
  for (const m of mods) {
    if (!isMacModifierName(m)) {
      throw new KeyError(`"${m}" in "${spec}" is not a modifier. Only ctrl, shift, alt, cmd and fn may precede the final key.`);
    }
  }
  const modInfos = mods.map((m) => lookupMacModifier(m) as MacModifierInfo);
  const mainIsMod = lookupMacKey(main) === undefined && lookupMacModifier(main) !== undefined;
  const mainInfo = mustKey(main);
  const events: MacKeyEvent[] = [];
  let flags = 0;
  for (const m of modInfos) {
    flags |= m.flag;
    events.push({ t: 'key', code: m.code, down: true, flags });
  }
  const mainFlagsDown = mainIsMod ? flags | (lookupMacModifier(main) as MacModifierInfo).flag : flags;
  events.push(mainEvents(mainInfo, mainFlagsDown, true));
  events.push(mainEvents(mainInfo, flags, false));
  for (let i = modInfos.length - 1; i >= 0; i--) {
    const m = modInfos[i] as MacModifierInfo;
    // Recompute: flags still held after releasing modifier i (earlier modifiers remain down).
    let remaining = 0;
    for (let j = 0; j < i; j++) remaining |= (modInfos[j] as MacModifierInfo).flag;
    events.push({ t: 'key', code: m.code, down: false, flags: remaining });
  }
  return events;
}

/** Press a single key `repeat` times (down+up each). */
export function pressMacKey(name: string, repeat = 1): MacKeyEvent[] {
  const mod = lookupMacKey(name) === undefined ? lookupMacModifier(name) : undefined;
  const info = mustKey(name);
  const events: MacKeyEvent[] = [];
  for (let i = 0; i < repeat; i++) {
    events.push(mainEvents(info, mod ? mod.flag : 0, true));
    events.push(mainEvents(info, 0, false));
  }
  return events;
}
