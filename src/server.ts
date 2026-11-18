import { createServer, type Server as HttpServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import express, { type Express, type RequestHandler, type Router } from 'express';
import {
  generatePin, loadSecrets, loadSettings, saveSecrets, saveSettings, stateDir as defaultStateDir,
  type Secrets, type Settings,
} from './config.js';
import type { ToolDef } from './tools/types.js';
import { Engine } from './engine/index.js';
import { ToolRouter, type AuditLike, type PolicyLike, type RateLimiterLike } from './mcp/router.js';
import { SessionManager } from './mcp/sessions.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Application root (contains package.json): src/ or dist/ is one level below. */
export const APP_DIR = join(here, '..');

export function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Structural views of sibling modules (real ones are loaded lazily; tests inject fakes).
export interface AuthLike {
  router: RequestHandler;
  requireAuth: RequestHandler;
  listClients(): { clientId: string; clientName: string; createdAt: number; lastUsedAt?: number }[];
  revokeClient(id: string): void;
  revokeAll(): void;
  onPublicUrlChanged(): void;
}
export interface TunnelLike extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): { kind: string; state: 'off' | 'starting' | 'online' | 'error'; publicUrl?: string; message?: string; stable: boolean };
  publicUrl(): string | undefined;
}
export interface AuditFull extends AuditLike, EventEmitter { recent(limit?: number): any[] }

export interface Overrides {
  auth?: (args: { stateDir: string; secrets: Secrets; getPublicUrl(): string | undefined; port: number }) => AuthLike;
  policy?: (getSettings: () => Settings, protectedPaths: string[]) => PolicyLike;
  limiter?: (getPerMinute: () => number) => RateLimiterLike;
  audit?: (stateDir: string) => AuditFull;
  ownTools?: ToolDef[];
  tunnel?: (args: { stateDir: string; port: number; getSettings: () => Settings }) => TunnelLike;
  panelRouter?: (deps: any) => Router;
  isDirectLoopback?: (req: express.Request) => boolean;
  setAutostart?: (enabled: boolean, appDir: string) => { ok: boolean; message: string };
  engine?: Engine;
}

export interface StartOptions {
  stateDir?: string;
  /** Overrides settings.port (0 = ephemeral; tests). */
  port?: number;
  openBrowser?: boolean;
  installSignalHandlers?: boolean;
  quiet?: boolean;
  /** Extra own tools next to desktopTools(). */
  extraTools?: ToolDef[];
  overrides?: Overrides;
}

export interface RunningServer {
  port: number;
  app: Express;
  http: HttpServer;
  engine: Engine;
  sessions: SessionManager;
  router: ToolRouter;
  tunnel: TunnelLike;
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  close(): Promise<void>;
}

export class PortInUseError extends Error {
  constructor(public port: number, public otherNeoCommander: boolean) {
    super(`Port ${port} kullanımda`);
  }
}

export function openUrl(url: string): void {
  try {
    const [cmd, args]: [string, string[]] =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => { /* ignore */ });
    child.unref();
  } catch { /* ignore */ }
}

export async function probeHealthz(port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    const j = (await r.json()) as { ok?: boolean };
    return r.ok && j.ok === true;
  } catch {
    return false;
  }
}

