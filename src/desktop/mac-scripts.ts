/**
 * JXA (JavaScript for Automation) scripts for macOS, run with `osascript -l JavaScript <file>`.
 *
 * Rules (enforced by tests):
 *  - Every script is a CONSTANT string; user input arrives only as JSON in the NEO_ARGS environment variable.
 *  - Scripts return exactly one JSON object (JSON.stringify) from run(); failures return {neoError, neoCode}.
 *  - Plain ES5 (var / function) so any JavaScriptCore version accepts them.
 *  - Coordinates are CG global points (origin top-left of the primary display).
 */

const PRELUDE = String.raw`ObjC.import('Cocoa');
ObjC.import('CoreGraphics');
ObjC.import('ApplicationServices');
var A = {};
try {
  var rawArgs = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('NEO_ARGS'));
  if (rawArgs) { A = JSON.parse(rawArgs); }
} catch (eArgs) { A = {}; }
function NeoErr(code, msg) { this.neoCode = code; this.message = msg || code; }
function sleepMs(ms) { $.NSThread.sleepForTimeInterval(ms / 1000); }
function callBool(name) {
  try { return !!$[name](); } catch (e1) {
    try { ObjC.bindFunction(name, ['bool', []]); return !!$[name](); } catch (e2) { return null; }
  }
}
function axTrusted() { return callBool('AXIsProcessTrusted'); }
function screenAllowed() { return callBool('CGPreflightScreenCaptureAccess'); }
function requireAx() { if (axTrusted() === false) { throw new NeoErr('PERM_AX'); } }
function cfToJs(ref) {
  try { return ObjC.deepUnwrap(ObjC.castRefToObject(ref)); }
  catch (e) { return ObjC.deepUnwrap($.CFBridgingRelease(ref)); }
}
function cursorPos() {
  var p = $.CGEventGetLocation($.CGEventCreate(null));
  return { x: p.x, y: p.y };
}
function run() {
  try {
    return JSON.stringify(main());
  } catch (e) {
    var msg = (e && e.message) ? String(e.message) : String(e);
    var code = (e && e.neoCode) ? String(e.neoCode) : '';
    return JSON.stringify({ neoError: msg, neoCode: code });
  }
}
`;

function build(body: string): string {
  return PRELUDE + body;
}

/** Displays (NSScreen), cursor, windows (CGWindowList), frontmost pid, permission state. */
export const SCRIPT_GEOMETRY = build(String.raw`function main() {
  var screens = [];
  var arr = $.NSScreen.screens;
  var n = arr.count;
  for (var i = 0; i < n; i++) {
    var s = arr.objectAtIndex(i);
    var f = s.frame;
    var v = s.visibleFrame;
    var name = '';
    try { name = ObjC.unwrap(s.localizedName) || ''; } catch (eName) { name = ''; }
    screens.push({
      frame: { x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height },
      visible: { x: v.origin.x, y: v.origin.y, width: v.size.width, height: v.size.height },
      scale: s.backingScaleFactor,
      name: name
    });
  }
  var out = { screens: screens, cursor: cursorPos(), ax: axTrusted(), screen: screenAllowed(), windows: [], frontPid: 0 };
  if (A.windows !== false) {
    // 16 = kCGWindowListExcludeDesktopElements; adding 1 (OnScreenOnly) hides minimized/hidden windows.
    var opt = A.includeOffscreen === false ? 17 : 16;
    var ref = $.CGWindowListCopyWindowInfo(opt, 0);
    var list = cfToJs(ref) || [];
    for (var k = 0; k < list.length; k++) {
      var d = list[k];
      var b = d.kCGWindowBounds || {};
      out.windows.push({
        id: d.kCGWindowNumber,
        pid: d.kCGWindowOwnerPID,
        owner: d.kCGWindowOwnerName || '',
        title: d.kCGWindowName || '',
        x: b.X, y: b.Y, w: b.Width, h: b.Height,
        layer: d.kCGWindowLayer,
        onscreen: d.kCGWindowIsOnscreen === true || d.kCGWindowIsOnscreen === 1,
        alpha: d.kCGWindowAlpha
      });
    }
    try { out.frontPid = $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier; } catch (eFront) { out.frontPid = 0; }
  }
  return out;
}
`);

