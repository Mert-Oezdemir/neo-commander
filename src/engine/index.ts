import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { writeJsonAtomic } from '../config.js';

/**
 * Desktop Commander (DC) stores its config at `<os.homedir()>/.claude-server-commander/config.json`
 * and has no env var / flag to relocate it. Overriding HOME/USERPROFILE would also change the
 * home directory of every shell DC spawns for the user, so instead we preload a tiny module
 * (via `node --import data:...`, i.e. execArgv, NOT NODE_OPTIONS, so it is not inherited by
 * grandchildren) that makes `os.homedir()` return the isolated directory ONLY when the caller
 * is one of DC's own config/log modules (identified from the call stack). Everything else
 * (`~` expansion, spawned shells, HOME env) keeps seeing the real home.
 */
const PRELOAD_SOURCE = `
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const fake = process.env.NEO_DC_HOME;
if (fake) {
  const real = os.homedir.bind(os);
  const own = /desktop-commander[\\\\/]dist[\\\\/](config|utils[\\\\/]toolHistory|utils[\\\\/]fuzzySearchLogger)\\.js/;
  os.homedir = function homedir() {
    const stack = new Error().stack || '';
    return own.test(stack) ? fake : real();
  };
  syncBuiltinESMExports();
}
// Under Electron the child is the Electron binary in node mode (ELECTRON_RUN_AS_NODE=1).
// Do not leak that flag to shells/programs Desktop Commander launches for the user
// (an Electron app such as VS Code started from there would otherwise behave like plain node).
delete process.env.ELECTRON_RUN_AS_NODE;
`;

export const DC_CONFIG_OVERRIDES = {
  telemetryEnabled: false,
  fileWriteLineLimit: 1000,
  fileReadLineLimit: 2000,
  allowedDirectories: [] as string[],
  welcomeOnboardingEligible: false,
  pendingWelcomeOnboarding: false,
};

export function resolveDcEntry(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('@wonderwhy-er/desktop-commander/package.json');
  return unpackedPath(join(dirname(pkg), 'dist', 'index.js'));
}

/**
 * Packaged Electron app: files inside `app.asar` that were listed in `asarUnpack` also exist
 * on disk under `app.asar.unpacked`. A child process must be given the real path (it is not
 * necessarily asar-aware), so map it when that file exists.
 */
export function unpackedPath(p: string, exists: (f: string) => boolean = existsSync): string {
  const m = /^(.*[\\/]app)\.asar([\\/].*)$/.exec(p);
  if (!m) return p;
  const real = `${m[1]}.asar.unpacked${m[2]}`;
  return exists(real) ? real : p;
}

/** True when this process is the Electron main process (execPath is then the Electron binary, not node). */
export function runningUnderElectron(): boolean {
  return Boolean(process.versions.electron);
}

/** Environment for the Desktop Commander child. `electron` makes execPath behave as plain node. */
export function buildChildEnv(base: NodeJS.ProcessEnv, fakeHome: string, electron: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
  env.NEO_DC_HOME = fakeHome;
  if (electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

/** Writes/refreshes the isolated DC config. Returns the fake HOME dir. */
export function prepareDcHome(stateDir: string): string {
  const fakeHome = join(stateDir, 'dc-config');
  const cfgDir = join(fakeHome, '.claude-server-commander');
  mkdirSync(cfgDir, { recursive: true });
  const file = join(cfgDir, 'config.json');
  let existing: Record<string, unknown> = {};
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, 'utf8')); } catch { existing = {}; }
  }
  // blockedCommands deliberately left to DC defaults (or whatever DC itself has stored).
  writeJsonAtomic(file, { ...existing, ...DC_CONFIG_OVERRIDES });
  return fakeHome;
}

export type EngineState = 'starting' | 'ready' | 'error';
export interface EngineStatus { state: EngineState; toolCount: number; message?: string }
export interface EngineOptions {
  stateDir: string;
  /** Override DC entry (tests). */
  entry?: string;
  startupTimeoutMs?: number;
  /** Treat process.execPath as the Electron binary (default: auto-detect). Tests inject it. */
  electron?: boolean;
  backoffMinMs?: number;
  backoffMaxMs?: number;
}
export interface CallOptions { signal?: AbortSignal; timeoutMs?: number }

