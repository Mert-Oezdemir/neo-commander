import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import express from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { readJson, saveSecrets, writeJsonAtomic } from '../config.js';
import type { Secrets } from '../config.js';
import { deriveKey, signBlob, signJwt, verifyBlob, verifyJwt } from './jwt.js';
import { esc, renderConsent } from './consent.js';

export interface AuthOptions {
  stateDir: string;
  /**
   * Mutable holder shared with the server (single source of truth). The signing key is ALWAYS read from
   * `secrets.signingKey` at use time, because revokeAll() rotates it in place.
   */
  secrets: Secrets;
  getPublicUrl(): string | undefined;
  port: number;
}
export interface ClientSummary { clientId: string; clientName: string; createdAt: number; lastUsedAt?: number; }
export interface Auth {
  router: express.RequestHandler;
  requireAuth: express.RequestHandler;
  listClients(): ClientSummary[];
  revokeClient(clientId: string): void;
  /** Bumps the generation, drops refresh tokens AND rotates the signing key (persisted). */
  revokeAll(): void;
  /** Forget the in-memory global PIN-failure counter (panel "unlock" button). */
  clearPinLockout(): void;
  isPinLocked(): boolean;
  onPublicUrlChanged(): void;
}

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const PIN_WINDOW_MS = 10 * 60 * 1000;
/** Wrong PINs allowed per pending consent request; then that request is dead (start again from Claude). */
const PIN_MAX_FAILS_PER_PENDING = 5;
/** Global in-memory safety cap (never persisted, so a restart/panel unlock frees the owner). PIN is ~2^80 anyway. */
const PIN_MAX_FAILS_GLOBAL = 30;
/** Tolerated clock skew when validating iat / exp - iat of access tokens. */
const TOKEN_SKEW_S = 60;
const MAX_CLIENTS = 50;
const SCOPE = 'mcp';

const ALLOWED_HOSTS = ['claude.ai', 'claude.com', 'chatgpt.com', 'chat.openai.com'];
const SUBDOMAIN_HOSTS = ['claude.ai', 'claude.com'];
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

interface StoredClient { info: OAuthClientInformationFull; createdAt: number; lastUsedAt?: number; }
interface RefreshRecord { clientId: string; resource: string; scope: string; gen: number; expiresAt: number; }
interface OAuthState {
  generation: number;
  clients: Record<string, StoredClient>;
  refresh: Record<string, RefreshRecord>;
  revokedJti: Record<string, number>;
}
interface CodeRecord {
  clientId: string; redirectUri: string; challenge: string; resource: string; scope: string; gen: number; expiresAt: number;
}
interface Pending {
  cid: string; ru: string; cc: string; st?: string; sc: string; rs: string; exp: number; n: string;
}

const sha256b64 = (s: string): string => createHash('sha256').update(s).digest('base64url');
const sha256buf = (s: string): Buffer => createHash('sha256').update(s).digest();
const stripSlash = (s: string): string => s.replace(/\/+$/, '');

export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try { u = new URL(uri); } catch { return false; }
  if (u.username || u.password || u.hash) return false;
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'http:') return LOOPBACK.has(host);
  if (u.protocol !== 'https:') return false;
  if (ALLOWED_HOSTS.includes(host)) return true;
  return SUBDOMAIN_HOSTS.some((d) => host.endsWith(`.${d}`));
}

function normalizePin(p: string): string {
  return p.toUpperCase().replace(/[\s-]+/g, '');
}