/** Mouse: move / click / double / right / middle / drag / scroll / position, via CGEventPost. */
export const SCRIPT_MOUSE = build(String.raw`var EV = { move: 5, ldown: 1, lup: 2, rdown: 3, rup: 4, odown: 25, oup: 26, ldrag: 6, rdrag: 7, odrag: 27 };
function post(ev, flags) {
  if (flags) { $.CGEventSetFlags(ev, flags); }
  $.CGEventPost(0, ev);
}
function mouseEv(type, x, y, button, flags, clickState) {
  var ev = $.CGEventCreateMouseEvent(null, type, { x: x, y: y }, button);
  if (clickState) { $.CGEventSetIntegerValueField(ev, 1, clickState); }
  post(ev, flags);
}
function moveTo(x, y, flags) { mouseEv(EV.move, x, y, 0, flags, 0); }
function scrollEv(dy, dx, flags) {
  var ev;
  try {
    ev = $.CGEventCreateScrollWheelEvent2(null, 1, 2, dy, dx, 0);
  } catch (e1) {
    ObjC.bindFunction('CGEventCreateScrollWheelEvent2', ['void *', ['void *', 'unsigned int', 'unsigned int', 'int', 'int', 'int']]);
    ev = $.CGEventCreateScrollWheelEvent2(null, 1, 2, dy, dx, 0);
  }
  post(ev, flags);
}
function main() {
  var kind = String(A.kind);
  var flags = A.flags ? Number(A.flags) : 0;
  if (kind !== 'position') { requireAx(); }
  var hasXY = (A.x !== undefined && A.x !== null && A.y !== undefined && A.y !== null);
  if (hasXY && kind !== 'position') {
    moveTo(Number(A.x), Number(A.y), flags);
    sleepMs(30);
  }
  var cp = (hasXY && kind !== 'position') ? { x: Number(A.x), y: Number(A.y) } : cursorPos();
  if (kind === 'move' || kind === 'position') {
  } else if (kind === 'click' || kind === 'double_click' || kind === 'right_click' || kind === 'middle_click') {
    var down = EV.ldown; var up = EV.lup; var btn = 0;
    if (kind === 'right_click') { down = EV.rdown; up = EV.rup; btn = 1; }
    if (kind === 'middle_click') { down = EV.odown; up = EV.oup; btn = 2; }
    var times = (kind === 'double_click') ? 2 : 1;
    for (var i = 1; i <= times; i++) {
      mouseEv(down, cp.x, cp.y, btn, flags, i);
      sleepMs(25);
      mouseEv(up, cp.x, cp.y, btn, flags, i);
      if (i < times) { sleepMs(60); }
    }
  } else if (kind === 'drag') {
    var sx = cp.x; var sy = cp.y;
    var tx = Number(A.toX); var ty = Number(A.toY);
    mouseEv(EV.ldown, sx, sy, 0, flags, 1);
    sleepMs(80);
    var steps = 12;
    for (var j = 1; j <= steps; j++) {
      mouseEv(EV.ldrag, Math.round(sx + (tx - sx) * j / steps), Math.round(sy + (ty - sy) * j / steps), 0, flags, 1);
      sleepMs(15);
    }
    sleepMs(60);
    mouseEv(EV.lup, tx, ty, 0, flags, 1);
  } else if (kind === 'scroll') {
    var notches = Number(A.amount);
    var dir = notches < 0 ? -1 : 1;
    var count = Math.abs(notches);
    // 3 lines per notch. Vertical: + = up. Horizontal: the API says + = right; CG wheel2 uses + = left, so negate.
    for (var k = 0; k < count; k++) {
      if (A.horizontal === true) { scrollEv(0, -3 * dir, flags); } else { scrollEv(3 * dir, 0, flags); }
      sleepMs(15);
    }
  } else {
    throw new NeoErr('BAD_ACTION', 'Unknown mouse action: ' + kind);
  }
  sleepMs(30);
  var p = cursorPos();
  return { action: kind, x: Math.round(p.x), y: Math.round(p.y) };
}
`);

