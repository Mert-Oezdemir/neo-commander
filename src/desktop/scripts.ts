/**
 * PowerShell 5.1 script templates. Rules:
 *  - ASCII only (stdin is decoded with the OEM code page). Non-ASCII output is \uXXXX-escaped by Out-Neo.
 *  - No user input is ever interpolated; scripts read $env:NEO_ARGS (JSON) into $A.
 *  - Every script prints exactly one JSON object line; failures print {"neoError": "..."}.
 *  - C# is C# 5 only (Add-Type on PS 5.1): no $"", =>, out var, ?. , nameof.
 */

/** Native helpers: window enumeration/focus, SendInput mouse + keyboard, DPI awareness. */
export const NATIVE_CS = String.raw`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class NeoWin {
  public long Handle;
  public string Title;
  public uint Pid;
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
  public bool Minimized;
  public bool Maximized;
}

public static class NeoNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }

  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT value, int size);

  public static void DpiAware() {
    try {
      if (SetProcessDpiAwareness(2) != 0) { SetProcessDPIAware(); }
    } catch (Exception) {
      try { SetProcessDPIAware(); } catch (Exception) { }
    }
  }

  // ---- mouse ----
  static int Norm(int v, int size) {
    if (size <= 0) { return 0; }
    double n = Math.Ceiling(v * 65536.0 / size);
    if (n < 0) { n = 0; }
    if (n > 65535) { n = 65535; }
    return (int)n;
  }

  static void SendMouse(int dx, int dy, uint data, uint flags) {
    INPUT[] a = new INPUT[1];
    a[0].type = 0;
    a[0].u.mi.dx = dx;
    a[0].u.mi.dy = dy;
    a[0].u.mi.mouseData = data;
    a[0].u.mi.dwFlags = flags;
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void MoveTo(int x, int y) {
    int vx = GetSystemMetrics(76);
    int vy = GetSystemMetrics(77);
    int vw = GetSystemMetrics(78);
    int vh = GetSystemMetrics(79);
    // MOVE | ABSOLUTE | VIRTUALDESK
    SendMouse(Norm(x - vx, vw), Norm(y - vy, vh), 0, 0x0001 | 0x8000 | 0x4000);
  }

  // button: 0 left, 1 right, 2 middle
  public static void Button(int button, bool down) {
    uint f;
    if (button == 1) { f = down ? 0x0008u : 0x0010u; }
    else if (button == 2) { f = down ? 0x0020u : 0x0040u; }
    else { f = down ? 0x0002u : 0x0004u; }
    SendMouse(0, 0, 0, f);
  }

  public static void Wheel(int delta, bool horizontal) {
    SendMouse(0, 0, unchecked((uint)delta), horizontal ? 0x1000u : 0x0800u);
  }

  public static int[] CursorPos() {
    POINT p;
    GetCursorPos(out p);
    return new int[] { p.X, p.Y };
  }

  // ---- keyboard ----
  // flags: 1 = extended key, 2 = key up
  public static void Key(int vk, int flags) {
    INPUT[] a = new INPUT[1];
    a[0].type = 1;
    a[0].u.ki.wVk = (ushort)vk;
    a[0].u.ki.wScan = (ushort)MapVirtualKey((uint)vk, 0);
    a[0].u.ki.dwFlags = (uint)flags;
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Keys(int[] vks, int[] flags, int delayMs) {
    for (int i = 0; i < vks.Length; i++) {
      Key(vks[i], flags[i]);
      if (delayMs > 0) { Thread.Sleep(delayMs); }
    }
  }

  static void UnicodeKey(char c, bool up) {
    INPUT[] a = new INPUT[1];
    a[0].type = 1;
    a[0].u.ki.wVk = 0;
    a[0].u.ki.wScan = (ushort)c;
    a[0].u.ki.dwFlags = up ? 0x0006u : 0x0004u;
    SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void TypeText(string s, int delayMs) {
    for (int i = 0; i < s.Length; i++) {
      char c = s[i];
      if (c == '\r') { continue; }
      if (c == '\n') { Key(0x0D, 0); Key(0x0D, 2); }
      else if (c == '\t') { Key(0x09, 0); Key(0x09, 2); }
      else { UnicodeKey(c, false); UnicodeKey(c, true); }
      if (delayMs > 0) { Thread.Sleep(delayMs); }
    }
  }

  // ---- windows ----
  public static int[] GetBounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) {
      GetWindowRect(h, out r);
    }
    return new int[] { r.Left, r.Top, r.Right, r.Bottom };
  }

  public static NeoWin Describe(IntPtr h) {
    NeoWin w = new NeoWin();
    w.Handle = h.ToInt64();
    int len = GetWindowTextLength(h);
    StringBuilder sb = new StringBuilder(len + 2);
    GetWindowText(h, sb, sb.Capacity);
    w.Title = sb.ToString();
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    w.Pid = pid;
    int[] b = GetBounds(h);
    w.Left = b[0]; w.Top = b[1]; w.Right = b[2]; w.Bottom = b[3];
    w.Minimized = IsIconic(h);
    w.Maximized = IsZoomed(h);
    return w;
  }

  public static List<NeoWin> ListWindows() {
    List<NeoWin> res = new List<NeoWin>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) { return true; }
      if (GetWindowTextLength(h) == 0) { return true; }
      int cloaked = 0;
      DwmGetWindowAttribute(h, 14, out cloaked, 4);
      if (cloaked != 0) { return true; }
      int ex = GetWindowLong(h, -20);
      if ((ex & 0x80) != 0 && (ex & 0x40000) == 0) { return true; }
      res.Add(Describe(h));
      return true;
    }, IntPtr.Zero);
    return res;
  }

  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) { ShowWindow(h, 9); Thread.Sleep(60); }
    // ALT tap: lets this process pass the foreground-lock check.
    Key(0x12, 0);
    Key(0x12, 2);
    IntPtr fg = GetForegroundWindow();
    uint pid;
    uint curThread = GetCurrentThreadId();
    uint fgThread = 0;
    if (fg != IntPtr.Zero) { fgThread = GetWindowThreadProcessId(fg, out pid); }
    uint tgtThread = GetWindowThreadProcessId(h, out pid);
    bool a1 = false;
    bool a2 = false;
    if (fgThread != 0 && fgThread != curThread) { a1 = AttachThreadInput(curThread, fgThread, true); }
    if (tgtThread != 0 && tgtThread != curThread && tgtThread != fgThread) { a2 = AttachThreadInput(curThread, tgtThread, true); }
    BringWindowToTop(h);
    ShowWindow(h, 5);
    SetForegroundWindow(h);
    if (a1) { AttachThreadInput(curThread, fgThread, false); }
    if (a2) { AttachThreadInput(curThread, tgtThread, false); }
    Thread.Sleep(80);
    if (GetForegroundWindow() != h) {
      SwitchToThisWindow(h, true);
      Thread.Sleep(120);
    }
    return GetForegroundWindow() == h;
  }

  // mode 1 = move (keep size), 2 = resize (keep position)
  public static bool MoveResize(IntPtr h, int mode, int x, int y, int w, int ht) {
    if (IsIconic(h) || IsZoomed(h)) { ShowWindow(h, 9); Thread.Sleep(80); }
    RECT r;
    GetWindowRect(h, out r);
    if (mode == 1) { w = r.Right - r.Left; ht = r.Bottom - r.Top; }
    else { x = r.Left; y = r.Top; }
    return MoveWindow(h, x, y, w, ht, true);
  }
}
`;

