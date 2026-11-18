/** Plan how desktop_open launches a target on macOS (pure; filesystem probes are injected for tests). */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ArgError } from './validate.js';

export const OPEN = '/usr/bin/open';

export interface OpenPlan {
  kind: 'url' | 'app-bundle' | 'folder' | 'file' | 'executable' | 'app-name';
  file: string;
  args: string[];
  /** Pid is only known for directly spawned executables. */
  spawn: boolean;
}

export interface FsProbe {
  stat(path: string): { isDirectory: boolean; isFile: boolean; executable: boolean } | undefined;
  home: string;
}

function statSafe(path: string): { isDirectory: boolean; isFile: boolean; executable: boolean } | undefined {
  try {
    const s = statSync(path);
    return { isDirectory: s.isDirectory(), isFile: s.isFile(), executable: (s.mode & 0o111) !== 0 };
  } catch {
    return undefined;
  }
}

export const realProbe: FsProbe = { stat: statSafe, home: homedir() };

/** Windows-style app names an AI is likely to use -> macOS applications. */
export const APP_ALIASES: Record<string, string> = {
  notepad: 'TextEdit',
  textedit: 'TextEdit',
  calc: 'Calculator',
  calculator: 'Calculator',
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
  msedge: 'Microsoft Edge',
  code: 'Visual Studio Code',
  vscode: 'Visual Studio Code',
  explorer: 'Finder',
  cmd: 'Terminal',
  powershell: 'Terminal',
  terminal: 'Terminal',
  paint: 'Preview',
  mspaint: 'Preview',
  word: 'Microsoft Word',
  excel: 'Microsoft Excel',
  outlook: 'Microsoft Outlook',
  taskmgr: 'Activity Monitor',
};

const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:(\/\/|[^\s/])/;

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

export function looksLikePath(t: string): boolean {
  return t.startsWith('/') || t.startsWith('~/') || t === '~' || t.startsWith('./') || t.startsWith('../');
}

export function planOpen(target: string, args: string[] | undefined, probe: FsProbe = realProbe): OpenPlan {
  const a = args ?? [];
  if (URL_RE.test(target) && !looksLikePath(target)) {
    if (a.length > 0) throw new ArgError('"args" only apply to applications and executables, not to URLs.');
    return { kind: 'url', file: OPEN, args: [target], spawn: false };
  }
  if (looksLikePath(target)) {
    const path = expandHome(target, probe.home);
    const st = probe.stat(path);
    if (!st) throw new ArgError(`Path not found: ${path}`);
    if (st.isDirectory && /\.app\/?$/i.test(path)) {
      return { kind: 'app-bundle', file: OPEN, args: ['-a', path, ...(a.length ? ['--args', ...a] : [])], spawn: false };
    }
    if (st.isDirectory) {
      if (a.length > 0) throw new ArgError('"args" only apply to applications and executables, not to folders.');
      return { kind: 'folder', file: OPEN, args: [path], spawn: false };
    }
    if (st.isFile && st.executable && isProgramLike(path)) {
      return { kind: 'executable', file: path, args: a, spawn: true };
    }
    if (a.length > 0) {
      // A document with arguments: let the default app open it; arguments are meaningless there.
      throw new ArgError('"args" only apply to applications and executables, not to documents. Open the document without args or name an application.');
    }
    return { kind: 'file', file: OPEN, args: [path], spawn: false };
  }
  // Bare application name ("Safari", "chrome", "Google Chrome").
  const app = APP_ALIASES[target.toLowerCase()] ?? target.replace(/\.app$/i, '');
  return { kind: 'app-name', file: OPEN, args: ['-a', app, ...(a.length ? ['--args', ...a] : [])], spawn: false };
}

/** Executable files that are programs, not documents that merely have the x bit (e.g. a copied .pdf). */
function isProgramLike(path: string): boolean {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  if (!ext) return true;
  return ['sh', 'bash', 'zsh', 'py', 'rb', 'pl', 'js', 'mjs'].includes(ext);
}
