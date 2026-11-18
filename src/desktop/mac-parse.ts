/** macOS-specific argument parsing for the input tools (modifiers are CGEventFlags, keys are kVK codes). */
import { ArgError, enumOf, optInt, optStringArray, reqString, type Args } from './validate.js';
import { MAX_TYPE_CHARS, parseMouse, type MouseInput } from './parse.js';
import { KeyError, macModifierFlags, parseMacHotkey, pressMacKey, type MacKeyEvent } from './mac-keys.js';

export interface MacMouseInput extends Omit<MouseInput, 'mods'> {
  flags: number;
}

export function parseMouseMac(a: Args): MacMouseInput {
  const { modifiers, ...rest } = a;
  const base = parseMouse(rest);
  const { mods: _unused, ...out } = base;
  void _unused;
  const names = optStringArray({ modifiers }, 'modifiers', 4, 20);
  let flags = 0;
  if (names && names.length > 0) {
    try {
      flags = macModifierFlags(names);
    } catch (e) {
      throw new ArgError((e as Error).message);
    }
  }
  return { ...out, flags };
}

export interface MacKeyboardInput {
  kind: 'type' | 'hotkey' | 'press';
  text?: string;
  events?: MacKeyEvent[];
  delay: number;
}

export function parseKeyboardMac(a: Args): MacKeyboardInput {
  const kind = enumOf(a, 'action', ['type', 'hotkey', 'press'] as const);
  const delayOpt = optInt(a, 'delay_ms', 0, 200);
  if (kind === 'type') {
    return { kind, text: reqString(a, 'text', MAX_TYPE_CHARS), delay: delayOpt ?? 8 };
  }
  try {
    if (kind === 'hotkey') {
      return { kind, events: parseMacHotkey(reqString(a, 'keys', 100)), delay: delayOpt ?? 15 };
    }
    const key = reqString(a, 'key', 40);
    const repeat = optInt(a, 'repeat', 1, 200) ?? 1;
    return { kind, events: pressMacKey(key, repeat), delay: delayOpt ?? 15 };
  } catch (e) {
    if (e instanceof KeyError) throw new ArgError(e.message);
    throw e;
  }
}

/** Timeout budget for a keyboard call (JXA start-up + per-event cost). */
export function macKeyboardTimeoutMs(k: MacKeyboardInput): number {
  const events = k.kind === 'type' ? (k.text?.length ?? 0) * 2 : (k.events?.length ?? 0);
  return Math.min(180000, Math.max(20000, 8000 + events * (k.delay + 4)));
}

