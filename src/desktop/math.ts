/** Pure coordinate math shared with (and mirrored by) the PowerShell/C# side. */

/**
 * Normalize a pixel coordinate to the 0..65535 absolute range used by SendInput with
 * MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK. `origin`/`size` describe the virtual screen
 * on that axis. Uses ceil(v*65536/size) so that Windows' floor(n*size/65536) lands exactly on v.
 */
export function normalizeAbs(value: number, origin: number, size: number): number {
  if (size <= 0) return 0;
  const n = Math.ceil(((value - origin) * 65536) / size);
  return Math.min(65535, Math.max(0, n));
}

/** Inverse of normalizeAbs (what pixel Windows will pick for a normalized value). */
export function denormalizeAbs(n: number, origin: number, size: number): number {
  return origin + Math.floor((n * size) / 65536);
}

/** Map a point in a (possibly downscaled) screenshot back to screen coordinates. */
export function imageToScreen(
  ix: number,
  iy: number,
  offsetX: number,
  offsetY: number,
  scale: number,
): { x: number; y: number } {
  return { x: Math.round(offsetX + ix / scale), y: Math.round(offsetY + iy / scale) };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function center(b: Box): { x: number; y: number } {
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

export function unionBox(boxes: Box[]): Box {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x);
    y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width);
    y2 = Math.max(y2, b.y + b.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}