export class Engine extends EventEmitter {
  private client?: Client;
  private transport?: StdioClientTransport;
  private tools: Tool[] = [];
  private state: EngineState = 'starting';
  private message?: string;
  private stderrLines: string[] = [];
  private stopped = true;
  private backoff: number;
  private restartTimer?: NodeJS.Timeout;
  private startPromise?: Promise<void>;
  private readyWaiters: Array<() => void> = [];

  constructor(private opts: EngineOptions) {
    super();
    this.backoff = opts.backoffMinMs ?? 1000;
  }

  status(): EngineStatus {
    return { state: this.state, toolCount: this.tools.length, ...(this.message ? { message: this.message } : {}) };
  }
  stderrTail(): string[] { return [...this.stderrLines]; }

  private setState(state: EngineState, message?: string): void {
    this.state = state;
    this.message = message;
    this.emit('status', this.status());
  }

  /** Starts the child; resolves when ready (rejects on first failure but keeps retrying in background). */
  async start(): Promise<void> {
    this.stopped = false;
    return this.connect();
  }

  private connect(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.setState('starting');
    this.startPromise = this.doConnect().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  private async doConnect(): Promise<void> {
    const fakeHome = prepareDcHome(this.opts.stateDir);
    const entry = this.opts.entry ?? resolveDcEntry();
    const env = buildChildEnv(process.env, fakeHome, this.opts.electron ?? runningUnderElectron());
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'data:text/javascript,' + encodeURIComponent(PRELOAD_SOURCE), entry, '--no-onboarding'],
      env,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'neo-commander-engine', version: '0.1.0' }, { capabilities: {} });
    transport.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line) continue;
        this.stderrLines.push(line);
        if (this.stderrLines.length > 50) this.stderrLines.shift();
      }
    });
    transport.onclose = () => this.handleClosed(transport);
    transport.onerror = (e) => { this.message = e.message; };
    try {
      const timeout = this.opts.startupTimeoutMs ?? 60_000;
      await client.connect(transport, { timeout });
      const listed = await client.listTools(undefined, { timeout });
      this.tools = listed.tools;
      this.client = client;
      this.transport = transport;
      this.backoff = this.opts.backoffMinMs ?? 1000;
      this.setState('ready');
      for (const w of this.readyWaiters.splice(0)) w();
      this.emit('tools', this.tools);
    } catch (e) {
      try { await client.close(); } catch { /* ignore */ }
      const msg = `Desktop Commander başlatılamadı: ${(e as Error).message}${this.stderrLines.length ? ' | ' + this.stderrLines.slice(-3).join(' / ') : ''}`;
      this.setState('error', msg);
      this.scheduleRestart();
      throw new Error(msg);
    }
  }

  private handleClosed(t: StdioClientTransport): void {
    if (t !== this.transport) return;
    this.transport = undefined;
    this.client = undefined;
    if (this.stopped) return;
    this.setState('error', 'Desktop Commander süreci kapandı; yeniden başlatılıyor');
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.backoffMaxMs ?? 30_000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stopped) return;
      this.connect().catch(() => { /* retry scheduled in doConnect */ });
    }, delay);
    this.restartTimer.unref?.();
  }

  /** PID of the child (tests). */
  get pid(): number | null { return this.transport?.pid ?? null; }

  waitReady(timeoutMs = 60_000): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('engine ready timeout')), timeoutMs);
      this.readyWaiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  listTools(): Tool[] { return this.tools; }

  async callTool(name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<CallToolResult> {
    const client = this.client;
    if (!client || this.state !== 'ready') throw new Error('Motor hazır değil (Desktop Commander yeniden başlatılıyor)');
    const timeout = opts.timeoutMs ?? 120_000;
    const res = await client.callTool({ name, arguments: args }, undefined, {
      signal: opts.signal,
      timeout,
      resetTimeoutOnProgress: true,
    });
    return res as CallToolResult;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (client) { try { await client.close(); } catch { /* ignore */ } }
    this.tools = [];
    this.setState('error', 'durduruldu');
  }
}
