/**
 * Process + JXA runner for macOS. User input NEVER enters script text: JXA scripts are constant strings that read
 * a JSON blob from the NEO_ARGS environment variable (same design as the Windows PowerShell scripts); external
 * commands (screencapture, sips, pbcopy, open, ...) get their arguments as an argv array, never through a shell.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PsError, type PsOptions } from './ps.js';

export const OSASCRIPT = '/usr/bin/osascript';
const MAX_ARGS_JSON = 200000;
const MAX_STDOUT = 64 * 1024 * 1024;

/** Thrown for failures; `code` carries machine-readable reasons from the JXA scripts (PERM_AX, ...). */
export class MacError extends PsError {
  constructor(
    message: string,
    public readonly code: string = '',
  ) {
    super(message);
  }
}

export interface ExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Written to stdin. */
  input?: string;
  env?: Record<string, string>;
  maxBuffer?: number;
}

export interface ExecResult {
  stdout: Buffer;
  stderr: string;
  code: number | null;
}

export type Exec = (file: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;
export type JxaRunner = (script: string, input: unknown, opts?: PsOptions) => Promise<Record<string, unknown>>;

export const UTF8_ENV = { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };

export function execFileBuffer(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxBuffer = opts.maxBuffer ?? MAX_STDOUT;
  if (opts.signal?.aborted) return Promise.reject(new MacError('Aborted.'));
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(file, args, {
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env ?? {}) },
    });
    const out: Buffer[] = [];
    let size = 0;
    let err = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let tooBig = false;
    const kill = (): void => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (b: Buffer) => {
      size += b.length;
      if (size > maxBuffer) {
        tooBig = true;
        kill();
        return;
      }
      out.push(b);
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (err.length < 8000) err += b.toString('utf8');
    });
    child.on('error', (e) => finish(() => reject(new MacError(`Could not start ${file}: ${e.message}`))));
    child.on('close', (code) => {
      finish(() => {
        if (timedOut) return reject(new MacError(`${file} timed out after ${timeoutMs} ms.`));
        if (aborted) return reject(new MacError('Aborted.'));
        if (tooBig) return reject(new MacError(`${file} produced too much output.`));
        resolve({ stdout: Buffer.concat(out), stderr: err, code });
      });
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(opts.input, 'utf8');
    }
  });
}

/** Run a command and require exit code 0; returns stdout as UTF-8 text. */
export async function execText(file: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await macHooks.exec(file, args, { ...opts, env: { ...UTF8_ENV, ...(opts.env ?? {}) } });
  if (r.code !== 0) {
    const detail = (r.stderr.trim() || r.stdout.toString('utf8').trim()).slice(0, 500);
    throw new MacError(`${file.split('/').pop()} failed (exit code ${r.code}). ${detail}`.trim());
  }
  return r.stdout.toString('utf8');
}

/**
 * Run a JXA script from a private temp file (`osascript -l JavaScript <file>`); user input travels ONLY via the
 * NEO_ARGS env var (JSON).
 */
export async function runJxa(script: string, input: unknown, opts: PsOptions = {}): Promise<Record<string, unknown>> {
  const json = JSON.stringify(input ?? {});
  if (json.length > MAX_ARGS_JSON) throw new MacError(`Arguments too large (${json.length} > ${MAX_ARGS_JSON} characters).`);
  const path = join(tmpdir(), `neo-jxa-${randomBytes(12).toString('hex')}.js`);
  writeFileSync(path, script + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  try {
    const r = await macHooks.exec(OSASCRIPT, ['-l', 'JavaScript', path], {
      timeoutMs: opts.timeoutMs ?? 20000,
      ...(opts.signal ? { signal: opts.signal } : {}),
      env: { ...UTF8_ENV, NEO_ARGS: json },
    });
    return parseJxaOutput(r.stdout.toString('utf8'), r.stderr, r.code);
  } finally {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Parse the single JSON line a script returns. osascript prints a JXA return value on stdout (some versions on
 * stderr), so both streams are scanned, last line first.
 */
export function parseJxaOutput(stdout: string, stderr: string, code: number | null): Record<string, unknown> {
  const lines = (stdout + '\n' + stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as string;
    if (!l.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(l);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      if (typeof o['neoError'] === 'string') {
        const c = typeof o['neoCode'] === 'string' ? (o['neoCode'] as string) : '';
        throw new MacError(c ? permissionOrCodeMessage(c, o['neoError'] as string) : (o['neoError'] as string), c);
      }
      return o;
    }
  }
  const detail = (stderr.trim() || lines.slice(-3).join(' | ')).slice(0, 600);
  throw new MacError(`osascript produced no result (exit code ${code}). ${detail}`.trim());
}

// ---------- permissions ----------

/** Name of the app that must be granted permissions: the packaged app, or the terminal/node in development. */
export function hostAppName(isElectron = typeof process.versions['electron'] === 'string'): string {
  return isElectron ? 'Neo Commander' : 'Terminal (or the app that started node, e.g. iTerm2 / VS Code) / node';
}

export function accessibilityMessage(app = hostAppName()): string {
  return (
    `Erişilebilirlik izni gerekli / Accessibility permission required. ` +
    `Sistem Ayarları > Gizlilik ve Güvenlik > Erişilebilirlik bölümünü açın ve "${app}" uygulamasına izin verin, sonra tekrar deneyin. ` +
    `Open System Settings > Privacy & Security > Accessibility and enable "${app}", then retry. ` +
    `(Shortcut: open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")`
  );
}

export function screenRecordingMessage(app = hostAppName()): string {
  return (
    `Ekran Kaydı izni gerekli / Screen Recording permission required. ` +
    `Sistem Ayarları > Gizlilik ve Güvenlik > Ekran Kaydı (macOS 15: "Ekran ve Sistem Ses Kaydı") bölümünü açın ve "${app}" uygulamasına izin verin; ` +
    `uygulamayı yeniden başlatın. ` +
    `Open System Settings > Privacy & Security > Screen Recording (macOS 15: "Screen & System Audio Recording"), enable "${app}", then restart it and retry. ` +
    `(Shortcut: open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")`
  );
}

export function permissionOrCodeMessage(code: string, fallback: string): string {
  if (code === 'PERM_AX') return accessibilityMessage();
  if (code === 'PERM_SCREEN') return screenRecordingMessage();
  if (code === 'NO_WINDOW') return 'The window could not be found through the Accessibility API (it may have closed). Use desktop_list_windows.';
  return fallback;
}

/** Test seams. */
export const macHooks: { exec: Exec; runJxa: JxaRunner; sleep: (ms: number) => Promise<void> } = {
  exec: execFileBuffer,
  runJxa,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};
