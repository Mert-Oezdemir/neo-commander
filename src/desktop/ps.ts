import { spawn } from 'node:child_process';

export const WINDOWS_ONLY = "Bu araç yalnızca Windows'ta çalışır / Windows only";

export class PsError extends Error {}

export interface PsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Max size of the JSON arguments blob (a single Windows environment variable is limited to 32767 chars). */
export const MAX_ARGS_JSON = 30000;
const MAX_STDOUT = 96 * 1024 * 1024;

export type PsRunner = (script: string, input: unknown, opts?: PsOptions) => Promise<Record<string, unknown>>;

/** Spawn PowerShell, feed the script on stdin, pass user input ONLY via the NEO_ARGS env var (JSON). */
export async function runPowerShell(
  script: string,
  input: unknown,
  opts: PsOptions = {},
): Promise<Record<string, unknown>> {
  const json = JSON.stringify(input ?? {});
  if (json.length > MAX_ARGS_JSON) {
    throw new PsError(`Arguments too large (${json.length} > ${MAX_ARGS_JSON} characters after JSON encoding).`);
  }
  const timeoutMs = opts.timeoutMs ?? 20000;
  if (opts.signal?.aborted) throw new PsError('Aborted.');

  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '-',
      ],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NEO_ARGS: json },
      },
    );

    const out: Buffer[] = [];
    let outSize = 0;
    let err = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const kill = (): void => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
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

    child.stdout.on('data', (b: Buffer) => {
      outSize += b.length;
      if (outSize > MAX_STDOUT) {
        kill();
        return;
      }
      out.push(b);
    });
    child.stderr.on('data', (b: Buffer) => {
      if (err.length < 8000) err += b.toString('utf8');
    });
    child.on('error', (e) => finish(() => reject(new PsError(`Could not start powershell.exe: ${e.message}`))));
    child.on('close', (code) => {
      finish(() => {
        if (timedOut) return reject(new PsError(`Timed out after ${timeoutMs} ms.`));
        if (aborted) return reject(new PsError('Aborted.'));
        try {
          resolve(parsePsOutput(Buffer.concat(out).toString('utf8'), err, code));
        } catch (e) {
          reject(e);
        }
      });
    });
    child.stdin.on('error', () => {
      /* process died early; 'close' reports the real reason */
    });
    child.stdin.end(script + '\n', 'utf8');
  });
}

/** Parse the single JSON line the scripts print. Exported for tests. */
export function parsePsOutput(stdout: string, stderr: string, code: number | null): Record<string, unknown> {
  const text = stdout.replace(/^﻿/, '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i] as string;
    if (l.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(l);
      } catch {
        continue;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const o = parsed as Record<string, unknown>;
        if (typeof o['neoError'] === 'string') throw new PsError(o['neoError']);
        return o;
      }
    }
  }
  const detail = (stderr.trim() || lines.slice(-3).join(' | ')).slice(0, 600);
  throw new PsError(`PowerShell produced no result (exit code ${code}). ${detail}`.trim());
}

/** Test seams: platform + runner can be overridden. */
export const hooks: { isWindows: () => boolean; run: PsRunner } = {
  isWindows: () => process.platform === 'win32',
  run: runPowerShell,
};
