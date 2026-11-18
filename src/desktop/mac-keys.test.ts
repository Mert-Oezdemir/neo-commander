import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FLAG_ALT,
  FLAG_CMD,
  FLAG_CTRL,
  FLAG_SHIFT,
  isMacModifierName,
  KeyError,
  lookupMacKey,
  lookupMacModifier,
  macModifierFlags,
  parseMacHotkey,
  pressMacKey,
  splitMacHotkey,
} from './mac-keys.js';
import { macKeyboardTimeoutMs, parseKeyboardMac, parseMouseMac } from './mac-parse.js';
import { ArgError } from './validate.js';

describe('mac key map', () => {
  it('maps letters, digits and function keys to kVK codes', () => {
    assert.equal(lookupMacKey('a')?.code, 0);
    assert.equal(lookupMacKey('s')?.code, 1);
    assert.equal(lookupMacKey('z')?.code, 6);
    assert.equal(lookupMacKey('v')?.code, 9);
    assert.equal(lookupMacKey('q')?.code, 12);
    assert.equal(lookupMacKey('1')?.code, 18);
    assert.equal(lookupMacKey('0')?.code, 29);
    assert.equal(lookupMacKey('f1')?.code, 122);
    assert.equal(lookupMacKey('F12')?.code, 111);
    assert.equal(lookupMacKey('f20')?.code, 90);
  });
  it('has a unique code for every letter and digit', () => {
    const codes = new Set<number>();
    for (const k of 'abcdefghijklmnopqrstuvwxyz0123456789') {
      const c = lookupMacKey(k)?.code;
      assert.ok(c !== undefined, k);
      assert.ok(!codes.has(c), `duplicate code for ${k}`);
      codes.add(c);
    }
    assert.equal(codes.size, 36);
  });
  it('maps navigation/editing keys; backspace vs forward delete', () => {
    assert.equal(lookupMacKey('enter')?.code, 36);
    assert.equal(lookupMacKey('return')?.code, 36);
    assert.equal(lookupMacKey('esc')?.code, 53);
    assert.equal(lookupMacKey('tab')?.code, 48);
    assert.equal(lookupMacKey('space')?.code, 49);
    assert.equal(lookupMacKey('backspace')?.code, 51);
    assert.equal(lookupMacKey('delete')?.code, 117);
    assert.equal(lookupMacKey('left')?.code, 123);
    assert.equal(lookupMacKey('right')?.code, 124);
    assert.equal(lookupMacKey('down')?.code, 125);
    assert.equal(lookupMacKey('up')?.code, 126);
    assert.equal(lookupMacKey('home')?.code, 115);
    assert.equal(lookupMacKey('pagedown')?.code, 121);
    assert.equal(lookupMacKey('numpad5')?.code, 87);
    assert.equal(lookupMacKey('numpad9')?.code, 92);
  });
  it('media keys are aux events, unknown keys are undefined', () => {
    assert.deepEqual(lookupMacKey('volumeup'), { aux: 0 });
    assert.deepEqual(lookupMacKey('volumedown'), { aux: 1 });
    assert.deepEqual(lookupMacKey('mute'), { aux: 7 });
    assert.equal(lookupMacKey('nonsense'), undefined);
    assert.equal(lookupMacKey('constructor'), undefined);
    assert.equal(lookupMacKey('f24'), undefined);
  });
  it('modifiers: ctrl stays ctrl, cmd has win/meta/super aliases', () => {
    assert.deepEqual(lookupMacModifier('ctrl'), { code: 59, flag: FLAG_CTRL });
    assert.deepEqual(lookupMacModifier('shift'), { code: 56, flag: FLAG_SHIFT });
    assert.deepEqual(lookupMacModifier('alt'), { code: 58, flag: FLAG_ALT });
    assert.deepEqual(lookupMacModifier('option'), { code: 58, flag: FLAG_ALT });
    for (const n of ['cmd', 'command', 'win', 'windows', 'meta', 'super']) {
      assert.deepEqual(lookupMacModifier(n), { code: 55, flag: FLAG_CMD }, n);
    }
    assert.equal(isMacModifierName('Win'), true);
    assert.equal(isMacModifierName('enter'), false);
    assert.equal(macModifierFlags(['cmd', 'shift']), FLAG_CMD | FLAG_SHIFT);
    assert.throws(() => macModifierFlags(['a']), KeyError);
  });
  it('CGEventFlags values match Apple headers', () => {
    assert.equal(FLAG_SHIFT, 0x20000);
    assert.equal(FLAG_CTRL, 0x40000);
    assert.equal(FLAG_ALT, 0x80000);
    assert.equal(FLAG_CMD, 0x100000);
  });
});

