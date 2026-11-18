import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ocrLanguageCandidates,
  parseSipsDims,
  planCapture,
  pngDims,
  screencaptureArgs,
  sipsArgs,
  sipsDimsArgs,
} from './mac-capture.js';
import { buildScreens, buildWindows, parseGeometry, type Geometry } from './mac-geometry.js';
import { parseOcr, parseScreenshot } from './parse.js';
import { ArgError } from './validate.js';

function geo(): Geometry {
  const screens = buildScreens([
    { frame: { x: 0, y: 0, width: 1512, height: 982 }, visible: { x: 0, y: 0, width: 1512, height: 920 }, scale: 2, name: 'Built-in' },
    { frame: { x: -1920, y: -98, width: 1920, height: 1080 }, visible: { x: -1920, y: -98, width: 1920, height: 1080 }, scale: 1, name: 'LG' },
  ]);
  const windows = buildWindows(
    [
      { id: 42, pid: 7, owner: 'Safari', title: 'Apple', x: 100, y: 80, w: 900, h: 700, layer: 0, onscreen: true },
      { id: 43, pid: 8, owner: 'Notes', title: 'Mini', x: 0, y: 0, w: 300, h: 300, layer: 0, onscreen: false },
    ],
    screens,
    7,
  );
  return { ...parseGeometry({}), screens, virtual: { x: -1920, y: 0, width: 3432, height: 1080 }, windows };
}

describe('planCapture', () => {
  const g = geo();
  it('default = primary display frame in points', () => {
    const p = planCapture(parseScreenshot({}), g);
    assert.deepEqual(p.rect, { x: 0, y: 0, width: 1512, height: 982 });
    assert.equal(p.source, 'primary monitor');
    assert.equal(p.windowId, undefined);
  });
  it('monitor index selects that display (negative offsets kept) and range-checks', () => {
    const p = planCapture(parseScreenshot({ monitor: 1 }), g);
    assert.deepEqual(p.rect, { x: -1920, y: 0, width: 1920, height: 1080 });
    assert.throws(() => planCapture(parseScreenshot({ monitor: 5 }), g), ArgError);
  });
  it('region is clipped to the virtual screen', () => {
    const p = planCapture(parseScreenshot({ region: { x: -2000, y: 10, width: 200, height: 50 } }), g);
    assert.deepEqual(p.rect, { x: -1920, y: 10, width: 120, height: 50 });
    assert.throws(() => planCapture(parseScreenshot({ region: { x: 9999, y: 0, width: 5, height: 5 } }), g), ArgError);
  });
  it('window by title or handle uses its id and bounds; minimized is refused', () => {
    const p = planCapture(parseScreenshot({ window: 'apple' }), g);
    assert.equal(p.windowId, 42);
    assert.deepEqual(p.rect, { x: 100, y: 80, width: 900, height: 700 });
    assert.equal(planCapture(parseOcr({ handle: 42 }), g).windowId, 42);
    assert.throws(() => planCapture(parseScreenshot({ handle: 43 }), g), /minimized/);
    assert.throws(() => planCapture(parseScreenshot({ window: 'nope' }), g), ArgError);
  });
});

describe('screencapture / sips arguments', () => {
  it('rectangle capture uses -R x,y,w,h in points, silent, png', () => {
    assert.deepEqual(screencaptureArgs({ rect: { x: -1920, y: 0, width: 1920, height: 1080 }, source: 'm' }, '/t/c.png'), [
      '-x', '-t', 'png', '-R', '-1920,0,1920,1080', '/t/c.png',
    ]);
  });
  it('window capture uses -l <id> without shadow (-o)', () => {
    assert.deepEqual(screencaptureArgs({ rect: { x: 1, y: 2, width: 3, height: 4 }, source: 'w', windowId: 42 }, '/t/c.png'), [
      '-x', '-t', 'png', '-o', '-l', '42', '/t/c.png',
    ]);
  });
  it('sips: png without downscale needs no processing', () => {
    const p = sipsArgs({ format: 'png', quality: 80, maxWidth: 1600, srcPixelWidth: 1200 }, 'a.png', 'b.png');
    assert.equal(p.needed, false);
  });
  it('sips: png downscale', () => {
    const p = sipsArgs({ format: 'png', quality: 80, maxWidth: 800, srcPixelWidth: 3024 }, 'a.png', 'b.png');
    assert.equal(p.needed, true);
    assert.deepEqual(p.args, ['--resampleWidth', '800', 'a.png', '--out', 'b.png']);
  });
  it('sips: jpeg with quality, with and without downscale (never upscales)', () => {
    const a = sipsArgs({ format: 'jpeg', quality: 65, maxWidth: 1600, srcPixelWidth: 3024 }, 'a.png', 'b.jpg');
    assert.deepEqual(a.args, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '65', '--resampleWidth', '1600', 'a.png', '--out', 'b.jpg']);
    const b = sipsArgs({ format: 'jpeg', quality: 80, maxWidth: 1600, srcPixelWidth: 1000 }, 'a.png', 'b.jpg');
    assert.equal(b.needed, true);
    assert.ok(!b.args.includes('--resampleWidth'));
  });
  it('parses sips -g output and PNG headers', () => {
    assert.deepEqual(sipsDimsArgs('x.png'), ['-g', 'pixelWidth', '-g', 'pixelHeight', 'x.png']);
    assert.deepEqual(parseSipsDims('/t/x.png\n  pixelWidth: 1600\n  pixelHeight: 1039\n'), { width: 1600, height: 1039 });
    assert.equal(parseSipsDims('garbage'), undefined);
    const png = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(3024, 16);
    png.writeUInt32BE(1964, 20);
    assert.deepEqual(pngDims(png), { width: 3024, height: 1964 });
    assert.equal(pngDims(Buffer.alloc(10)), undefined);
  });
});

describe('OCR language candidates', () => {
  it('explicit wins; otherwise locale then en-US', () => {
    assert.deepEqual(ocrLanguageCandidates('tr', { LANG: 'en_US.UTF-8' }), ['tr']);
    assert.deepEqual(ocrLanguageCandidates(undefined, { LANG: 'tr_TR.UTF-8' }), ['tr-TR', 'en-US']);
    assert.deepEqual(ocrLanguageCandidates(undefined, { LANG: 'en_US.UTF-8' }), ['en-US']);
    assert.deepEqual(ocrLanguageCandidates(undefined, { LANG: 'C' }), ['en-US']);
    assert.deepEqual(ocrLanguageCandidates(undefined, {}), ['en-US']);
  });
});