/** Keyboard: Unicode typing (CGEventKeyboardSetUnicodeString) and key-code events (hotkey/press). */
export const SCRIPT_KEYBOARD = build(String.raw`function setUnicode(ev, str) {
  var data = $(str).dataUsingEncoding(0x94000100); // NSUTF16LittleEndianStringEncoding
  try {
    $.CGEventKeyboardSetUnicodeString(ev, str.length, data.bytes);
  } catch (e1) {
    try {
      ObjC.bindFunction('CGEventKeyboardSetUnicodeString', ['void', ['void *', 'unsigned long', 'void *']]);
      $.CGEventKeyboardSetUnicodeString(ev, str.length, data.bytes);
    } catch (e2) {
      throw new NeoErr('UNICODE_BRIDGE', 'CGEventKeyboardSetUnicodeString is not callable from JXA: ' + e2);
    }
  }
}
function keyEv(code, down, flags, str) {
  var ev = $.CGEventCreateKeyboardEvent(null, code, down);
  if (str !== undefined) { setUnicode(ev, str); }
  if (flags) { $.CGEventSetFlags(ev, flags); }
  $.CGEventPost(0, ev);
}
function auxEv(key, down) {
  // NSSystemDefined (14) subtype 8: media / volume keys. data1 = (NX_KEYTYPE << 16) | (0xA00 down | 0xB00 up)
  var data1 = (key << 16) | ((down ? 0xa : 0xb) << 8);
  var e = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(14, { x: 0, y: 0 }, down ? 0xa00 : 0xb00, 0, 0, null, 8, data1, -1);
  $.CGEventPost(0, e.CGEvent);
}
function main() {
  requireAx();
  var delay = Number(A.delay) || 0;
  var kind = String(A.kind);
  if (kind === 'type') {
    var chars = Array.from(String(A.text));
    var prev = '';
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (ch === '\r') { keyEv(36, true, 0); keyEv(36, false, 0); }
      else if (ch === '\n') { if (prev !== '\r') { keyEv(36, true, 0); keyEv(36, false, 0); } }
      else if (ch === '\t') { keyEv(48, true, 0); keyEv(48, false, 0); }
      else { keyEv(0, true, 0, ch); keyEv(0, false, 0, ch); }
      prev = ch;
      if (delay > 0) { sleepMs(delay); }
    }
    return { action: 'type', chars: String(A.text).length };
  }
  var events = A.events || [];
  for (var j = 0; j < events.length; j++) {
    var e = events[j];
    if (e.t === 'aux') { auxEv(e.aux, e.down); } else { keyEv(e.code, e.down, e.flags); }
    if (delay > 0) { sleepMs(delay); }
  }
  return { action: kind, events: events.length };
}
`);

/**
 * Window actions through System Events (Accessibility API). The window is identified by pid + the CGWindowList
 * bounds/title the caller already resolved; the AX window with the closest frame wins.
 */
