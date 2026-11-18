import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildScreens,
  buildWindows,
  captureScale,
  cgRectToNs,
  clipRect,
  filterWindows,
  isMaximized,
  maximizeTarget,
  nsRectToCg,
  parseGeometry,
  resolveMacWindow,
  screenForRect,
  virtualScreen,
  visionToScreen,
  type RawScreen,
  type RawWindow,
} from './mac-geometry.js';

// Primary 1512x982 (points, MacBook Pro 14"), a 1920x1080 display to its left (tops aligned) and one above it.
const RAW: RawScreen[] = [
  { frame: { x: 0, y: 0, width: 1512, height: 982 }, visible: { x: 0, y: 0, width: 1512, height: 920 }, scale: 2, name: 'Built-in' },
  { frame: { x: -1920, y: -98, width: 1920, height: 1080 }, visible: { x: -1920, y: -98, width: 1920, height: 1080 }, scale: 1, name: 'LG' },
  { frame: { x: 0, y: 982, width: 1512, height: 982 }, visible: { x: 0, y: 982, width: 1512, height: 982 }, scale: 2 },
];

describe('coordinate conversions', () => {
  it('NSScreen (bottom-left) <-> CG (top-left)', () => {
    assert.deepEqual(nsRectToCg({ x: 0, y: 0, width: 1512, height: 982 }, 982), { x: 0, y: 0, width: 1512, height: 982 });
    // visible frame: menu bar (38) on top, so NS y=0 height 920?? -> CG top offset = 982-(0+920) = 62
    assert.deepEqual(nsRectToCg({ x: 0, y: 0, width: 1512, height: 920 }, 982), { x: 0, y: 62, width: 1512, height: 920 });
    // display above the primary has NEGATIVE CG y
    assert.deepEqual(nsRectToCg({ x: 0, y: 982, width: 1512, height: 982 }, 982), { x: 0, y: -982, width: 1512, height: 982 });
    // round trip
    const r = { x: -1920, y: -98, width: 1920, height: 1080 };
    assert.deepEqual(cgRectToNs(nsRectToCg(r, 982), 982), r);
  });
  it('builds screens: primary is index 0, left display top-aligned has CG y 0', () => {
    const s = buildScreens(RAW);
    assert.equal(s.length, 3);
    assert.equal(s[0]!.primary, true);
    assert.deepEqual(s[1]!.frame, { x: -1920, y: 0, width: 1920, height: 1080 });
    assert.deepEqual(s[2]!.frame, { x: 0, y: -982, width: 1512, height: 982 });
    assert.equal(s[2]!.name, 'Display 3');
    assert.deepEqual(virtualScreen(s), { x: -1920, y: -982, width: 3432, height: 2062 });
  });
  it('picks the screen with the largest overlap and clips regions', () => {
    const s = buildScreens(RAW);
    assert.equal(screenForRect({ x: -1500, y: 100, width: 400, height: 300 }, s)?.index, 1);
    assert.equal(screenForRect({ x: 100, y: 100, width: 400, height: 300 }, s)?.index, 0);
    assert.equal(screenForRect({ x: 5000, y: 100, width: 10, height: 10 }, s)?.index, 0);
    const v = virtualScreen(s);
    assert.deepEqual(clipRect({ x: -3000, y: 0, width: 1500, height: 100 }, v), { x: -1920, y: 0, width: 420, height: 100 });
    assert.equal(clipRect({ x: 9000, y: 0, width: 10, height: 10 }, v), undefined);
  });
  it('Vision normalized (bottom-left origin) -> screen points', () => {
    const region = { x: 0, y: 0, width: 1512, height: 982 };
    assert.deepEqual(visionToScreen({ nx: 0.1, ny: 0.8, nw: 0.2, nh: 0.05 }, region), { x: 151, y: 147, width: 302, height: 49 });
    // bottom-left corner box (0,0)-(0.1,0.1) is at the BOTTOM of the screen in CG coords
    assert.deepEqual(visionToScreen({ nx: 0, ny: 0, nw: 0.1, nh: 0.1 }, region), { x: 0, y: 884, width: 151, height: 98 });
    // region with an offset (second display / window)
    assert.deepEqual(visionToScreen({ nx: 0.5, ny: 0.5, nw: 0.5, nh: 0.5 }, { x: -1920, y: 100, width: 1920, height: 1000 }), { x: -960, y: 100, width: 960, height: 500 });
    // degenerate boxes stay at least 1pt
    assert.equal(visionToScreen({ nx: 0, ny: 0, nw: 0, nh: 0 }, region).width, 1);
  });
  it('Retina scale: image px per screen point', () => {
    // 1512pt capture (3024 native px) downscaled to 1600px image
    assert.equal(captureScale(1600, 1512).toFixed(4), '1.0582');
    // a 100pt-wide region captured natively at 2x -> 200px image => scale 2 (still mapping image px back to POINTS)
    assert.equal(captureScale(200, 100), 2);
    assert.equal(captureScale(10, 0), 1);
    // image point -> screen point: 800px in a 1600px image of a 1512pt wide screen at offset 0
    const scale = captureScale(1600, 1512);
    assert.equal(Math.round(0 + 800 / scale), 756);
  });
});