export function createAuth(opts: AuthOptions): Auth {
  const file = join(opts.stateDir, 'oauth.json');
  const loaded = readJson<Partial<OAuthState>>(file) ?? {};
  const state: OAuthState = {
    generation: typeof loaded.generation === 'number' ? loaded.generation : 1,
    clients: loaded.clients ?? {},
    refresh: loaded.refresh ?? {},
    revokedJti: loaded.revokedJti ?? {},
  };
  const codes = new Map<string, CodeRecord>();
  const usedPending = new Map<string, number>();
  // Derived on use: the signing key rotates in revokeAll(), which also invalidates open consent pages.
  const consentKey = (): string => deriveKey(opts.secrets.signingKey, 'neo-commander/consent/v1');
  // PIN brute-force limits are memory-only by design (see PIN_MAX_FAILS_*).
  let globalPinFailures: number[] = [];
  const pendingFailures = new Map<string, { count: number; exp: number }>();
  let lastUsedSave = 0;

  const save = (): void => {
    const now = Date.now();
    for (const [h, r] of Object.entries(state.refresh)) if (r.expiresAt < now) delete state.refresh[h];
    for (const [j, exp] of Object.entries(state.revokedJti)) if (exp * 1000 < now) delete state.revokedJti[j];
    writeJsonAtomic(file, state);
  };
  if (!loaded.generation) save();

  // ---- URLs -------------------------------------------------------------
  const baseUrl = (): string => stripSlash(opts.getPublicUrl()?.trim() || `http://127.0.0.1:${opts.port}`);
  const resourceUrl = (): string => `${baseUrl()}/mcp`;
  const sameResource = (a: string, b: string): boolean => stripSlash(a.split('#')[0]!) === stripSlash(b.split('#')[0]!);

  // ---- clients store ----------------------------------------------------
  const clientsStore: OAuthRegisteredClientsStore = {
    getClient(id) { return state.clients[id]?.info; },
    registerClient(meta) {
      const uris = meta.redirect_uris.map(String);
      if (uris.length === 0 || uris.length > 10) throw new InvalidClientMetadataError('redirect_uris must contain 1-10 entries');
      for (const u of uris) {
        if (!isAllowedRedirectUri(u)) throw new InvalidClientMetadataError(`redirect_uri not allowed: ${u.slice(0, 200)}`);
      }
      const method = meta.token_endpoint_auth_method;
      if (method !== undefined && method !== 'none' && method !== 'client_secret_post') {
        throw new InvalidClientMetadataError('unsupported token_endpoint_auth_method');
      }
      const full = {
        ...meta,
        redirect_uris: uris,
        client_name: (meta.client_name ?? '').slice(0, 100),
        client_id: randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
      } as unknown as OAuthClientInformationFull;
      const ids = Object.keys(state.clients);
      if (ids.length >= MAX_CLIENTS) {
        // drop oldest unused first, then least recently used
        const victim = ids
          .map((id) => state.clients[id]!)
          .sort((a, b) => Number(a.lastUsedAt !== undefined) - Number(b.lastUsedAt !== undefined) || (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt))[0]!;
        dropClient(victim.info.client_id);
      }
      state.clients[full.client_id] = { info: full, createdAt: Date.now() };
      save();
      return full;
    },
  };

  function dropClient(id: string): void {
    delete state.clients[id];
    for (const [h, r] of Object.entries(state.refresh)) if (r.clientId === id) delete state.refresh[h];
    for (const [c, r] of codes) if (r.clientId === id) codes.delete(c);
  }
  const clientName = (c: OAuthClientInformationFull): string => c.client_name?.trim() || 'Bilinmeyen istemci';

  // ---- tokens -----------------------------------------------------------
  function issueTokens(clientId: string, resource: string, scope: string): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const access = signJwt({
      iss: baseUrl(), aud: resource, sub: 'owner', client_id: clientId, scope,
      iat: now, exp: now + ACCESS_TTL_S, jti: randomUUID(), gen: state.generation,
    }, opts.secrets.signingKey);
    const refresh = randomBytes(32).toString('base64url');
    state.refresh[sha256b64(refresh)] = {
      clientId, resource, scope, gen: state.generation, expiresAt: Date.now() + REFRESH_TTL_MS,
    };
    const sc = state.clients[clientId];
    if (sc) sc.lastUsedAt = Date.now();
    save();
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
  }

  const pickScope = (requested: string[] | undefined): string => {
    const req = (requested ?? []).filter(Boolean);
    if (req.some((s) => s !== SCOPE)) throw new InvalidScopeError(`only scope "${SCOPE}" is supported`);
    return SCOPE;
  };

  // ---- PIN / lockout ----------------------------------------------------
  const pruneFailures = (): void => {
    const cutoff = Date.now() - PIN_WINDOW_MS;
    globalPinFailures = globalPinFailures.filter((t) => t > cutoff);
    for (const [n, f] of pendingFailures) if (f.exp < Date.now()) pendingFailures.delete(n);
  };
  const isLocked = (): boolean => { pruneFailures(); return globalPinFailures.length >= PIN_MAX_FAILS_GLOBAL; };
  const checkPin = (input: string): boolean => {
    const a = sha256buf(normalizePin(input));
    const b = sha256buf(normalizePin(opts.secrets.ownerPin));
    return timingSafeEqual(a, b);
  };

  // ---- consent page -----------------------------------------------------
  function sendHtml(res: Response, status: number, nonce: string, redirectOrigin: string | undefined, html: string): void {
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Chrome applies form-action to the redirect that follows a form POST, so the client's origin must be listed.
    const formAction = ["'self'", redirectOrigin].filter(Boolean).join(' ');
    res.setHeader('Content-Security-Policy',
      `default-src 'none'; style-src 'nonce-${nonce}'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`);
    res.send(html);
  }

  function renderPage(res: Response, client: OAuthClientInformationFull, p: Pending, pendingToken: string, error?: string, status = 200): void {
    const nonce = randomBytes(16).toString('base64url');
    let host = p.ru;
    let origin: string | undefined;
    try { const u = new URL(p.ru); host = u.host; origin = u.origin; } catch { /* keep raw */ }
    const locked = isLocked();
    sendHtml(res, locked ? 429 : status, nonce, origin, renderConsent({
      clientName: clientName(client), redirectHost: host, pending: pendingToken, nonce, scope: p.sc,
      locked,
      error: locked ? 'Çok fazla hatalı PIN denemesi. Güvenlik için bir süre yeni deneme kabul edilmiyor (Neo Commander panelinden kilit açılabilir).' : error,
    }));
  }

  // ---- provider ---------------------------------------------------------
  const provider: OAuthServerProvider = {
    clientsStore,
    skipLocalPkceValidation: true, // we validate PKCE ourselves so the code is burned on a failed attempt

    async authorize(client, params: AuthorizationParams, res) {
      const resource = params.resource ? params.resource.href : resourceUrl();
      if (!sameResource(resource, resourceUrl())) throw new InvalidTargetError('resource does not match this server');
      const scope = pickScope(params.scopes);
      const p: Pending = {
        cid: client.client_id, ru: params.redirectUri, cc: params.codeChallenge, st: params.state, sc: scope,
        rs: resourceUrl(), exp: Date.now() + PENDING_TTL_MS, n: randomBytes(12).toString('base64url'),
      };
      renderPage(res, client, p, signBlob(p, consentKey()));
    },

    async challengeForAuthorizationCode(_client, code) {
      const rec = codes.get(code);
      if (!rec) throw new InvalidGrantError('invalid authorization code');
      return rec.challenge;
    },

    async exchangeAuthorizationCode(client, code, verifier, redirectUri, resource) {
      const rec = codes.get(code);
      codes.delete(code); // single use, even on failure
      if (!rec || rec.expiresAt < Date.now()) throw new InvalidGrantError('invalid or expired authorization code');
      if (rec.clientId !== client.client_id) throw new InvalidGrantError('code was issued to another client');
      if (redirectUri !== undefined && redirectUri !== rec.redirectUri) throw new InvalidGrantError('redirect_uri mismatch');
      if (resource && !sameResource(resource.href, rec.resource)) throw new InvalidTargetError('resource mismatch');
      if (!sameResource(rec.resource, resourceUrl()) || rec.gen !== state.generation) throw new InvalidGrantError('authorization code is no longer valid');
      if (!verifier || verifier.length < 43 || verifier.length > 128) throw new InvalidGrantError('invalid code_verifier');
      const a = Buffer.from(sha256b64(verifier));
      const b = Buffer.from(rec.challenge);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new InvalidGrantError('code_verifier does not match the challenge');
      return issueTokens(client.client_id, rec.resource, rec.scope);
    },

    async exchangeRefreshToken(client, refreshToken, scopes, resource) {
      const h = sha256b64(refreshToken);
      const rec = state.refresh[h];
      if (!rec) throw new InvalidGrantError('invalid refresh token');
      delete state.refresh[h]; // rotation: old token is dead whatever happens next
      save();
      if (rec.clientId !== client.client_id) throw new InvalidGrantError('refresh token was issued to another client');
      if (rec.expiresAt < Date.now() || rec.gen !== state.generation) throw new InvalidGrantError('refresh token expired');
      if (resource && !sameResource(resource.href, rec.resource)) throw new InvalidTargetError('resource mismatch');
      if (!sameResource(rec.resource, resourceUrl())) throw new InvalidGrantError('refresh token was issued for a different server URL');
      if (scopes && scopes.some((s) => s && s !== rec.scope)) throw new InvalidScopeError('cannot widen scope');
      return issueTokens(client.client_id, rec.resource, rec.scope);
    },

    async verifyAccessToken(token): Promise<AuthInfo> {
      const c = verifyJwt(token, opts.secrets.signingKey);
      if (!c) throw new InvalidTokenError('Invalid token');
      if (c.exp * 1000 <= Date.now()) throw new InvalidTokenError('Token has expired');
      // Defence in depth against forged long-lived tokens (e.g. exp = +10 years): we only ever issue ACCESS_TTL_S tokens.
      if (c.exp - c.iat > ACCESS_TTL_S + TOKEN_SKEW_S) throw new InvalidTokenError('Token lifetime is too long');
      if (c.iat > Date.now() / 1000 + TOKEN_SKEW_S) throw new InvalidTokenError('Token issued in the future');
      if (c.gen !== state.generation) throw new InvalidTokenError('Token has been revoked');
      if (state.revokedJti[c.jti]) throw new InvalidTokenError('Token has been revoked');
      if (!sameResource(c.iss, baseUrl()) || !sameResource(c.aud, resourceUrl())) throw new InvalidTokenError('Token was not issued by this server');
      const sc = state.clients[c.client_id];
      if (!sc) throw new InvalidTokenError('Client is no longer registered');
      const now = Date.now();
      if (!sc.lastUsedAt || now - sc.lastUsedAt > 60_000) {
        sc.lastUsedAt = now;
        if (now - lastUsedSave > 60_000) { lastUsedSave = now; try { save(); } catch { /* non-fatal */ } }
      }
      return { token, clientId: c.client_id, scopes: c.scope.split(' ').filter(Boolean), expiresAt: c.exp, resource: new URL(c.aud), extra: { sub: c.sub, jti: c.jti } };
    },

    async revokeToken(client, request) {
      const h = sha256b64(request.token);
      const rec = state.refresh[h];
      if (rec && rec.clientId === client.client_id) { delete state.refresh[h]; save(); return; }
      const c = verifyJwt(request.token, opts.secrets.signingKey);
      if (c && c.client_id === client.client_id) { state.revokedJti[c.jti] = c.exp; save(); }
    },
  };

  // ---- decision route ---------------------------------------------------
  const decision: RequestHandler = (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pendingToken = typeof body.pending === 'string' ? body.pending : '';
    const p = verifyBlob<Pending>(pendingToken, consentKey());
    const fail = (msg: string): void => {
      sendHtml(res, 400, randomBytes(16).toString('base64url'), undefined,
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Neo Commander</title><p style="font-family:system-ui;padding:24px">${esc(msg)}</p>`);
    };
    if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return fail('Bu istek geçersiz veya süresi dolmuş. Lütfen bağlantıyı uygulamadan yeniden başlatın.');
    const client = state.clients[p.cid]?.info;
    if (!client || !client.redirect_uris.includes(p.ru) && !isLoopbackMatch(client, p.ru)) return fail('İstemci artık kayıtlı değil. Lütfen bağlantıyı yeniden başlatın.');
    if (!sameResource(p.rs, resourceUrl())) return fail('Sunucu adresi değişti. Lütfen bağlantıyı yeniden başlatın.');

    const redirectBack = (params: Record<string, string>): void => {
      const u = new URL(p.ru);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (p.st) u.searchParams.set('state', p.st);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.redirect(303, u.href);
    };

    if (body.decision === 'deny') return redirectBack({ error: 'access_denied', error_description: 'The owner denied the request' });
    if (body.decision !== 'allow') return fail('Geçersiz istek.');
    if (usedPending.has(p.n)) return fail('Bu istek zaten kullanıldı veya iptal edildi. Lütfen bağlantıyı Claude\'dan yeniden başlatın.');

    if (isLocked()) return renderPage(res, client, p, pendingToken);
    const pin = typeof body.pin === 'string' ? body.pin.slice(0, 100) : '';
    if (!checkPin(pin)) {
      globalPinFailures.push(Date.now());
      const f = pendingFailures.get(p.n) ?? { count: 0, exp: p.exp };
      f.count += 1;
      pendingFailures.set(p.n, f);
      if (f.count >= PIN_MAX_FAILS_PER_PENDING) {
        // This consent request is dead; a fresh one has to be started from Claude. Other requests are unaffected.
        usedPending.set(p.n, p.exp);
        pendingFailures.delete(p.n);
        return fail('Çok fazla hatalı PIN denemesi; bu istek iptal edildi. Lütfen bağlantıyı Claude\'dan yeniden başlatın.');
      }
      const left = PIN_MAX_FAILS_PER_PENDING - f.count;
      return renderPage(res, client, p, pendingToken, `PIN hatalı. Kalan deneme: ${left}.`, 401);
    }
    pendingFailures.delete(p.n);
    usedPending.set(p.n, p.exp);
    for (const [n, exp] of usedPending) if (exp < Date.now()) usedPending.delete(n);

    const code = randomBytes(32).toString('base64url');
    codes.set(code, { clientId: p.cid, redirectUri: p.ru, challenge: p.cc, resource: p.rs, scope: p.sc, gen: state.generation, expiresAt: Date.now() + CODE_TTL_MS });
    for (const [c, r] of codes) if (r.expiresAt < Date.now()) codes.delete(c);
    redirectBack({ code });
  };

  function isLoopbackMatch(client: OAuthClientInformationFull, uri: string): boolean {
    // RFC 8252: loopback redirect URIs may differ in port only (the SDK already validated this).
    try {
      const u = new URL(uri);
      if (!LOOPBACK.has(u.hostname)) return false;
      return client.redirect_uris.some((r) => {
        const x = new URL(r);
        return x.protocol === u.protocol && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search;
      });
    } catch { return false; }
  }

  // ---- lazily built SDK routers, keyed by public URL --------------------
  const routers = new Map<string, RequestHandler>();
  const noLimit = { validate: false } as const;
  // Behind a tunnel every request arrives from 127.0.0.1, so key limiters on the real client address
  // (set by the tunnel edge: Cloudflare / Tailscale Funnel); the LAST x-forwarded-for hop is the one our proxy appended.
  const hdr = (req: Request, name: string): string | undefined => {
    const v = req.headers[name];
    const x = Array.isArray(v) ? v[v.length - 1] : v;
    return typeof x === 'string' && x.trim() ? x.trim().slice(0, 128) : undefined;
  };
  const keyGenerator = (req: Request): string => {
    const cf = hdr(req, 'cf-connecting-ip');
    if (cf) return `cf:${cf}`;
    const ts = hdr(req, 'tailscale-user-login');
    if (ts) return `ts:${ts}`;
    const xff = hdr(req, 'x-forwarded-for');
    if (xff) return `xff:${xff.split(',').pop()!.trim()}`;
    return `ip:${req.ip ?? 'unknown'}`;
  };
  // A refresh request carrying a refresh token we actually hold must never be starved by an attacker's flood.
  const skipKnownRefresh = (req: Request): boolean => {
    const b = req.body as Record<string, unknown> | undefined;
    return b?.grant_type === 'refresh_token' && typeof b.refresh_token === 'string' && b.refresh_token.length <= 256 &&
      state.refresh[sha256b64(b.refresh_token)] !== undefined;
  };
  function routerFor(base: string): RequestHandler {
    let r = routers.get(base);
    if (!r) {
      r = mcpAuthRouter({
        provider,
        issuerUrl: new URL(base),
        resourceServerUrl: new URL(`${base}/mcp`),
        resourceName: 'Neo Commander',
        scopesSupported: [SCOPE],
        authorizationOptions: { rateLimit: { ...noLimit, keyGenerator, windowMs: 15 * 60 * 1000, limit: 200, max: 200 } },
        tokenOptions: { rateLimit: { ...noLimit, keyGenerator, skip: skipKnownRefresh, windowMs: 15 * 60 * 1000, limit: 300, max: 300 } },
        revocationOptions: { rateLimit: { ...noLimit, keyGenerator, windowMs: 15 * 60 * 1000, limit: 100, max: 100 } },
        clientRegistrationOptions: { clientSecretExpirySeconds: 0, rateLimit: { ...noLimit, keyGenerator, windowMs: 60 * 60 * 1000, limit: 60, max: 60 } },
      });
      routers.set(base, r);
    }
    return r;
  }

  const decisionStack = express.Router();
  decisionStack.post('/authorize/decision', express.urlencoded({ extended: false, limit: '16kb' }), decision);
  decisionStack.all('/authorize/decision', (_req, res) => { res.status(405).set('Allow', 'POST').end(); });

  const router: RequestHandler = (req, res, next) => {
    decisionStack(req, res, (err?: unknown) => {
      if (err) return next(err);
      // Alias: clients may probe the origin-level protected resource metadata document.
      if (req.method === 'GET' && stripSlash(req.path) === '/.well-known/oauth-protected-resource') req.url = '/.well-known/oauth-protected-resource/mcp';
      let sdk: RequestHandler;
      try { sdk = routerFor(baseUrl()); } catch {
        res.status(503).json({ error: 'server_error', error_description: 'Public URL is not usable as an OAuth issuer yet' });
        return;
      }
      sdk(req, res, next);
    });
  };

  const guards = new Map<string, RequestHandler>();
  const requireAuth: RequestHandler = (req, res, next) => {
    const base = baseUrl();
    let g = guards.get(base);
    if (!g) {
      const resource = new URL(`${base}/mcp`);
      g = requireBearerAuth({
        verifier: provider,
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
        expectedResource: resource,
      });
      guards.set(base, g);
    }
    void (async () => {
      try { await g!(req, res, next); } catch (e) { next(e); }
    })();
  };

  const prune = (): void => {
    const cur = baseUrl();
    for (const k of [...routers.keys()]) if (k !== cur) routers.delete(k);
    for (const k of [...guards.keys()]) if (k !== cur) guards.delete(k);
    for (const [c, r] of codes) if (!sameResource(r.resource, resourceUrl())) codes.delete(c);
  };

  return {
    router,
    requireAuth,
    listClients() {
      return Object.values(state.clients)
        .map((c) => ({ clientId: c.info.client_id, clientName: clientName(c.info), createdAt: c.createdAt, ...(c.lastUsedAt !== undefined ? { lastUsedAt: c.lastUsedAt } : {}) }))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    revokeClient(clientId) { dropClient(clientId); save(); },
    revokeAll() {
      // Rotate the signing key too: a leaked key must not survive "revoke all". Mutate the shared holder
      // (server.getSecrets returns the same object) and persist before bumping state.
      opts.secrets.signingKey = randomBytes(48).toString('base64url');
      saveSecrets(opts.secrets, opts.stateDir);
      state.generation += 1;
      state.refresh = {};
      state.revokedJti = {};
      codes.clear();
      save();
    },
    clearPinLockout() { globalPinFailures = []; },
    isPinLocked: isLocked,
    onPublicUrlChanged: prune,
  };
}