/** Common head: UTF-8-safe JSON output helper, then opens the try block. */
const HEAD = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Out-Neo($o) {
  $json = ConvertTo-Json -Compress -Depth 8 -InputObject $o
  $json = [regex]::Replace($json, '[^\x00-\x7F]', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) '\u{0:x4}' -f [int][char]$m.Value })
  [Console]::Out.WriteLine($json)
}
try {
$A = $null
if ($env:NEO_ARGS) { $A = $env:NEO_ARGS | ConvertFrom-Json }
`;

const TAIL = String.raw`
} catch {
  $neoMsg = [string]$_.Exception.Message
  Out-Neo @{ neoError = $neoMsg }
}
`;

const NATIVE_LOAD = "$neoSrc = @'\n" + NATIVE_CS + "'@\n" + String.raw`Add-Type -TypeDefinition $neoSrc -Language CSharp
[NeoNative]::DpiAware()
`;

const GUI_LOAD = String.raw`Add-Type -AssemblyName System.Windows.Forms, System.Drawing
`;

/** Resolve a window by handle or title substring (prefers the focused match). Returns [long] or 0. */
const FN_RESOLVE_WINDOW = String.raw`function Resolve-Window($Args1) {
  if ($Args1.handle) {
    $hh = [IntPtr][long]$Args1.handle
    if ([NeoNative]::IsWindow($hh)) { return [long]$Args1.handle }
    throw 'No window exists with that handle.'
  }
  $needle = ([string]$Args1.title).ToLowerInvariant()
  $fg = [NeoNative]::GetForegroundWindow().ToInt64()
  $found = [long]0
  foreach ($w in [NeoNative]::ListWindows()) {
    if ($w.Title.ToLowerInvariant().Contains($needle)) {
      if ($w.Handle -eq $fg) { return [long]$w.Handle }
      if ($found -eq 0) { $found = [long]$w.Handle }
    }
  }
  return $found
}
`;

/** Compute the screen rectangle to capture (region | window | monitor), clipped to the virtual screen. */
const FN_CAPTURE_RECT = String.raw`function Get-CaptureRect($Args1) {
  $vx = [NeoNative]::GetSystemMetrics(76)
  $vy = [NeoNative]::GetSystemMetrics(77)
  $vw = [NeoNative]::GetSystemMetrics(78)
  $vh = [NeoNative]::GetSystemMetrics(79)
  $src = 'monitor'
  if ($Args1.region) {
    $x = [int]$Args1.region.x
    $y = [int]$Args1.region.y
    $w = [int]$Args1.region.width
    $h = [int]$Args1.region.height
    $src = 'region'
  } elseif ($Args1.handle -or $Args1.title) {
    $hwnd = Resolve-Window $Args1
    if ($hwnd -eq 0) { throw 'No visible window matches the given title/handle. Use desktop_list_windows.' }
    $hp = [IntPtr]$hwnd
    if ([NeoNative]::IsIconic($hp)) { throw 'The window is minimized. Restore or focus it first (desktop_window).' }
    $b = [NeoNative]::GetBounds($hp)
    $x = $b[0]
    $y = $b[1]
    $w = $b[2] - $b[0]
    $h = $b[3] - $b[1]
    $src = 'window: ' + ([NeoNative]::Describe($hp)).Title
  } else {
    $screens = [System.Windows.Forms.Screen]::AllScreens
    if ($null -ne $Args1.monitor) {
      $mi = [int]$Args1.monitor
      if ($mi -lt 0 -or $mi -ge $screens.Length) { throw ('Monitor index out of range (0..' + ($screens.Length - 1) + ').') }
      $s = $screens[$mi]
      $src = 'monitor ' + $mi
    } else {
      $s = [System.Windows.Forms.Screen]::PrimaryScreen
      $src = 'primary monitor'
    }
    $x = $s.Bounds.X
    $y = $s.Bounds.Y
    $w = $s.Bounds.Width
    $h = $s.Bounds.Height
  }
  $x2 = [Math]::Min($x + $w, $vx + $vw)
  $y2 = [Math]::Min($y + $h, $vy + $vh)
  $x = [Math]::Max($x, $vx)
  $y = [Math]::Max($y, $vy)
  $w = $x2 - $x
  $h = $y2 - $y
  if ($w -le 0 -or $h -le 0) { throw 'The requested area is outside the virtual screen or empty.' }
  return @{ x = $x; y = $y; w = $w; h = $h; source = $src }
}
function New-ScreenBitmap($r) {
  $bmp = New-Object System.Drawing.Bitmap($r.w, $r.h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.x, $r.y, 0, 0, $bmp.Size)
  $g.Dispose()
  return $bmp
}
function Resize-Bitmap($bmp, $ow, $oh) {
  $small = New-Object System.Drawing.Bitmap($ow, $oh, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $ow, $oh)
  $g2.Dispose()
  $bmp.Dispose()
  return $small
}
`;

function build(opts: { native?: boolean; gui?: boolean; fns?: string[]; body: string }): string {
  return (
    HEAD +
    (opts.native ? NATIVE_LOAD : '') +
    (opts.gui ? GUI_LOAD : '') +
    (opts.fns ?? []).join('') +
    opts.body +
    TAIL
  );
}

export const SCRIPT_SCREENSHOT = build({
  native: true,
  gui: true,
  fns: [FN_RESOLVE_WINDOW, FN_CAPTURE_RECT],
  body: String.raw`$r = Get-CaptureRect $A
