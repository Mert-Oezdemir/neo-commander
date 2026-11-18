import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const WINDOWS_ONLY = "Bu araç yalnızca Windows ve macOS'ta çalışır / Windows and macOS only";

export class PsError extends Error {}

export interface PsOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Max size of the JSON arguments blob (a single Windows environment variable is limited to 32767 chars). */
export const MAX_ARGS_JSON = 30000;
const MAX_STDOUT = 96 * 1024 * 1024;

export type PsRunner = (script: string, input: unknown, opts?: PsOptions) => Promise<Record<string, unknown>>;

/**
 * Run a PowerShell script from a private temp .ps1 file (`-File`); user input travels ONLY via the
 * NEO_ARGS env var (JSON). `-Command -` (stdin) is not usable: PowerShell 5.1 parses stdin line by
 * line, which breaks multi-line blocks and C# here-strings.
 */
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

  // Unpredictable name + exclusive create; UTF-8 BOM so PS 5.1 never misreads the encoding.
  const scriptPath = join(tmpdir(), `neo-ps-${randomBytes(12).toString('hex')}.ps1`);
  writeFileSync(scriptPath, '\ufeff' + script + '\r\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const cleanup = (): void => {
    try { unlinkSync(scriptPath); } catch { /* already gone */ }
  };

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
        '-File',
        scriptPath,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
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
      cleanup();
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
export const hooks: { isWindows: () => boolean; isMac: () => boolean; run: PsRunner } = {
  isWindows: () => process.platform === 'win32',
  isMac: () => process.platform === 'darwin',
  run: runPowerShell,
};