export const SCRIPT_WINDOW = build(String.raw`function findProc(se, pid) {
  try {
    var hit = se.processes.whose({ unixId: pid })();
    if (hit.length > 0) { return hit[0]; }
  } catch (e1) {}
  var all = se.processes();
  for (var i = 0; i < all.length; i++) {
    try { if (all[i].unixId() === pid) { return all[i]; } } catch (e2) {}
  }
  return null;
}
function findWin(proc, want) {
  var wins = proc.windows();
  var best = null; var bestScore = 1e9;
  for (var i = 0; i < wins.length; i++) {
    var w = wins[i];
    var pos; var size; var name = '';
    try { pos = w.position(); size = w.size(); } catch (e1) { continue; }
    try { name = w.name() || ''; } catch (e2) { name = ''; }
    var score = Math.abs(pos[0] - want.x) + Math.abs(pos[1] - want.y) + Math.abs(size[0] - want.w) + Math.abs(size[1] - want.h);
    if (want.title && name === want.title) { score -= 20; }
    if (score < bestScore) { bestScore = score; best = w; }
  }
  if (best === null || bestScore > 60) {
    if (want.title) {
      for (var j = 0; j < wins.length; j++) {
        try { if (wins[j].name() === want.title) { return wins[j]; } } catch (e3) {}
      }
    }
    if (wins.length === 1) { return wins[0]; }
    throw new NeoErr('NO_WINDOW');
  }
  return best;
}
function setProp(spec, prop, val) {
  try { spec[prop] = val; } catch (e1) { spec[prop].set(val); }
}
function setAttr(win, attr, val) {
  var a = win.attributes.byName(attr);
  try { a.value = val; } catch (e1) { a.value.set(val); }
}
function getAttr(win, attr) {
  try { return win.attributes.byName(attr).value(); } catch (e) { return null; }
}
function frontKeystroke(se, key) { se.keystroke(key, { using: 'command down' }); }
function main() {
  requireAx();
  var se = Application('System Events');
  var proc = findProc(se, Number(A.pid));
  if (proc === null) { throw new NeoErr('NO_WINDOW'); }
  var win = findWin(proc, { x: Number(A.bx), y: Number(A.by), w: Number(A.bw), h: Number(A.bh), title: A.title || '' });
  var act = String(A.action);
  var ok = true;
  if (act === 'focus') {
    try { $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(A.pid)).activateWithOptions(2); } catch (e1) {}
    try { setProp(proc, 'frontmost', true); } catch (e2) {}
    if (getAttr(win, 'AXMinimized') === true) { try { setAttr(win, 'AXMinimized', false); } catch (e3) {} }
    try { win.actions.byName('AXRaise').perform(); } catch (e4) {}
  } else if (act === 'minimize') {
    try { setAttr(win, 'AXMinimized', true); } catch (e5) {
      try { setProp(proc, 'frontmost', true); win.actions.byName('AXRaise').perform(); frontKeystroke(se, 'm'); } catch (e6) { ok = false; }
    }
  } else if (act === 'unminimize') {
    try { setAttr(win, 'AXMinimized', false); } catch (e7) { ok = false; }
    try { setProp(proc, 'frontmost', true); win.actions.byName('AXRaise').perform(); } catch (e8) {}
  } else if (act === 'exitfullscreen') {
    try { setAttr(win, 'AXFullScreen', false); } catch (e9) {}
  } else if (act === 'close') {
    var closed = false;
    try {
      var btn = getAttr(win, 'AXCloseButton');
      if (btn) { btn.actions.byName('AXPress').perform(); closed = true; }
    } catch (e10) {}
    if (!closed) {
      try { win.buttons.whose({ subrole: 'AXCloseButton' })[0].click(); closed = true; } catch (e11) {}
    }
    if (!closed) {
      try { setProp(proc, 'frontmost', true); win.actions.byName('AXRaise').perform(); frontKeystroke(se, 'w'); closed = true; } catch (e12) { ok = false; }
    }
  } else if (act === 'frame') {
    if (A.x !== undefined && A.x !== null) { setProp(win, 'position', [Number(A.x), Number(A.y)]); }
    if (A.width !== undefined && A.width !== null) { setProp(win, 'size', [Number(A.width), Number(A.height)]); }
    // Some apps clamp the first size change after a move: apply the position again.
    if (A.x !== undefined && A.x !== null && A.width !== undefined && A.width !== null) { setProp(win, 'position', [Number(A.x), Number(A.y)]); }
  } else {
    throw new NeoErr('BAD_ACTION', 'Unknown window action: ' + act);
  }
  return { ok: ok };
}
`);