describe('mac hotkey parsing', () => {
  it('splits tokens incl. literal plus', () => {
    assert.deepEqual(splitMacHotkey('Cmd+Shift+4'), ['cmd', 'shift', '4']);
    assert.deepEqual(splitMacHotkey('cmd++'), ['cmd', 'plus']);
  });
  it('cmd+shift+4: modifiers down with growing flags, key carries all flags, release reversed', () => {
    const ev = parseMacHotkey('cmd+shift+4');
    assert.deepEqual(ev, [
      { t: 'key', code: 55, down: true, flags: FLAG_CMD },
      { t: 'key', code: 56, down: true, flags: FLAG_CMD | FLAG_SHIFT },
      { t: 'key', code: 21, down: true, flags: FLAG_CMD | FLAG_SHIFT },
      { t: 'key', code: 21, down: false, flags: FLAG_CMD | FLAG_SHIFT },
      { t: 'key', code: 56, down: false, flags: FLAG_CMD },
      { t: 'key', code: 55, down: false, flags: 0 },
    ]);
  });
  it('win+r and meta+r mean cmd+r; ctrl+c stays control', () => {
    assert.deepEqual(parseMacHotkey('win+r')[0], { t: 'key', code: 55, down: true, flags: FLAG_CMD });
    assert.equal(parseMacHotkey('meta+r')[1]?.t === 'key' && (parseMacHotkey('meta+r')[1] as { code: number }).code, 15);
    const cc = parseMacHotkey('ctrl+c');
    assert.deepEqual(cc[0], { t: 'key', code: 59, down: true, flags: FLAG_CTRL });
    assert.deepEqual(cc[1], { t: 'key', code: 8, down: true, flags: FLAG_CTRL });
  });
  it('single keys, modifier-only keys and aux keys', () => {
    assert.equal(parseMacHotkey('f5').length, 2);
    const shift = parseMacHotkey('shift');
    assert.deepEqual(shift[0], { t: 'key', code: 56, down: true, flags: FLAG_SHIFT });
    assert.deepEqual(shift[1], { t: 'key', code: 56, down: false, flags: 0 });
    assert.deepEqual(parseMacHotkey('volumeup'), [
      { t: 'aux', aux: 0, down: true },
      { t: 'aux', aux: 0, down: false },
    ]);
  });
  it('rejects malformed input and non-existent keys', () => {
    assert.throws(() => parseMacHotkey(''), KeyError);
    assert.throws(() => parseMacHotkey('cmd+'), KeyError);
    assert.throws(() => parseMacHotkey('a+b'), KeyError);
    assert.throws(() => parseMacHotkey('cmd+foo'), KeyError);
    assert.throws(() => parseMacHotkey('cmd+f21'), /does not exist on macOS/);
  });
  it('press repeats', () => {
    const ev = pressMacKey('delete', 3);
    assert.equal(ev.length, 6);
    assert.deepEqual(ev[0], { t: 'key', code: 117, down: true, flags: 0 });
    assert.throws(() => pressMacKey('bogus'), KeyError);
  });
});

describe('mac argument parsing', () => {
  it('keyboard: type keeps text, hotkey/press produce events, defaults match Windows', () => {
    assert.deepEqual(parseKeyboardMac({ action: 'type', text: 'Merhaba ğüşiöçİ' }), { kind: 'type', text: 'Merhaba ğüşiöçİ', delay: 8 });
    const h = parseKeyboardMac({ action: 'hotkey', keys: 'cmd+c' });
    assert.equal(h.delay, 15);
    assert.equal(h.events?.length, 4);
    assert.equal(parseKeyboardMac({ action: 'press', key: 'down', repeat: 5 }).events?.length, 10);
  });
  it('keyboard: invalid input is an ArgError', () => {
    assert.throws(() => parseKeyboardMac({ action: 'hotkey', keys: 'cmd+nope' }), ArgError);
    assert.throws(() => parseKeyboardMac({ action: 'type' }), ArgError);
    assert.throws(() => parseKeyboardMac({ action: 'nope' }), ArgError);
  });
  it('mouse: modifiers become CGEventFlags, validation is shared with Windows', () => {
    const m = parseMouseMac({ action: 'click', x: 10, y: 20, modifiers: ['cmd', 'shift'] });
    assert.deepEqual(m, { kind: 'click', x: 10, y: 20, flags: FLAG_CMD | FLAG_SHIFT });
    assert.equal(parseMouseMac({ action: 'scroll', amount: -3, horizontal: true, modifiers: ['win'] }).flags, FLAG_CMD);
    assert.equal(parseMouseMac({ action: 'position' }).flags, 0);
    assert.throws(() => parseMouseMac({ action: 'click', x: 'abc', y: 1 }), ArgError);
    assert.throws(() => parseMouseMac({ action: 'click', x: 1 }), ArgError);
    assert.throws(() => parseMouseMac({ action: 'click', x: 1, y: 1, modifiers: ['enter'] }), ArgError);
    assert.throws(() => parseMouseMac({ action: 'drag', x: 1, y: 1 }), ArgError);
  });
  it('keyboard timeout grows with text length', () => {
    const short = macKeyboardTimeoutMs({ kind: 'type', text: 'a', delay: 8 });
    const long = macKeyboardTimeoutMs({ kind: 'type', text: 'a'.repeat(10000), delay: 8 });
    assert.ok(long > short);
    assert.ok(long <= 180000);
  });
});
