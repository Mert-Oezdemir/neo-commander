import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findInOcr,
  keyboardTimeoutMs,
  normalizeOcrLines,
  parseClipboardSet,
  parseKeyboard,
  parseMouse,
  parseNotify,
  parseOcr,
  parseOpen,
  parseScreenshot,
  parseWait,
  parseWindow,
  splitArgs,
} from './parse.js';
import { ArgError } from './validate.js';

describe('argument validation', () => {
  it('screenshot defaults and ranges', () => {
    const s = parseScreenshot({});
    assert.deepEqual(s, { maxWidth: 1600, format: 'jpeg', quality: 80 });
    assert.equal(parseScreenshot({ format: 'PNG', maxWidth: '800' }).maxWidth, 800);
    assert.throws(() => parseScreenshot({ maxWidth: 10 }), ArgError);
    assert.throws(() => parseScreenshot({ format: 'gif' }), ArgError);
    assert.throws(() => parseScreenshot({ monitor: -1 }), ArgError);
    assert.throws(() => parseScreenshot({ region: { x: 0, y: 0, width: 0, height: 5 } }), ArgError);
    assert.throws(() => parseScreenshot({ region: { x: 0, y: 0, width: 5, height: 5 }, window: 'x' }), /only one capture target/);
    assert.deepEqual(parseScreenshot({ window: 'Notepad' }).title, 'Notepad');
    assert.equal(parseScreenshot({ handle: '0x1A2B' }).handle, 0x1a2b);
    assert.throws(() => parseScreenshot({ handle: 'abc' }), ArgError);
  });

  it('ocr', () => {
    assert.equal(parseOcr({ language: 'tr' }).language, 'tr');
    assert.throws(() => parseOcr({ language: 'en US; calc' }), ArgError);
    assert.equal(parseOcr({ find: 'Save' }).find, 'Save');
  });

  it('mouse', () => {
    assert.throws(() => parseMouse({}), /action/);
    assert.throws(() => parseMouse({ action: 'move' }), ArgError);
    assert.throws(() => parseMouse({ action: 'click', x: 5 }), /both/);
    assert.deepEqual(parseMouse({ action: 'click', x: 10.4, y: '20' }), { kind: 'click', x: 10, y: 20 });
    assert.deepEqual(parseMouse({ action: 'click' }), { kind: 'click' });
    assert.throws(() => parseMouse({ action: 'drag', x: 1, y: 1 }), /to_x/);
    assert.equal(parseMouse({ action: 'drag', to_x: 5, to_y: 6 }).toX, 5);
    assert.throws(() => parseMouse({ action: 'scroll', amount: 0 }), ArgError);
    assert.throws(() => parseMouse({ action: 'scroll', amount: 1000 }), ArgError);
    assert.equal(parseMouse({ action: 'scroll', amount: -3, horizontal: true }).horizontal, true);
    assert.deepEqual(parseMouse({ action: 'click', modifiers: ['ctrl'] }).mods, [0xa2]);
    assert.throws(() => parseMouse({ action: 'click', modifiers: ['enter'] }), ArgError);
    assert.throws(() => parseMouse({ action: 'fly' }), ArgError);
    assert.deepEqual(parseMouse({ action: 'position', x: 1, y: 2 }), { kind: 'position' });
  });

  it('keyboard', () => {
    assert.throws(() => parseKeyboard({ action: 'type' }), ArgError);
    assert.throws(() => parseKeyboard({ action: 'type', text: 'x'.repeat(10001) }), /too long/);
    const t = parseKeyboard({ action: 'type', text: 'Merhaba Dünya ğüşiöç\nSatır 2' });
    assert.equal(t.delay, 8);
    const h = parseKeyboard({ action: 'hotkey', keys: 'ctrl+c' });
    assert.equal(h.vks?.length, 4);
    assert.throws(() => parseKeyboard({ action: 'hotkey', keys: 'ctrl+nope' }), /Unknown key/);
    assert.throws(() => parseKeyboard({ action: 'hotkey' }), ArgError);
    const p = parseKeyboard({ action: 'press', key: 'down', repeat: 5 });
    assert.equal(p.vks?.length, 10);
    assert.throws(() => parseKeyboard({ action: 'press', key: 'down', repeat: 0 }), ArgError);
    assert.ok(keyboardTimeoutMs(t) >= 20000);
    assert.ok(keyboardTimeoutMs({ kind: 'type', text: 'x'.repeat(10000), delay: 200 }) <= 120000);
  });

  it('window', () => {
    assert.throws(() => parseWindow({ action: 'focus' }), /handle/);
    assert.throws(() => parseWindow({ action: 'move', title: 'a' }), ArgError);
    assert.throws(() => parseWindow({ action: 'resize', title: 'a', width: 5, height: 500 }), ArgError);
    assert.deepEqual(parseWindow({ action: 'move', title: 'a', x: 1, y: -2 }), { action: 'move', title: 'a', x: 1, y: -2 });
    assert.equal(parseWindow({ action: 'close', handle: 123 }).handle, 123);
  });

  it('clipboard / open / notify / wait', () => {
    assert.deepEqual(parseClipboardSet({ text: '' }), { text: '' });
    assert.throws(() => parseClipboardSet({}), ArgError);
    assert.throws(() => parseClipboardSet({ text: 'x'.repeat(25001) }), ArgError);
    assert.deepEqual(parseOpen({ target: 'notepad' }), { target: 'notepad' });
    assert.deepEqual(parseOpen({ target: 'chrome', args: '--new-window "https://a b"' }).args, ['--new-window', 'https://a b']);
    assert.throws(() => parseOpen({ target: '-evil' }), ArgError);
    assert.throws(() => parseOpen({}), ArgError);
    assert.throws(() => parseNotify({ title: 't'.repeat(64), message: 'm' }), ArgError);
    assert.throws(() => parseNotify({ title: 't' }), ArgError);
    assert.equal(parseWait({ ms: 1500 }).ms, 1500);
    assert.throws(() => parseWait({ ms: 30001 }), ArgError);
    assert.throws(() => parseWait({ ms: 0 }), ArgError);
    assert.throws(() => parseWait({ ms: 'abc' }), ArgError);
  });

  it('splitArgs', () => {
    assert.deepEqual(splitArgs('a  "b c" d'), ['a', 'b c', 'd']);
    assert.deepEqual(splitArgs(''), []);
  });
});

