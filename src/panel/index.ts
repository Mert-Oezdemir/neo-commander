import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import type { Mode, Secrets, Settings, TunnelKind } from '../config.js';
import type { TunnelManager } from '../tunnel/index.js';
import { normalizeUrl } from '../tunnel/index.js';
import { setAutostart } from './autostart.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export interface PanelDeps {
  getSettings(): Settings;
  updateSettings(patch: Partial<Settings>): Settings;
  getSecrets(): Secrets;
  regeneratePin(): Secrets;
  tunnel: TunnelManager;
  auth: {
    listClients(): { clientId: string; clientName: string; createdAt: number; lastUsedAt?: number }[];
    revokeClient(id: string): void;
    revokeAll(): void;
    clearPinLockout(): void;
    isPinLocked(): boolean;
  };
  audit: EventEmitter & { recent(limit?: number): any[] };
  engineStatus(): { state: 'starting' | 'ready' | 'error'; toolCount: number; message?: string };
  version: string;
  /** Test hooks. */
  panelDir?: string;
  appDir?: string;
  setAutostart?: typeof setAutostart;
}

const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'tailscale-user-login', 'tailscale-funnel-request', 'via'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True only for a direct local connection: loopback peer, no proxy headers, Host is loopback:<port>. */
export function isDirectLoopback(req: Request): boolean {
  const addr = req.socket.remoteAddress;
  if (!addr || !LOOPBACK.has(addr)) return false;
  for (const h of PROXY_HEADERS) if (req.headers[h] !== undefined) return false;
  const host = req.headers.host;
  const port = req.socket.localPort;
  if (!host || port === undefined) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

const MODES: Mode[] = ['full', 'standard', 'readonly'];
const KINDS: TunnelKind[] = ['none', 'cloudflare-quick', 'cloudflare-named', 'tailscale', 'manual'];

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createPanelRouter(deps: PanelDeps): Router {
  const router = express.Router();
  const csrf = randomBytes(24).toString('base64url');
  const panelDir = deps.panelDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'panel');
  const appDir = deps.appDir ?? resolve(panelDir, '..');
  const doAutostart = deps.setAutostart ?? setAutostart;

  // 1. Gatekeeper: everything under the panel is invisible unless direct loopback.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!isDirectLoopback(req)) { res.status(404).type('text/plain').send('Not Found'); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    next();
  });

  // 2. Static UI
  const files: Record<string, [string, string]> = {
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
  };
  router.get(['/', '/index.html'], (_req, res) => {
    try {
      const html = readFileSync(join(panelDir, 'index.html'), 'utf8').replace('__CSRF_TOKEN__', csrf).replace('__VERSION__', deps.version.replace(/[^0-9A-Za-z._-]/g, ''));
      res.type('text/html; charset=utf-8').send(html);
    } catch { res.status(500).type('text/plain').send('Panel dosyaları bulunamadı.'); }
  });
  router.get(Object.keys(files), (req, res) => {
    const [name, type] = files[req.path]!;
    try { res.type(type).send(readFileSync(join(panelDir, name))); } catch { res.status(404).end(); }
  });

  // 3. API guards
  const api = express.Router();
  api.use((req: Request, res: Response, next: NextFunction) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') { res.status(403).json({ error: 'cross-site' }); return; }
    if (req.method === 'POST') {
      const tok = req.headers['x-neo-csrf'];
      if (typeof tok !== 'string' || !safeEq(tok, csrf)) { res.status(403).json({ error: 'csrf' }); return; }
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) { res.status(403).json({ error: 'origin' }); return; }
    }
    next();
  });
  api.use(express.json({ limit: '32kb' }));

  const snapshot = () => {
    const s = deps.getSettings();
    const t = deps.tunnel.status();
    const url = t.publicUrl;
    return {
      version: deps.version,
      engine: deps.engineStatus(),
      tunnel: t,
      connectorUrl: url ? `${url}/mcp` : null,
      pin: deps.getSecrets().ownerPin,
      pinLocked: deps.auth.isPinLocked(),
      mode: s.mode,
      paused: s.paused,
      allowedDirectories: s.allowedDirectories,
      autostart: s.autostart,
      port: s.port,
      tunnelSettings: { kind: s.tunnel.kind, publicUrl: s.tunnel.publicUrl ?? '', hasToken: Boolean(s.tunnel.cloudflareToken) },
      clients: deps.auth.listClients(),
    };
  };

  api.get('/state', (_req, res) => { res.json({ ...snapshot(), recent: deps.audit.recent(40) }); });

  api.post('/settings', async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const cur = deps.getSettings();
    const patch: Partial<Settings> = {};
    let tunnelChanged = false;
    let note: string | undefined;

    if (b.mode !== undefined) {
      if (typeof b.mode !== 'string' || !MODES.includes(b.mode as Mode)) { res.status(400).json({ error: 'mode' }); return; }
      patch.mode = b.mode as Mode;
    }
    if (b.paused !== undefined) {
      if (typeof b.paused !== 'boolean') { res.status(400).json({ error: 'paused' }); return; }
      patch.paused = b.paused;
    }
    if (b.addDirectory !== undefined || b.removeDirectory !== undefined) {
      let dirs = [...cur.allowedDirectories];
      if (b.removeDirectory !== undefined) {
        if (typeof b.removeDirectory !== 'string') { res.status(400).json({ error: 'removeDirectory' }); return; }
        dirs = dirs.filter((d) => d !== b.removeDirectory);
      }
      if (b.addDirectory !== undefined) {
        const d = b.addDirectory;
        if (typeof d !== 'string' || !d.trim() || d.length > 500 || /[\0\r\n]/.test(d)) { res.status(400).json({ error: 'addDirectory' }); return; }
        const t = d.trim();
        if (!/^([a-zA-Z]:[\\/]|\\\\|\/|~)/.test(t)) { res.status(400).json({ error: 'Tam yol girin (örn. C:\\Users\\Ad\\Belgeler).' }); return; }
        if (!dirs.includes(t)) dirs.push(t);
      }
      patch.allowedDirectories = dirs;
    }
    if (b.autostart !== undefined) {
      if (typeof b.autostart !== 'boolean') { res.status(400).json({ error: 'autostart' }); return; }
      const r = doAutostart(b.autostart, appDir);
      note = r.message;
      if (!r.ok) { res.status(400).json({ error: r.message }); return; }
      patch.autostart = b.autostart;
    }
    if (b.tunnel !== undefined) {
      const t = b.tunnel as Record<string, unknown> | null;
      if (!t || typeof t !== 'object') { res.status(400).json({ error: 'tunnel' }); return; }
      const next = { ...cur.tunnel };
      if (t.kind !== undefined) {
        if (typeof t.kind !== 'string' || !KINDS.includes(t.kind as TunnelKind)) { res.status(400).json({ error: 'tunnel.kind' }); return; }
        next.kind = t.kind as TunnelKind;
      }
      if (t.publicUrl !== undefined) {
        if (t.publicUrl === '' || t.publicUrl === null) delete next.publicUrl;
        else {
          const u = typeof t.publicUrl === 'string' ? normalizeUrl(t.publicUrl) : undefined;
          if (!u) { res.status(400).json({ error: 'Adres https:// ile başlamalı.' }); return; }
          next.publicUrl = u;
        }
      }
      if (t.cloudflareToken !== undefined) {
        if (t.cloudflareToken === '' || t.cloudflareToken === null) delete next.cloudflareToken;
        else if (typeof t.cloudflareToken === 'string' && t.cloudflareToken.length <= 4096 && /^[A-Za-z0-9_\-=+/.]+$/.test(t.cloudflareToken.trim())) next.cloudflareToken = t.cloudflareToken.trim();
        else { res.status(400).json({ error: 'Token geçersiz.' }); return; }
      }
      patch.tunnel = next;
      tunnelChanged = JSON.stringify(next) !== JSON.stringify(cur.tunnel);
    }

    deps.updateSettings(patch);
    if (tunnelChanged) void deps.tunnel.start().catch(() => undefined);
    res.json({ ok: true, note, ...snapshot() });
  });

  api.post('/pin/regenerate', (_req, res) => {
    const s = deps.regeneratePin();
    res.json({ ok: true, pin: s.ownerPin });
  });
  // Owner-side escape hatch for the global PIN-failure cap (same loopback + CSRF guards as every POST here).
  api.post('/pin/unlock', (_req, res) => { deps.auth.clearPinLockout(); res.json({ ok: true, pinLocked: deps.auth.isPinLocked() }); });
  api.post('/clients/revoke-all', (_req, res) => { deps.auth.revokeAll(); res.json({ ok: true, clients: deps.auth.listClients() }); });
  api.post('/clients/:id/revoke', (req, res) => { deps.auth.revokeClient(String(req.params.id)); res.json({ ok: true, clients: deps.auth.listClients() }); });
  api.post('/tunnel/restart', (_req, res) => { void deps.tunnel.start().catch(() => undefined); res.json({ ok: true }); });

  api.get('/events', (req: Request, res: Response) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    send('hello', { ok: true });
    const onEntry = (e: unknown): void => send('audit', e);
    const onStatus = (): void => send('status', { tunnel: deps.tunnel.status(), engine: deps.engineStatus(), connectorUrl: deps.tunnel.publicUrl() ? `${deps.tunnel.publicUrl()}/mcp` : null });
    deps.audit.on('entry', onEntry);
    deps.tunnel.on('status', onStatus);
    const hb = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    hb.unref();
    req.on('close', () => { clearInterval(hb); deps.audit.off('entry', onEntry); deps.tunnel.off('status', onStatus); });
  });

  api.use((_req, res) => { res.status(404).json({ error: 'not found' }); });
  router.use('/api', api);
  router.use((_req, res) => { res.status(404).type('text/plain').send('Not Found'); });
  return router;
}