$bmp = New-ScreenBitmap $r
$mw = [int]$A.maxWidth
$ow = $r.w
$oh = $r.h
if ($ow -gt $mw) {
  $ow = $mw
  $oh = [int][Math]::Max(1, [Math]::Round($r.h * $mw / $r.w))
  $bmp = Resize-Bitmap $bmp $ow $oh
}
$ms = New-Object System.IO.MemoryStream
if ([string]$A.format -eq 'jpeg') {
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
  $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$A.quality)
  $bmp.Save($ms, $enc, $ep)
  $mime = 'image/jpeg'
} else {
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $mime = 'image/png'
}
$bmp.Dispose()
$b64 = [Convert]::ToBase64String($ms.ToArray())
$ms.Dispose()
Out-Neo @{ b64 = $b64; mime = $mime; x = $r.x; y = $r.y; width = $r.w; height = $r.h; outWidth = $ow; outHeight = $oh; source = $r.source }`,
});

export const SCRIPT_OCR = build({
  native: true,
  gui: true,
  fns: [FN_RESOLVE_WINDOW, FN_CAPTURE_RECT],
  body: String.raw`Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.RandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + '`' + String.raw`1' })[0]
function Await($op, $type) {
  $m = $asTaskGeneric.MakeGenericMethod($type)
  $t = $m.Invoke($null, @($op))
  [void]$t.Wait(-1)
  return $t.Result
}
$engine = $null
$langUsed = ''
if ($A.language) {
  $lang = New-Object Windows.Globalization.Language ([string]$A.language)
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
  if (-not $engine) { throw ('OCR language not available: ' + [string]$A.language + '. Install the language pack or omit "language".') }
}
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'en-US'))
}
if (-not $engine) { throw 'No OCR engine available (install a Windows language pack with OCR support).' }
$langUsed = [string]$engine.RecognizerLanguage.LanguageTag
$r = Get-CaptureRect $A
$bmp = New-ScreenBitmap $r
$maxDim = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$scale = 1.0
if ($r.w -gt $maxDim -or $r.h -gt $maxDim) {
  $scale = [double]$maxDim / [double][Math]::Max($r.w, $r.h)
  $bmp = Resize-Bitmap $bmp ([int][Math]::Floor($r.w * $scale)) ([int][Math]::Floor($r.h * $scale))
}
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[void]$ms.Seek(0, [System.IO.SeekOrigin]::Begin)
$ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
$sb = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
$lines = New-Object System.Collections.ArrayList
foreach ($ln in $res.Lines) {
  $words = New-Object System.Collections.ArrayList
  foreach ($wd in $ln.Words) {
    $br = $wd.BoundingRect
    [void]$words.Add(@{ text = [string]$wd.Text; x = [int][Math]::Round($r.x + $br.X / $scale); y = [int][Math]::Round($r.y + $br.Y / $scale); width = [int][Math]::Round($br.Width / $scale); height = [int][Math]::Round($br.Height / $scale) })
  }
  if ($words.Count -gt 0) {
    $x1 = ($words | ForEach-Object { $_.x } | Measure-Object -Minimum).Minimum
    $y1 = ($words | ForEach-Object { $_.y } | Measure-Object -Minimum).Minimum
    $x2 = ($words | ForEach-Object { $_.x + $_.width } | Measure-Object -Maximum).Maximum
    $y2 = ($words | ForEach-Object { $_.y + $_.height } | Measure-Object -Maximum).Maximum
    [void]$lines.Add(@{ text = [string]$ln.Text; x = [int]$x1; y = [int]$y1; width = [int]($x2 - $x1); height = [int]($y2 - $y1); words = $words })
  }
}
Out-Neo @{ language = $langUsed; region = @{ x = $r.x; y = $r.y; width = $r.w; height = $r.h }; source = $r.source; lines = $lines }`,
});