/** Merge a settings patch (tunnel is merged one level deep). */
function mergeSettings(cur: Settings, patch: Partial<Settings>): Settings {
  const next: Settings = { ...cur, ...patch, tunnel: { ...cur.tunnel, ...(patch.tunnel ?? {}) } };
  return next;
}

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const ov = opts.overrides ?? {};
  const dir = opts.stateDir ?? defaultStateDir();
  const secrets = loadSecrets(dir);
  let settings = loadSettings(dir);
  const getSettings = () => settings;
  const requestedPort = opts.port ?? settings.port;
  const log = (...a: unknown[]) => { if (!opts.quiet) console.log(...a); };
  const version = readVersion();

  // ---- modules (real ones loaded lazily so fakes can replace them) ----
  const policyMod = ov.policy && ov.limiter && ov.audit ? undefined : await import('./policy/index.js');
  const protectedPaths = [dir];
  const policy: PolicyLike = ov.policy ? ov.policy(getSettings, protectedPaths) : new policyMod!.PolicyEngine(getSettings, protectedPaths);
  const limiter: RateLimiterLike = ov.limiter ? ov.limiter(() => settings.rateLimitPerMinute) : new policyMod!.RateLimiter(() => settings.rateLimitPerMinute);
  const audit: AuditFull = ov.audit ? ov.audit(dir) : (new policyMod!.AuditLog(dir) as unknown as AuditFull);

  let tunnelRef: TunnelLike | undefined;
  const portRef = { value: requestedPort };
  // Actual bound port (differs from requestedPort when 0 = ephemeral); set after listen.
  let actualPort = requestedPort;
  const localOrPublicUrl = (): string | undefined => tunnelRef?.publicUrl() ?? (actualPort ? `http://127.0.0.1:${actualPort}` : undefined);
  const auth: AuthLike = ov.auth
    ? ov.auth({ stateDir: dir, secrets, getPublicUrl: localOrPublicUrl, port: requestedPort })
    : (await import('./auth/index.js')).createAuth({ stateDir: dir, secrets, getPublicUrl: localOrPublicUrl, port: requestedPort }) as AuthLike;

  const tunnel: TunnelLike = ov.tunnel
    ? ov.tunnel({ stateDir: dir, port: requestedPort, getSettings })
    : new (await import('./tunnel/index.js')).TunnelManager({ stateDir: dir, port: requestedPort, getSettings }) as unknown as TunnelLike;
  tunnelRef = tunnel;
  tunnel.on('url', () => { try { auth.onPublicUrlChanged(); } catch { /* ignore */ } });

  const ownTools: ToolDef[] = [
    ...(ov.ownTools ?? (await import('./desktop/index.js')).desktopTools()),
    ...(opts.extraTools ?? []),
  ];

  const engine = ov.engine ?? new Engine({ stateDir: dir });
  try {
    await engine.start();
  } catch (e) {
    console.error('[engine]', (e as Error).message, '(arka planda yeniden denenecek)');
  }

  const router = new ToolRouter({
    engine, policy, limiter, audit, ownTools,
    getAllowedDirectories: () => settings.allowedDirectories,
    stateDir: dir,
  });
  const sessions = new SessionManager({ router, version });
  engine.on('tools', () => sessions.notifyToolsChanged());

  // ---- settings plumbing ----
  const doSetAutostart = ov.setAutostart ?? (await import('./panel/autostart.js')).setAutostart;
  const updateSettings = (patch: Partial<Settings>): Settings => {
    const prev = settings;
    const next = mergeSettings(prev, patch);
    settings = next;
    saveSettings(next, dir);
    const visibilityChanged =
      prev.mode !== next.mode || prev.paused !== next.paused ||
      JSON.stringify(prev.blockedTools) !== JSON.stringify(next.blockedTools);
    if (visibilityChanged) sessions.notifyToolsChanged();
    // Side effects of autostart / tunnel changes are applied by the panel router
    // (it calls setAutostart and tunnel.start() itself); this function only persists.
    return next;
  };
  const regeneratePin = (): Secrets => {
    secrets.ownerPin = generatePin();
    saveSecrets(secrets, dir);
    return secrets;
  };

  // ---- express ----
  const app = express();
  app.set('trust proxy', false);
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => { res.json({ ok: true }); });

  const isLoopback = ov.isDirectLoopback ?? (await import('./panel/index.js')).isDirectLoopback;
  app.get('/', (req, res) => {
    if (isLoopback(req)) res.redirect('/panel');
    else res.status(404).end();
  });

  app.use(auth.router);

  const panelFactory = ov.panelRouter ?? (await import('./panel/index.js')).createPanelRouter;
  app.use('/panel', panelFactory({
    getSettings, updateSettings,
    getSecrets: () => secrets, regeneratePin,
    tunnel: tunnel as any, auth, audit,
    engineStatus: () => engine.status(),
    version,
    appDir: APP_DIR,
    setAutostart: doSetAutostart,
  }));

  app.use('/mcp', auth.requireAuth, express.json({ limit: '4mb' }));
  app.all('/mcp', sessions.handle);

  app.use(((err, _req, res, _next) => {
    if (res.headersSent) return;
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ jsonrpc: '2.0', error: { code: status === 400 ? -32700 : -32603, message: status === 400 ? 'Bad request' : 'Internal error' }, id: null });
  }) as express.ErrorRequestHandler);

  // ---- listen (127.0.0.1 only) ----
  const http = createServer(app);
  await new Promise<void>((resolve, reject) => {
    http.once('error', async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        const other = await probeHealthz(requestedPort);
        reject(new PortInUseError(requestedPort, other));
      } else reject(err);
    });
    http.listen(requestedPort, '127.0.0.1', () => resolve());
  }).catch(async (e) => {
    await engine.stop().catch(() => {});
    await sessions.closeAll().catch(() => {});
    throw e;
  });
  const port = (http.address() as { port: number }).port;
  portRef.value = port;
  actualPort = port;
  auth.onPublicUrlChanged();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await tunnel.stop().catch(() => {});
    await sessions.closeAll().catch(() => {});
    await engine.stop().catch(() => {});
    http.closeAllConnections?.();
    await new Promise<void>((r) => http.close(() => r()));
  };

  if (opts.installSignalHandlers) {
    const onSignal = () => { log('\nKapatılıyor...'); close().finally(() => process.exit(0)); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  // ---- tunnel + banner ----
  const panelUrl = `http://127.0.0.1:${port}/panel`;
  const printBanner = () => {
    log('');
    log('  Neo Commander hazır');
    log(`  Kontrol paneli : ${panelUrl}`);
    const pub = tunnel.publicUrl();
    if (pub) log(`  Claude.ai bağlayıcı adresi : ${pub.replace(/\/+$/, '')}/mcp`);
    log('');
  };
  printBanner();
  let announced = false;
  tunnel.on('url', (u?: string) => {
    if (!announced && (u ?? tunnel.publicUrl())) { announced = true; printBanner(); }
  });
  tunnel.start().catch((e) => console.error('[tünel]', (e as Error).message));

  if (opts.openBrowser && process.env.NEO_NO_BROWSER !== '1') openUrl(panelUrl);

  return { port, app, http, engine, sessions, router, tunnel, getSettings, updateSettings, close };
}

/** Called by index.ts: friendly handling when the port is already taken. Returns exit code. */
export async function handlePortInUse(e: PortInUseError): Promise<number> {
  if (e.otherNeoCommander) {
    const url = `http://127.0.0.1:${e.port}/panel`;
    console.log(`Neo Commander zaten çalışıyor. Panel açılıyor: ${url}`);
    if (process.env.NEO_NO_BROWSER !== '1') openUrl(url);
    return 0;
  }
  console.error(`Hata: ${e.port} numaralı port başka bir program tarafından kullanılıyor.`);
  console.error('Çözüm: o programı kapatın ya da panelden/settings.json içinden farklı bir port seçin.');
  return 1;
}