/** OCR with Vision (VNRecognizeTextRequest, accurate). Returns NORMALIZED boxes (origin bottom-left). */
export const SCRIPT_OCR = build(String.raw`ObjC.import('Vision');
function boxOf(r) {
  var b = r.boundingBox;
  return { nx: b.origin.x, ny: b.origin.y, nw: b.size.width, nh: b.size.height };
}
function pickLanguages(req, wanted) {
  var supported = [];
  try { supported = ObjC.deepUnwrap(req.supportedRecognitionLanguagesAndReturnError(Ref())) || []; } catch (e) { supported = []; }
  var used = [];
  for (var i = 0; i < wanted.length; i++) {
    var w = String(wanted[i]).toLowerCase();
    var hit = null;
    for (var j = 0; j < supported.length; j++) {
      var s = String(supported[j]);
      if (s.toLowerCase() === w) { hit = s; break; }
    }
    if (hit === null) {
      var pre = w.split('-')[0];
      for (var k = 0; k < supported.length; k++) {
        var s2 = String(supported[k]);
        if (s2.toLowerCase().split('-')[0] === pre) { hit = s2; break; }
      }
    }
    if (hit !== null && used.indexOf(hit) < 0) { used.push(hit); }
  }
  if (used.length === 0) { used = ['en-US']; }
  return used;
}
function main() {
  var url = $.NSURL.fileURLWithPath(String(A.imagePath));
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
  var req = $.VNRecognizeTextRequest.alloc.init;
  req.recognitionLevel = 0; // VNRequestTextRecognitionLevelAccurate
  req.usesLanguageCorrection = true;
  var langs = pickLanguages(req, A.languages || ['en-US']);
  req.recognitionLanguages = $(langs);
  if (A.autoDetect === true) { try { req.automaticallyDetectsLanguage = true; } catch (eAuto) {} }
  var err = Ref();
  var ok = handler.performRequestsError($([req]), err);
  if (!ok) { throw new NeoErr('OCR_FAILED', 'Vision text recognition failed.'); }
  var results = req.results;
  var lines = [];
  var n = results ? results.count : 0;
  for (var i = 0; i < n; i++) {
    var obs = results.objectAtIndex(i);
    var cands = obs.topCandidates(1);
    if (cands.count === 0) { continue; }
    var cand = cands.objectAtIndex(0);
    var text = ObjC.unwrap(cand.string);
    var lb = boxOf(obs);
    var words = [];
    var re = /\S+/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var wb = null;
      try {
        var rr = cand.boundingBoxForRangeError({ location: m.index, length: m[0].length }, Ref());
        if (rr) { wb = boxOf(rr); }
      } catch (eRange) { wb = null; }
      if (wb === null) {
        // Fallback: spread the word box proportionally along the line box.
        var t = Math.max(1, text.length);
        wb = { nx: lb.nx + lb.nw * m.index / t, ny: lb.ny, nw: lb.nw * m[0].length / t, nh: lb.nh };
      }
      wb.text = m[0];
      words.push(wb);
    }
    lb.text = text;
    lb.words = words;
    lines.push(lb);
  }
  return { language: langs.join(','), lines: lines };
}
`);

/** Pasteboard inspection: which kinds of data are on the clipboard (text itself is read with pbpaste). */
export const SCRIPT_CLIPBOARD_INFO = build(String.raw`function main() {
  var pb = $.NSPasteboard.generalPasteboard;
  var types = [];
  try { types = ObjC.deepUnwrap(pb.types) || []; } catch (e0) { types = []; }
  function has(list) { for (var i = 0; i < list.length; i++) { if (types.indexOf(list[i]) >= 0) { return true; } } return false; }
  var hasText = has(['public.utf8-plain-text', 'NSStringPboardType', 'public.utf16-external-plain-text', 'public.plain-text']);
  var hasImage = has(['public.png', 'public.tiff', 'public.jpeg', 'com.compuserve.gif', 'public.heic']);
  var hasFiles = has(['public.file-url', 'NSFilenamesPboardType']);
  var imgW = 0; var imgH = 0;
  if (hasImage) {
    try {
      var img = $.NSImage.alloc.initWithPasteboard(pb);
      var reps = img.representations;
      if (reps.count > 0) {
        var rep = reps.objectAtIndex(0);
        imgW = rep.pixelsWide; imgH = rep.pixelsHigh;
      }
      if (!(imgW > 0)) { imgW = Math.round(img.size.width); imgH = Math.round(img.size.height); }
    } catch (e1) {}
  }
  var files = [];
  if (hasFiles) {
    try {
      var urls = pb.readObjectsForClassesOptions($.NSArray.arrayWithObject($.NSURL), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
      for (var j = 0; j < urls.count; j++) { files.push(ObjC.unwrap(urls.objectAtIndex(j).path)); }
    } catch (e2) {
      try { files = ObjC.deepUnwrap(pb.propertyListForType('NSFilenamesPboardType')) || []; } catch (e3) { files = []; }
    }
  }
  return { hasText: hasText, hasImage: hasImage, imageWidth: imgW, imageHeight: imgH, hasFiles: files.length > 0 || hasFiles, files: files };
}
`);

/** Notification through StandardAdditions (display notification). Title/message come from NEO_ARGS only. */
export const SCRIPT_NOTIFY = build(String.raw`function main() {
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.displayNotification(String(A.message), { withTitle: String(A.title) });
  sleepMs(300);
  return { ok: true };
}
`);

export const ALL_MAC_SCRIPTS: Record<string, string> = {
  geometry: SCRIPT_GEOMETRY,
  mouse: SCRIPT_MOUSE,
  keyboard: SCRIPT_KEYBOARD,
  window: SCRIPT_WINDOW,
  ocr: SCRIPT_OCR,
  clipboardInfo: SCRIPT_CLIPBOARD_INFO,
  notify: SCRIPT_NOTIFY,
};