export const SCRIPT_MONITORS = build({
  native: true,
  gui: true,
  body: String.raw`$list = New-Object System.Collections.ArrayList
$i = 0
foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
  [void]$list.Add(@{
    index = $i
    primary = [bool]$s.Primary
    name = [string]$s.DeviceName
    x = $s.Bounds.X
    y = $s.Bounds.Y
    width = $s.Bounds.Width
    height = $s.Bounds.Height
    workArea = @{ x = $s.WorkingArea.X; y = $s.WorkingArea.Y; width = $s.WorkingArea.Width; height = $s.WorkingArea.Height }
  })
  $i++
}
$cp = [NeoNative]::CursorPos()
Out-Neo @{
  virtualScreen = @{ x = [NeoNative]::GetSystemMetrics(76); y = [NeoNative]::GetSystemMetrics(77); width = [NeoNative]::GetSystemMetrics(78); height = [NeoNative]::GetSystemMetrics(79) }
  cursor = @{ x = $cp[0]; y = $cp[1] }
  monitors = $list
}`,
});

export const SCRIPT_LIST_WINDOWS = build({
  native: true,
  body: String.raw`$pm = @{}
foreach ($p in Get-Process) { $pm[[int]$p.Id] = [string]$p.ProcessName }
$fg = [NeoNative]::GetForegroundWindow().ToInt64()
$filter = ''
if ($A.filter) { $filter = ([string]$A.filter).ToLowerInvariant() }
$list = New-Object System.Collections.ArrayList
foreach ($w in [NeoNative]::ListWindows()) {
  if ($filter -ne '' -and -not $w.Title.ToLowerInvariant().Contains($filter)) { continue }
  $pn = ''
  if ($pm.ContainsKey([int]$w.Pid)) { $pn = $pm[[int]$w.Pid] }
  [void]$list.Add(@{
    handle = $w.Handle
    title = $w.Title
    process = $pn
    pid = [int]$w.Pid
    x = $w.Left
    y = $w.Top
    width = $w.Right - $w.Left
    height = $w.Bottom - $w.Top
    minimized = [bool]$w.Minimized
    maximized = [bool]$w.Maximized
    focused = ($w.Handle -eq $fg)
  })
}
Out-Neo @{ windows = $list }`,
});