describe('OCR find', () => {
  const lines = normalizeOcrLines([
    {
      text: 'File Edit View',
      x: 10, y: 10, width: 100, height: 10,
      words: [
        { text: 'File', x: 10, y: 10, width: 20, height: 10 },
        { text: 'Edit', x: 40, y: 10, width: 20, height: 10 },
        { text: 'View', x: 70, y: 10, width: 40, height: 10 },
      ],
    },
    // single-element words (PowerShell may unroll to an object)
    { text: 'Save', x: 5, y: 50, width: 30, height: 12, words: { text: 'Save', x: 5, y: 50, width: 30, height: 12 } },
  ]);
  it('finds a word with its own box and center', () => {
    const m = findInOcr(lines, 'edit');
    assert.equal(m.length, 1);
    assert.equal(m[0]?.matchedText, 'Edit');
    assert.equal(m[0]?.centerX, 50);
    assert.equal(m[0]?.centerY, 15);
  });
  it('finds multi-word phrases and single-word lines', () => {
    const m = findInOcr(lines, 'file edit');
    assert.equal(m[0]?.x, 10);
    assert.equal(m[0]?.width, 50);
    assert.equal(findInOcr(lines, 'SAVE')[0]?.centerX, 20);
    assert.equal(findInOcr(lines, 'zzz').length, 0);
  });
});