function win(o: Partial<RawWindow> & { id: number }): RawWindow {
  return { pid: 100, owner: 'App', title: 't', x: 0, y: 0, w: 800, h: 600, layer: 0, onscreen: true, alpha: 1, ...o };
}

describe('window model', () => {
  const screens = buildScreens(RAW);
  it('keeps layer-0 windows only, orders on-screen first, flags minimized and focus', () => {
    const raw: RawWindow[] = [
      win({ id: 1, layer: 25, title: 'Menubar', w: 1512, h: 24 }),
      win({ id: 2, pid: 7, owner: 'Safari', title: 'Apple' }),
      win({ id: 3, pid: 8, owner: 'Notes', title: 'Note', onscreen: false }),
      win({ id: 4, pid: 8, owner: 'Notes', title: '', onscreen: false }),
      win({ id: 5, pid: 7, owner: 'Safari', title: 'Second' }),
      win({ id: 6, pid: 9, owner: 'Tiny', title: 'x', w: 1, h: 1 }),
      win({ id: 7, pid: 9, owner: 'Ghost', title: 'g', alpha: 0 }),
    ];
    const w = buildWindows(raw, screens, 7);
    assert.deepEqual(w.map((x) => x.handle), [2, 5, 3]);
    assert.equal(w[0]!.focused, true);
    assert.equal(w[1]!.focused, false);
    assert.equal(w[2]!.minimized, true);
    assert.equal(w[0]!.process, 'Safari');
  });
  it('detects maximized against the work area and the full frame', () => {
    assert.equal(isMaximized({ x: 0, y: 62, width: 1512, height: 920 }, screens), true);
    assert.equal(isMaximized({ x: 0, y: 0, width: 1512, height: 982 }, screens), true);
    assert.equal(isMaximized({ x: 10, y: 80, width: 800, height: 600 }, screens), false);
    assert.deepEqual(maximizeTarget({ x: 10, y: 80, width: 800, height: 600 }, screens), { x: 0, y: 62, width: 1512, height: 920 });
  });
  it('resolves by handle, title or app name; focused non-minimized match wins', () => {
    const w = buildWindows(
      [
        win({ id: 1, pid: 1, owner: 'Safari', title: 'Docs' }),
        win({ id: 2, pid: 2, owner: 'Code', title: 'docs.md' }),
        win({ id: 3, pid: 3, owner: 'Notes', title: 'Docs old', onscreen: false }),
        win({ id: 4, pid: 4, owner: 'Mail', title: '' }),
      ],
      screens,
      2,
    );
    assert.equal(resolveMacWindow(w, { handle: 3 })?.handle, 3);
    assert.equal(resolveMacWindow(w, { title: 'DOCS' })?.handle, 2);
    assert.equal(resolveMacWindow(w, { title: 'old' })?.handle, 3);
    assert.equal(resolveMacWindow(w, { title: 'mail' })?.handle, 4); // app name (titles empty without Screen Recording)
    assert.equal(resolveMacWindow(w, { title: 'zzz' }), undefined);
    assert.equal(resolveMacWindow(w, {}), undefined);
    assert.deepEqual(filterWindows(w, 'safari').map((x) => x.handle), [1]);
  });
  it('parseGeometry builds the model from the JXA blob', () => {
    const g = parseGeometry({
      screens: [{ frame: { x: 0, y: 0, width: 1512, height: 982 }, visible: { x: 0, y: 0, width: 1512, height: 920 }, scale: 2, name: 'Built-in' }],
      cursor: { x: 10.4, y: 20.6 },
      ax: true,
      screen: false,
      frontPid: 7,
      windows: [{ id: 2, pid: 7, owner: 'Safari', title: '', x: 0, y: 62, w: 1512, h: 920, layer: 0, onscreen: true, alpha: 1 }],
    });
    assert.equal(g.screens[0]!.visible.y, 62);
    assert.deepEqual(g.cursor, { x: 10, y: 21 });
    assert.equal(g.accessibility, true);
    assert.equal(g.screenRecording, false);
    assert.equal(g.windows[0]!.maximized, true);
    assert.equal(g.windows[0]!.focused, true);
    assert.equal(parseGeometry({}).accessibility, null);
  });
});