export const SCRIPT_WINDOW = build({
  native: true,
  fns: [FN_RESOLVE_WINDOW],
  body: String.raw`$h = Resolve-Window $A
if ($h -eq 0) { throw 'No visible window matches the given title/handle. Use desktop_list_windows.' }
$hp = [IntPtr]$h
$act = [string]$A.action
$ok = $true
if ($act -eq 'focus') { $ok = [NeoNative]::Focus($hp) }
elseif ($act -eq 'minimize') { [void][NeoNative]::ShowWindow($hp, 6) }
elseif ($act -eq 'maximize') { [void][NeoNative]::ShowWindow($hp, 3) }
elseif ($act -eq 'restore') { [void][NeoNative]::ShowWindow($hp, 9) }
elseif ($act -eq 'close') { [void][NeoNative]::PostMessage($hp, 0x10, [IntPtr]::Zero, [IntPtr]::Zero) }
elseif ($act -eq 'move') { $ok = [NeoNative]::MoveResize($hp, 1, [int]$A.x, [int]$A.y, 0, 0) }
elseif ($act -eq 'resize') { $ok = [NeoNative]::MoveResize($hp, 2, 0, 0, [int]$A.width, [int]$A.height) }
else { throw ('Unknown action: ' + $act) }
Start-Sleep -Milliseconds 200
$info = $null
if ([NeoNative]::IsWindow($hp)) {
  $d = [NeoNative]::Describe($hp)
  $fg = [NeoNative]::GetForegroundWindow().ToInt64()
  $info = @{ handle = $d.Handle; title = $d.Title; x = $d.Left; y = $d.Top; width = $d.Right - $d.Left; height = $d.Bottom - $d.Top; minimized = [bool]$d.Minimized; maximized = [bool]$d.Maximized; focused = ($d.Handle -eq $fg) }
}
Out-Neo @{ action = $act; ok = [bool]$ok; window = $info; targetHandle = $h }`,
});

