import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Path containment helpers. Windows-looking paths are handled with path.win32 (so this is
 * testable on Linux). Limitations: symlinks/junctions and 8.3 short names are not resolved.
 */

const WIN_DRIVE = /^[a-zA-Z]:/;

function stripExtendedPrefix(p: string): string {
  // \\?\C:\x  -> C:\x ;  \\?\UNC\srv\share -> \\srv\share ;  also //?/ and \\.\ forms
  const m = /^[\\/]{2}[?.][\\/](.*)$/s.exec(p);
  if (!m) return p;
  const rest = m[1];
  const unc = /^UNC[\\/](.*)$/is.exec(rest);
  return unc ? '\\\\' + unc[1] : rest;
}

export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return homedir() + p.slice(1);
  return p;
}

/** True if the (prefix-stripped, tilde-expanded) string is explicitly Windows-flavoured. */
export function isWindowsStyle(p: string): boolean {
  return WIN_DRIVE.test(p) || p.includes('\\') || p.startsWith('//');
}

function prep(p: string): string {
  return stripExtendedPrefix(expandTilde(p));
}

/**
 * Normalize `p` in the flavour of `dirStyleWindows`. Returns undefined if the path cannot be
 * compared in that flavour (e.g. a Windows path against a POSIX dir) or is suspicious.
 */
function normalizeIn(p: string, base: string, windows: boolean): string | undefined {
  let s = prep(p);
  if (s.includes('\0')) return undefined;
  if (windows) {
    // alternate data streams / device names: a colon anywhere but the drive designator
    if (s.slice(2).includes(':') || (s.length > 1 && s[1] !== ':' && s.includes(':'))) return undefined;
    const resolved = path.win32.resolve(base, s);
    // Windows silently trims trailing dots/spaces of a segment; refuse such segments.
    for (const seg of resolved.split('\\')) {
      if (seg !== '' && seg !== '.' && seg !== '..' && /[ .]$/.test(seg)) return undefined;
    }
    return trimSep(resolved.toLowerCase(), true);
  }
  if (WIN_DRIVE.test(s) || s.includes('\\')) return undefined;
  return trimSep(path.posix.resolve(base, s), false);
}

function trimSep(s: string, windows: boolean): string {
  const sep = windows ? /[\\]+$/ : /\/+$/;
  const t = s.replace(sep, '');
  // keep POSIX root as '' (so prefix check uses '/'), windows root 'c:' (prefix 'c:\')
  return t;
}

function dirIsWindows(dir: string): boolean {
  return isWindowsStyle(prep(dir));
}

/** Normalized form of `dir` (as a containment root), or undefined if unusable. */
function normalizeDir(dir: string): { norm: string; windows: boolean } | undefined {
  const d = prep(dir);
  const windows = isWindowsStyle(d);
  const cwdBase = windows ? 'C:\\' : '/';
  // for UNC/drive dirs base is irrelevant; relative dirs are anchored at the root
  const norm = normalizeIn(d, cwdBase, windows);
  return norm === undefined ? undefined : { norm, windows };
}

function contains(root: string, candidate: string, windows: boolean): boolean {
  const sep = windows ? '\\' : '/';
  return candidate === root || candidate.startsWith(root + sep);
}

export interface InsideOptions {
  /** Directory relative paths are resolved against. Defaults to dirs[0]. */
  base?: string;
}

/** Is `p` inside at least one of `dirs`? Empty `dirs` => false. */
export function isInsideAny(p: unknown, dirs: string[], opts: InsideOptions = {}): boolean {
  if (typeof p !== 'string' || p.trim() === '') return false;
  const rawBase = opts.base ?? dirs[0];
  for (const dir of dirs) {
    const nd = normalizeDir(dir);
    if (!nd) continue;
    let base: string;
    if (rawBase === undefined) base = nd.windows ? 'C:\\' : '/';
    else {
      const b = prep(rawBase);
      // a base of the wrong flavour cannot anchor relative paths for this dir
      base = isWindowsStyle(b) === nd.windows ? b : nd.windows ? 'C:\\' : '/';
    }
    // For a windows dir, any non-Windows-looking p is interpreted relative/rooted on Windows.
    const cand = normalizeIn(p, base, nd.windows);
    if (cand !== undefined && contains(nd.norm, cand, nd.windows)) return true;
  }
  return false;
}

/** Normalize a command/text for substring matching of protected locations. */
export function looseKey(s: string): string {
  return prep(s).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
}

export { dirIsWindows };
