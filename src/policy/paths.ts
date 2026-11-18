import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Path containment helpers. Windows-looking paths are handled with path.win32 (so this is
 * testable on Linux). The purely lexical checks (isInsideAny) do not resolve symlinks/junctions or
 * 8.3 short names; the realPath* helpers below add that on top, using the real file system of the
 * OS we run on (so Windows-style paths are only resolved when actually running on Windows).
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

// ---- real-path resolution (symlinks, junctions, 8.3 names) -------------------------------------

const MAX_REAL_INPUT = 8192;

/**
 * Real path of `p` on THIS OS via fs.realpathSync.native. For a path that does not exist, the nearest
 * existing ancestor is resolved and the missing tail re-appended (so "link/new.txt" is judged by where
 * "link" really points). Dangling symlinks are followed manually. Returns undefined when `p` cannot
 * be interpreted on this OS (e.g. "C:\\x" on Linux) - callers then rely on the lexical check only.
 * `raw` keeps ".." segments for the OS to resolve (matters for "link/.."); otherwise they are
 * collapsed lexically first (which is what most tools do before touching the disk).
 */
function realPathOne(p: string, base: string, raw: boolean): string | undefined {
  const s = prep(p);
  if (s === '' || s.length > MAX_REAL_INPUT || s.includes('\0')) return undefined;
  if (process.platform !== 'win32' && (WIN_DRIVE.test(s) || s.includes('\\'))) return undefined;
  let cur = path.isAbsolute(s) ? s : base + path.sep + s;
  if (!raw) cur = path.resolve(cur);
  const rest: string[] = [];
  let hops = 0;
  for (let i = 0; i < 4096; i++) {
    try {
      return path.join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      // Dangling symlink at this level? Follow it by hand so its target is judged, not its name.
      try {
        if (hops < 32 && lstatSync(cur).isSymbolicLink()) {
          hops++;
          cur = path.resolve(path.dirname(cur), readlinkSync(cur));
          continue;
        }
      } catch { /* not a link / not readable */ }
      const parent = path.dirname(cur);
      if (parent === cur) return path.normalize(cur);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  return path.normalize(cur);
}

/** Real-path interpretations of `p` (".."-raw and ".."-collapsed). Empty when not resolvable here. */
export function realCandidates(p: string, base: string = process.cwd()): string[] {
  const b = prep(base);
  const out = new Set<string>();
  for (const raw of [true, false]) {
    const r = realPathOne(p, b, raw);
    if (r !== undefined) out.add(r);
  }
  return [...out];
}

/** Real path(s) of a containment root (a directory setting). */
export function realRoots(dirs: string[]): string[] {
  const out = new Set<string>();
  for (const d of dirs) for (const r of realCandidates(d, path.parse(process.cwd()).root)) out.add(r);
  return [...out];
}

/** Native containment test on already-real paths (case-insensitive on Windows via path.relative). */
export function realContains(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  const first = rel.split(path.sep)[0];
  return first !== '..' && !path.isAbsolute(rel);
}