export const SCRIPT_MOUSE = build({
  native: true,
  body: String.raw`$kind = [string]$A.kind
$mods = @()
if ($A.mods) { $mods = @($A.mods) }
foreach ($mv in $mods) { [NeoNative]::Key([int]$mv, 0) }
try {
  if ($null -ne $A.x -and $null -ne $A.y -and $kind -ne 'position') {
    [NeoNative]::MoveTo([int]$A.x, [int]$A.y)
    Start-Sleep -Milliseconds 30
  }
  if ($kind -eq 'move') {
  }
  elseif ($kind -eq 'click' -or $kind -eq 'double_click' -or $kind -eq 'right_click' -or $kind -eq 'middle_click') {
    $btn = 0
    if ($kind -eq 'right_click') { $btn = 1 }
    if ($kind -eq 'middle_click') { $btn = 2 }
    $times = 1
    if ($kind -eq 'double_click') { $times = 2 }
    for ($i = 0; $i -lt $times; $i++) {
      [NeoNative]::Button($btn, $true)
      Start-Sleep -Milliseconds 25
      [NeoNative]::Button($btn, $false)
      if ($i -lt ($times - 1)) { Start-Sleep -Milliseconds 60 }
    }
  }
  elseif ($kind -eq 'drag') {
    [NeoNative]::Button(0, $true)
    Start-Sleep -Milliseconds 80
    $cp = [NeoNative]::CursorPos()
    $sx = $cp[0]
    $sy = $cp[1]
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
      $nx = [int][Math]::Round($sx + ([int]$A.toX - $sx) * $i / $steps)
      $ny = [int][Math]::Round($sy + ([int]$A.toY - $sy) * $i / $steps)
      [NeoNative]::MoveTo($nx, $ny)
      Start-Sleep -Milliseconds 15
    }
    Start-Sleep -Milliseconds 60
    [NeoNative]::Button(0, $false)
  }
  elseif ($kind -eq 'scroll') {
    $horiz = $false
    if ($A.horizontal -eq $true) { $horiz = $true }
    $notches = [int]$A.amount
    $dir = 1
    if ($notches -lt 0) { $dir = -1 }
    $n = [Math]::Abs($notches)
    for ($i = 0; $i -lt $n; $i++) {
      [NeoNative]::Wheel($dir * 120, $horiz)
      Start-Sleep -Milliseconds 15
    }
  }
  elseif ($kind -eq 'position') {
  }
  else { throw ('Unknown mouse action: ' + $kind) }
}
finally {
  for ($i = $mods.Count - 1; $i -ge 0; $i--) { [NeoNative]::Key([int]$mods[$i], 2) }
}
Start-Sleep -Milliseconds 30
$p = [NeoNative]::CursorPos()
Out-Neo @{ action = $kind; x = $p[0]; y = $p[1] }`,
});

