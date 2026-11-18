import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KeyError, lookupKey, modifierVks, parseHotkey, pressKey, splitHotkey, toArrays } from './keys.js';
import { center, denormalizeAbs, imageToScreen, normalizeAbs, unionBox } from './math.js';

describe('key map', () => {
  it('maps letters, digits, function keys', () => {
    assert.equal(lookupKey('a')?.vk, 0x41);
    assert.equal(lookupKey('Z')?.vk, 0x5a);
    assert.equal(lookupKey('0')?.vk, 0x30);
    assert.equal(lookupKey('f1')?.vk, 0x70);
    assert.equal(lookupKey('F12')?.vk, 0x7b);
    assert.equal(lookupKey('f24')?.vk, 0x87);
  });
  it('maps named keys with extended flag where needed', () => {
    assert.deepEqual(lookupKey('enter'), { vk: 0x0d });
    assert.deepEqual(lookupKey('esc'), { vk: 0x1b });
    assert.deepEqual(lookupKey('delete'), { vk: 0x2e, ext: true });
    assert.deepEqual(lookupKey('left'), { vk: 0x25, ext: true });
    assert.deepEqual(lookupKey('win'), { vk: 0x5b, ext: true });
    assert.equal(lookupKey('numpad5')?.vk, 0x65);
    assert.equal(lookupKey('nonsense'), undefined);
    assert.equal(lookupKey('constructor'), undefined);
  });
});

describe('hotkey parsing', () => {
  it('splits tokens, including literal plus', () => {
    assert.deepEqual(splitHotkey('Ctrl+Shift+Esc'), ['ctrl', 'shift', 'esc']);
    assert.deepEqual(splitHotkey('ctrl++'), ['ctrl', 'plus']);
    assert.deepEqual(splitHotkey('+'), ['plus']);
  });
  it('builds down/up sequence for ctrl+shift+esc', () => {
    const ev = parseHotkey('ctrl+shift+esc');
    assert.deepEqual(
      ev.map((e) => [e.vk, e.up]),
      [[0xa2, false], [0xa0, false], [0x1b, false], [0x1b, true], [0xa0, true], [0xa2, true]],
    );
  });
  it('single key and win+r', () => {
    assert.equal(parseHotkey('f5').length, 2);
    const ev = parseHotkey('win+r');
    assert.equal(ev[0]?.vk, 0x5b);
    assert.equal(ev[0]?.ext, true);
    assert.equal(ev[1]?.vk, 0x52);
  });
  it('rejects malformed input', () => {
    assert.throws(() => parseHotkey(''), KeyError);
    assert.throws(() => parseHotkey('ctrl+'), KeyError);
    assert.throws(() => parseHotkey('a+b'), KeyError);
    assert.throws(() => parseHotkey('ctrl+foo'), KeyError);
  });
  it('press repeats and toArrays flags', () => {
    const ev = pressKey('delete', 3);
    assert.equal(ev.length, 6);
    const { vks, flags } = toArrays(ev);
    assert.equal(vks[0], 0x2e);
    assert.deepEqual(flags.slice(0, 2), [1, 3]);
    assert.throws(() => pressKey('bogus'), KeyError);
  });
  it('modifierVks', () => {
    assert.deepEqual(modifierVks(['ctrl', 'shift']), [0xa2, 0xa0]);
    assert.throws(() => modifierVks(['enter']), KeyError);
  });
});

describe('coordinate math', () => {
  it('normalizes the virtual screen corners', () => {
    assert.equal(normalizeAbs(0, 0, 1920), 0);
    assert.equal(normalizeAbs(1919, 0, 1920), 65502);
    assert.equal(normalizeAbs(5000, 0, 1920), 65535);
    assert.equal(normalizeAbs(-5, 0, 1920), 0);
  });
  it('handles negative-origin multi-monitor', () => {
    // virtual screen x from -1920 to 1920 (width 3840)
    assert.equal(normalizeAbs(-1920, -1920, 3840), 0);
    assert.equal(normalizeAbs(0, -1920, 3840), 32768);
  });
  it('round-trips to the exact pixel for every x on common sizes', () => {
    for (const [origin, size] of [[0, 1920], [-1920, 3840], [0, 2560], [0, 7680], [-2560, 6000]] as const) {
      for (let x = origin; x < origin + size; x += 7) {
        assert.equal(denormalizeAbs(normalizeAbs(x, origin, size), origin, size), x, `x=${x} size=${size}`);
      }
      const last = origin + size - 1;
      assert.equal(denormalizeAbs(normalizeAbs(last, origin, size), origin, size), last);
    }
  });
  it('maps image points back to screen coordinates', () => {
    assert.deepEqual(imageToScreen(100, 50, 1920, 0, 0.5), { x: 2120, y: 100 });
  });
  it('boxes', () => {
    const u = unionBox([{ x: 10, y: 10, width: 5, height: 5 }, { x: 20, y: 12, width: 10, height: 2 }]);
    assert.deepEqual(u, { x: 10, y: 10, width: 20, height: 5 });
    assert.deepEqual(center(u), { x: 20, y: 13 });
  });
});