export const SCRIPT_KEYBOARD = build({
  native: true,
  body: String.raw`$kind = [string]$A.kind
if ($kind -eq 'type') {
  [NeoNative]::TypeText([string]$A.text, [int]$A.delay)
  Out-Neo @{ action = 'type'; chars = ([string]$A.text).Length }
} else {
  [NeoNative]::Keys([int[]]@($A.vks), [int[]]@($A.flags), [int]$A.delay)
  Out-Neo @{ action = $kind; events = @($A.vks).Count }
}`,
});

export const SCRIPT_CLIPBOARD_GET = build({
  gui: true,
  body: String.raw`$text = ''
$hasText = $false
$hasImage = $false
$hasFiles = $false
$imgW = 0
$imgH = 0
$files = New-Object System.Collections.ArrayList
$lastErr = $null
for ($i = 0; $i -lt 6; $i++) {
  try {
    $lastErr = $null
    $files.Clear()
    $hasText = [System.Windows.Forms.Clipboard]::ContainsText()
    $hasImage = [System.Windows.Forms.Clipboard]::ContainsImage()
    $hasFiles = [System.Windows.Forms.Clipboard]::ContainsFileDropList()
    if ($hasText) { $text = [System.Windows.Forms.Clipboard]::GetText() }
    if ($hasFiles) {
      foreach ($f in [System.Windows.Forms.Clipboard]::GetFileDropList()) { [void]$files.Add([string]$f) }
    }
    if ($hasImage) {
      $img = [System.Windows.Forms.Clipboard]::GetImage()
      if ($img) { $imgW = $img.Width; $imgH = $img.Height; $img.Dispose() }
    }
    break
  } catch {
    $lastErr = [string]$_.Exception.Message
    Start-Sleep -Milliseconds 120
  }
}
if ($lastErr) { throw ('Clipboard is busy or unavailable: ' + $lastErr) }
Out-Neo @{ hasText = $hasText; text = $text; hasImage = $hasImage; imageWidth = $imgW; imageHeight = $imgH; hasFiles = $hasFiles; files = $files }`,
});

export const SCRIPT_CLIPBOARD_SET = build({
  gui: true,
  body: String.raw`$txt = [string]$A.text
$lastErr = $null
for ($i = 0; $i -lt 6; $i++) {
  try {
    $lastErr = $null
    if ($txt.Length -eq 0) { [System.Windows.Forms.Clipboard]::Clear() }
    else { [System.Windows.Forms.Clipboard]::SetDataObject($txt, $true, 5, 100) }
    break
  } catch {
    $lastErr = [string]$_.Exception.Message
    Start-Sleep -Milliseconds 120
  }
}
if ($lastErr) { throw ('Clipboard is busy or unavailable: ' + $lastErr) }
Out-Neo @{ ok = $true; length = $txt.Length }`,
});

export const SCRIPT_OPEN = build({
  body: String.raw`$target = [string]$A.target
$parts = New-Object System.Collections.ArrayList
if ($A.args) {
  foreach ($arg1 in @($A.args)) {
    $s = [string]$arg1
    $quoted = ($s.Length -ge 2 -and $s.StartsWith('"') -and $s.EndsWith('"'))
    if (-not $quoted -and ($s.Length -eq 0 -or $s -match '\s')) {
      $s = '"' + $s.Replace('"', '\"') + '"'
    }
    [void]$parts.Add($s)
  }
}
if ($parts.Count -gt 0) {
  $proc = Start-Process -FilePath $target -ArgumentList ([string]::Join(' ', $parts.ToArray())) -PassThru
} else {
  $proc = Start-Process -FilePath $target -PassThru
}
$procId = $null
$procName = $null
if ($proc) {
  try { $procId = [int]$proc.Id; $procName = [string]$proc.ProcessName } catch { }
}
Out-Neo @{ opened = $target; pid = $procId; process = $procName }`,
});

export const SCRIPT_SYSTEM_INFO = build({
  body: String.raw`$os = Get-CimInstance Win32_OperatingSystem
$cs = Get-CimInstance Win32_ComputerSystem
$cpuList = @(Get-CimInstance Win32_Processor)
$span = (Get-Date) - $os.LastBootUpTime
$disks = New-Object System.Collections.ArrayList
foreach ($d in @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3')) {
  [void]$disks.Add(@{ drive = [string]$d.DeviceID; label = [string]$d.VolumeName; totalGB = [math]::Round($d.Size / 1GB, 1); freeGB = [math]::Round($d.FreeSpace / 1GB, 1) })
}
$battery = $null
$bat = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
if ($bat) {
  $battery = @{ percent = [int]$bat.EstimatedChargeRemaining; charging = ([int]$bat.BatteryStatus -ne 1); status = [int]$bat.BatteryStatus }
}
$topCpu = New-Object System.Collections.ArrayList
try {
  $perf = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.Name -ne 'Idle' } | Sort-Object PercentProcessorTime -Descending | Select-Object -First 10
  foreach ($pp in $perf) {
    [void]$topCpu.Add(@{ name = [string]$pp.Name; pid = [int]$pp.IDProcess; cpuPercent = [int]$pp.PercentProcessorTime; memoryMB = [math]::Round($pp.WorkingSetPrivate / 1MB) })
  }
} catch { }
$topMem = New-Object System.Collections.ArrayList
foreach ($pr in (Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 10)) {
  [void]$topMem.Add(@{ name = [string]$pr.ProcessName; pid = [int]$pr.Id; memoryMB = [math]::Round($pr.WorkingSet64 / 1MB) })
}
$nets = New-Object System.Collections.ArrayList
try {
  foreach ($ip in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' })) {
    [void]$nets.Add(@{ adapter = [string]$ip.InterfaceAlias; ipv4 = [string]$ip.IPAddress })
  }
} catch { }
$cpuNames = @()
foreach ($c in $cpuList) { $cpuNames += [string]$c.Name.Trim() }
$cores = 0
$logical = 0
$load = 0
foreach ($c in $cpuList) { $cores += [int]$c.NumberOfCores; $logical += [int]$c.NumberOfLogicalProcessors; $load += [int]$c.LoadPercentage }
if ($cpuList.Count -gt 0) { $load = [int]($load / $cpuList.Count) }
Out-Neo @{
  os = @{ name = [string]$os.Caption; version = [string]$os.Version; build = [string]$os.BuildNumber; architecture = [string]$os.OSArchitecture }
  hostname = [string]$env:COMPUTERNAME
  user = [string]$env:USERNAME
  manufacturer = [string]$cs.Manufacturer
  model = [string]$cs.Model
  cpu = @{ names = $cpuNames; cores = $cores; logicalProcessors = $logical; loadPercent = $load }
  memory = @{ totalMB = [math]::Round($os.TotalVisibleMemorySize / 1024); freeMB = [math]::Round($os.FreePhysicalMemory / 1024) }
  disks = $disks
  uptimeSeconds = [int]$span.TotalSeconds
  battery = $battery
  topProcessesByCpu = $topCpu
  topProcessesByMemory = $topMem
  network = $nets
}`,
});

export const SCRIPT_NOTIFY = build({
  gui: true,
  body: String.raw`$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = [string]$A.title
$n.BalloonTipText = [string]$A.message
$n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
$n.Visible = $true
$n.ShowBalloonTip(5000)
Start-Sleep -Milliseconds 3500
$n.Visible = $false
$n.Dispose()
Out-Neo @{ ok = $true }`,
});

export const ALL_SCRIPTS: Record<string, string> = {
  screenshot: SCRIPT_SCREENSHOT,
  ocr: SCRIPT_OCR,
  monitors: SCRIPT_MONITORS,
  listWindows: SCRIPT_LIST_WINDOWS,
  window: SCRIPT_WINDOW,
  mouse: SCRIPT_MOUSE,
  keyboard: SCRIPT_KEYBOARD,
  clipboardGet: SCRIPT_CLIPBOARD_GET,
  clipboardSet: SCRIPT_CLIPBOARD_SET,
  open: SCRIPT_OPEN,
  systemInfo: SCRIPT_SYSTEM_INFO,
  notify: SCRIPT_NOTIFY,
};
