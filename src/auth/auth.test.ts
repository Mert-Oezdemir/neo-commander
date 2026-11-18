import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { createAuth } from './index.js';
import type { Auth } from './index.js';
import { signJwt } from './jwt.js';

const PIN = 'ABCD-EFGH-JKLM-NPQR';
const SECRETS = { signingKey: randomBytes(48).toString('base64url'), ownerPin: PIN };
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

interface Harness {
  auth: Auth; server: Server; base: string; dir: string; setUrl(u: string | undefined): void; close(): Promise<void>;
}

async function start(dir = mkdtempSync(join(tmpdir(), 'nc-auth-'))): Promise<Harness> {
  let publicUrl: string | undefined;
  let port = 0;
  const auth = createAuth({ stateDir: dir, secrets: SECRETS, getPublicUrl: () => publicUrl, port: 0 });
  // port is only used for the default URL; we need the real one, so use a getter that reads it lazily.
  const app = express();
  app.use(auth.router);
  app.all('/mcp', auth.requireAuth, (req, res) => { res.json({ ok: true, client: req.auth?.clientId }); });
  const server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  publicUrl = base;
  return {
    auth, server, base, dir,
    setUrl(u) { publicUrl = u; auth.onPublicUrlChanged(); },
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

const pkce = () => {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(h: Harness, redirect = REDIRECT, extra: object = {}): Promise<Response> {
  return fetch(`${h.base}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude <test>', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra }),
  });
}

function authorizeUrl(h: Harness, clientId: string, challenge: string, state = 'st123', resource?: string): string {
  const u = new URL(`${h.base}/authorize`);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge,
    code_challenge_method: 'S256', state, ...(resource ? { resource } : { resource: `${h.base}/mcp` }),
  }).toString();
  return u.href;
}

async function getPending(h: Harness, url: string): Promise<{ pending: string; html: string; res: Response }> {
  const res = await fetch(url);
  const html = await res.text();
  const m = /name="pending" value="([^"]+)"/.exec(html);
  return { pending: m?.[1] ?? '', html, res };
}

function decide(h: Harness, pending: string, pin: string, decision = 'allow'): Promise<Response> {
  return fetch(`${h.base}/authorize/decision`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pending, pin, decision }).toString(),
  });
}

async function tokenReq(h: Harness, params: Record<string, string>): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(`${h.base}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

/** Full happy path: register + authorize + decision + token exchange. */
async function connect(h: Harness): Promise<{ clientId: string; access: string; refresh: string }> {
  const reg = await (await register(h)).json() as { client_id: string };
  const { verifier, challenge } = pkce();
  const { pending } = await getPending(h, authorizeUrl(h, reg.client_id, challenge));
  const d = await decide(h, pending, PIN);
  const loc = new URL(d.headers.get('location')!);
  const t = await tokenReq(h, { grant_type: 'authorization_code', client_id: reg.client_id, code: loc.searchParams.get('code')!, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${h.base}/mcp` });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  return { clientId: reg.client_id, access: t.json.access_token, refresh: t.json.refresh_token };
}

const mcp = (h: Harness, token?: string, query = '') =>
  fetch(`${h.base}/mcp${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('OAuth full flow', () => {
  let h: Harness;
  before(async () => { h = await start(); });
  after(async () => { await h.close(); rmSync(h.dir, { recursive: true, force: true }); });

  let clientId = '';
  let verifier = '';
  let challenge = '';
  let code = '';
  let access = '';
  let refresh = '';

  test('metadata discovery', async () => {
    const prm = await (await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`)).json() as any;
    assert.equal(prm.resource, `${h.base}/mcp`);
    assert.deepEqual(prm.authorization_servers.map((s: string) => s.replace(/\/$/, '')), [h.base]);
    const alias = await (await fetch(`${h.base}/.well-known/oauth-protected-resource`)).json() as any;
    assert.equal(alias.resource, `${h.base}/mcp`);
    const as = await (await fetch(`${h.base}/.well-known/oauth-authorization-server`)).json() as any;
    assert.equal(as.authorization_endpoint, `${h.base}/authorize`);
    assert.equal(as.token_endpoint, `${h.base}/token`);
    assert.equal(as.registration_endpoint, `${h.base}/register`);
    assert.ok(as.code_challenge_methods_supported.includes('S256'));
    assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
    assert.ok(as.grant_types_supported.includes('refresh_token'));
  });

  test('/mcp without token -> 401 with RFC 9728 WWW-Authenticate', async () => {
    const r = await mcp(h);
    assert.equal(r.status, 401);
    const www = r.headers.get('www-authenticate') ?? '';
    assert.match(www, /^Bearer /);
    assert.ok(www.includes(`resource_metadata="${h.base}/.well-known/oauth-protected-resource/mcp"`), www);
  });

  test('DCR rejects bad redirect URIs', async () => {
    for (const bad of ['https://evil.example/cb', 'http://claude.ai/cb', 'https://claude.ai.evil.com/cb', 'https://notclaude.ai/cb', 'javascript:alert(1)', 'http://192.168.1.5/cb']) {
      const r = await register(h, bad);
      assert.equal(r.status, 400, bad);
    }
  });

  test('DCR accepts claude.ai, subdomains, chatgpt and loopback; public client has no secret', async () => {
    for (const ok of ['https://chatgpt.com/aip/cb', 'https://chat.openai.com/cb', 'https://app.claude.com/cb', 'http://127.0.0.1:5555/cb', 'http://localhost/cb', 'http://[::1]:9/cb']) {
      assert.equal((await register(h, ok)).status, 201, ok);
    }
    const r = await register(h);
    assert.equal(r.status, 201);
    const j = await r.json() as any;
    clientId = j.client_id;
    assert.equal(j.client_secret, undefined);
    assert.equal(j.token_endpoint_auth_method, 'none');
  });

  test('GET /authorize renders escaped consent page with strict CSP', async () => {
    ({ verifier, challenge } = pkce());
    const { html, res, pending } = await getPending(h, authorizeUrl(h, clientId, challenge));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.ok(!csp.includes('unsafe-inline'));
    assert.ok(html.includes('Bağlantı isteği'));
    assert.ok(html.includes('İzin ver') && html.includes('Reddet'));
    assert.ok(html.includes('Claude &lt;test&gt;'), 'client name must be escaped');
    assert.ok(!html.includes('Claude <test>'));
    assert.ok(html.includes('claude.ai'));
    assert.ok(!/(src|href)="https?:/.test(html), 'no external assets');
    assert.ok(pending.length > 20);
  });

  test('authorize with foreign resource is refused', async () => {
    const r = await fetch(authorizeUrl(h, clientId, challenge, 's', 'https://other.example/mcp'), { redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.equal(new URL(r.headers.get('location')!).searchParams.get('error'), 'invalid_target');
  });

  test('tampered / garbage pending token is rejected', async () => {
    const { pending } = await getPending(h, authorizeUrl(h, clientId, challenge));
    const [body, sig] = pending.split('.') as [string, string];
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    obj.ru = 'https://claude.ai/evil';
    const forged = `${Buffer.from(JSON.stringify(obj)).toString('base64url')}.${sig}`;
    assert.equal((await decide(h, forged, PIN)).status, 400);
    assert.equal((await decide(h, 'garbage', PIN)).status, 400);
    assert.equal((await decide(h, '', PIN)).status, 400);
  });

  test('wrong PIN fails and does not redirect', async () => {
    const { pending } = await getPending(h, authorizeUrl(h, clientId, challenge));
    const r = await decide(h, pending, 'WRONG-PIN');
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('location'), null);
    assert.ok((await r.text()).includes('PIN hatalı'));
  });

  test('deny redirects with access_denied and state', async () => {
    const { pending } = await getPending(h, authorizeUrl(h, clientId, challenge, 'xyz'));
    const r = await decide(h, pending, '', 'deny');
    assert.equal(r.status, 303);
    const u = new URL(r.headers.get('location')!);
    assert.equal(u.origin + u.pathname, REDIRECT);
    assert.equal(u.searchParams.get('error'), 'access_denied');
    assert.equal(u.searchParams.get('state'), 'xyz');
  });

  test('correct PIN (lowercase, spaces) redirects with code + state; single use', async () => {
    const { pending } = await getPending(h, authorizeUrl(h, clientId, challenge, 'st123'));
    const r = await decide(h, pending, 'abcd efgh jklm npqr');
    assert.equal(r.status, 303);
    const u = new URL(r.headers.get('location')!);
    assert.equal(u.origin + u.pathname, REDIRECT);
    assert.equal(u.searchParams.get('state'), 'st123');
    code = u.searchParams.get('code')!;
    assert.ok(code.length >= 40);
    // same pending token cannot mint a second code
    assert.equal((await decide(h, pending, PIN)).status, 400);
  });

  test('token exchange with wrong verifier fails and burns the code', async () => {
    const bad = await tokenReq(h, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: pkce().verifier, redirect_uri: REDIRECT });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, 'invalid_grant');
    const retry = await tokenReq(h, { grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
    assert.equal(retry.status, 400, 'code must be burned after a failed attempt');
  });

  test('token exchange succeeds, JWT claims are right', async () => {
    const { pending } = await getPending(h, authorizeUrl(h, clientId, challenge));
    const d = await decide(h, pending, PIN);
    const c = new URL(d.headers.get('location')!).searchParams.get('code')!;
    const t = await tokenReq(h, { grant_type: 'authorization_code', client_id: clientId, code: c, code_verifier: verifier, redirect_uri: REDIRECT, resource: `${h.base}/mcp` });
    assert.equal(t.status, 200, JSON.stringify(t.json));
    assert.equal(t.json.token_type, 'Bearer');
    assert.equal(t.json.expires_in, 3600);
    access = t.json.access_token; refresh = t.json.refresh_token;
    const claims = JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString());
    assert.equal(claims.aud, `${h.base}/mcp`);
    assert.equal(claims.iss, h.base);
    assert.equal(claims.sub, 'owner');
    assert.equal(claims.client_id, clientId);
    assert.equal(claims.exp - claims.iat, 3600);
    assert.equal(typeof claims.gen, 'number');
    assert.ok(claims.jti);
    // code replay
    const again = await tokenReq(h, { grant_type: 'authorization_code', client_id: clientId, code: c, code_verifier: verifier, redirect_uri: REDIRECT });
    assert.equal(again.status, 400);
  });

  test('refresh token stored only as hash', () => {
    const raw = readFileSync(join(h.dir, 'oauth.json'), 'utf8');
    assert.ok(!raw.includes(refresh));
    assert.ok(raw.includes(createHash('sha256').update(refresh).digest('base64url')));
  });

  test('/mcp accepts the access token; query-string tokens are ignored', async () => {
    const r = await mcp(h, access);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as any).client, clientId);
    assert.equal((await mcp(h, undefined, `?access_token=${access}`)).status, 401);
    assert.equal((await mcp(h, undefined, `?token=${access}`)).status, 401);
  });

  test('tampered JWTs are rejected (payload, signature, alg none, alg confusion)', async () => {
    const [hd, p, s] = access.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const forgedPayload = `${hd}.${b64({ ...claims, exp: claims.exp + 99999 })}.${s}`;
    const flippedSig = `${hd}.${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`;
    const hs512 = `${b64({ alg: 'HS512', typ: 'JWT' })}.${p}.${s}`;
    const wrongKey = signJwt(claims, 'another-key-another-key-another-key-another-key');
    for (const t of [forgedPayload, flippedSig, none, hs512, wrongKey, 'abc', `${hd}.${p}`]) {
      assert.equal((await mcp(h, t)).status, 401, t.slice(0, 30));
    }
  });

  test('expired token is rejected', async () => {
    const claims = JSON.parse(Buffer.from(access.split('.')[1]!, 'base64url').toString());
    const expired = signJwt({ ...claims, iat: claims.iat - 7200, exp: claims.iat - 3600 }, SECRETS.signingKey);
    assert.equal((await mcp(h, expired)).status, 401);
    const wrongGen = signJwt({ ...claims, gen: claims.gen + 1 }, SECRETS.signingKey);
    assert.equal((await mcp(h, wrongGen)).status, 401);
  });

  test('refresh rotation: new pair works, old refresh rejected', async () => {
    const r1 = await tokenReq(h, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh });
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    assert.notEqual(r1.json.refresh_token, refresh);
    assert.equal((await mcp(h, r1.json.access_token)).status, 200);
    const old = await tokenReq(h, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh });
    assert.equal(old.status, 400);
    assert.equal(old.json.error, 'invalid_grant');
    refresh = r1.json.refresh_token;
    access = r1.json.access_token;
  });

  test('refresh token is bound to its client', async () => {
    const other = await (await register(h)).json() as any;
    const r = await tokenReq(h, { grant_type: 'refresh_token', client_id: other.client_id, refresh_token: refresh });
    assert.equal(r.status, 400);
  });

  test('revokeClient kills access token immediately and refresh tokens', async () => {
    assert.equal((await mcp(h, access)).status, 200);
    h.auth.revokeClient(clientId);
    assert.equal((await mcp(h, access)).status, 401);
    assert.ok(!h.auth.listClients().some((c) => c.clientId === clientId));
    const r = await tokenReq(h, { grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh });
    assert.equal(r.status, 400);
  });

  test('revokeAll invalidates every token', async () => {
    const c = await connect(h);
    assert.equal((await mcp(h, c.access)).status, 200);
    h.auth.revokeAll();
    assert.equal((await mcp(h, c.access)).status, 401);
    const r = await tokenReq(h, { grant_type: 'refresh_token', client_id: c.clientId, refresh_token: c.refresh });
    assert.equal(r.status, 400);
    // and new connections work again
    const c2 = await connect(h);
    assert.equal((await mcp(h, c2.access)).status, 200);
  });

  test('/revoke revokes refresh token and access token', async () => {
    const c = await connect(h);
    const rv = await fetch(`${h.base}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.clientId, token: c.access }).toString() });
    assert.equal(rv.status, 200);
    assert.equal((await mcp(h, c.access)).status, 401);
    await fetch(`${h.base}/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.clientId, token: c.refresh }).toString() });
    assert.equal((await tokenReq(h, { grant_type: 'refresh_token', client_id: c.clientId, refresh_token: c.refresh })).status, 400);
  });

  test('public URL change: old-audience token rejected, metadata follows, WWW-Authenticate follows', async () => {
    const c = await connect(h);
    assert.equal((await mcp(h, c.access)).status, 200);
    // simulate a tunnel restart: new public URL (loopback alias keeps the SDK's https check happy)
    const newBase = h.base.replace('127.0.0.1', 'localhost');
    h.setUrl(newBase);
    const r = await mcp(h, c.access);
    assert.equal(r.status, 401);
    assert.ok((r.headers.get('www-authenticate') ?? '').includes(`${newBase}/.well-known/oauth-protected-resource/mcp`));
    const prm = await (await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`)).json() as any;
    assert.equal(prm.resource, `${newBase}/mcp`);
    // old refresh token was bound to the old resource
    assert.equal((await tokenReq(h, { grant_type: 'refresh_token', client_id: c.clientId, refresh_token: c.refresh })).status, 400);
    // a fresh authorization against the new URL works
    const reg = await (await register(h)).json() as any;
    const { verifier, challenge } = pkce();
    const u = new URL(authorizeUrl(h, reg.client_id, challenge, 's', `${newBase}/mcp`));
    const { pending } = await getPending(h, u.href);
    const d = await decide(h, pending, PIN);
    const code = new URL(d.headers.get('location')!).searchParams.get('code')!;
    const t = await tokenReq(h, { grant_type: 'authorization_code', client_id: reg.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
    assert.equal(t.status, 200);
    assert.equal((await mcp(h, t.json.access_token)).status, 200);
    // switching back: token for newBase is refused again
    h.setUrl(h.base);
    assert.equal((await mcp(h, t.json.access_token)).status, 401);
  });

  test('client cap: 50 clients, oldest unused is dropped', async () => {
    const first = h.auth.listClients();
    for (let i = 0; i < 55; i++) assert.equal((await register(h)).status, 201);
    const now = h.auth.listClients();
    assert.equal(now.length, 50);
    assert.ok(first.length > 0);
  });
});

describe('PIN limits (per pending request + global in-memory cap)', () => {
  let h: Harness;
  before(async () => { h = await start(); });
  after(async () => { await h.close(); rmSync(h.dir, { recursive: true, force: true }); });

  const newPending = async (): Promise<{ pending: string; clientId: string; challenge: string }> => {
    const reg = await (await register(h)).json() as any;
    const { challenge } = pkce();
    const { pending } = await getPending(h, authorizeUrl(h, reg.client_id, challenge));
    return { pending, clientId: reg.client_id, challenge };
  };

  test('5 wrong PINs kill only that pending request; the owner can start a fresh one', async () => {
    const a = await newPending();
    for (let i = 0; i < 4; i++) assert.equal((await decide(h, a.pending, `bad-${i}`)).status, 401);
    const dead = await decide(h, a.pending, 'bad-4');
    assert.equal(dead.status, 400);
    assert.ok((await dead.text()).includes('yeniden başlatın'));
    // even the right PIN no longer works on the dead request
    const after = await decide(h, a.pending, PIN);
    assert.equal(after.status, 400);
    assert.equal(after.headers.get('location'), null);
    // a fresh request is not locked out and the correct PIN works
    assert.equal(h.auth.isPinLocked(), false);
    const b = await newPending();
    const ok = await decide(h, b.pending, PIN);
    assert.equal(ok.status, 303);
    assert.ok(new URL(ok.headers.get('location')!).searchParams.get('code'));
  });

  test('failures are not persisted (oauth.json has no pinFailures; restart is clean)', async () => {
    const state = JSON.parse(readFileSync(join(h.dir, 'oauth.json'), 'utf8'));
    assert.equal(state.pinFailures, undefined);
  });

  test('global cap of 30 failures locks everything until clearPinLockout()', async () => {
    h.auth.clearPinLockout();
    for (let k = 0; k < 6; k++) {
      const x = await newPending();
      for (let i = 0; i < 5; i++) await decide(h, x.pending, `bad-${k}-${i}`);
    }
    assert.equal(h.auth.isPinLocked(), true);
    const y = await newPending();
    const page = await getPending(h, authorizeUrl(h, y.clientId, y.challenge));
    assert.equal(page.res.status, 429);
    assert.ok(!page.html.includes('name="pin"'));
    if (y.pending) assert.equal((await decide(h, y.pending, PIN)).status, 429);
    h.auth.clearPinLockout();
    assert.equal(h.auth.isPinLocked(), false);
    const z = await newPending();
    assert.equal((await decide(h, z.pending, PIN)).status, 303);
  });
});

describe('access token hardening + key rotation', () => {
  let h: Harness;
  before(async () => { h = await start(); });
  after(async () => { await h.close(); rmSync(h.dir, { recursive: true, force: true }); });

  const claimsFor = (clientId: string, over: Record<string, unknown> = {}) => {
    const now = Math.floor(Date.now() / 1000);
    return { iss: h.base, aud: `${h.base}/mcp`, sub: 'owner' as const, client_id: clientId, scope: 'mcp', iat: now, exp: now + 3600, jti: randomBytes(8).toString('hex'), gen: 1, ...over };
  };

  test('rejects over-long lifetimes and future iat, even with a valid signature', async () => {
    const c = await connect(h);
    const now = Math.floor(Date.now() / 1000);
    const gen = (JSON.parse(Buffer.from(c.access.split('.')[1]!, 'base64url').toString()) as { gen: number }).gen;
    const forged = (over: Record<string, unknown>) => signJwt(claimsFor(c.clientId, { gen, ...over }) as any, SECRETS.signingKey);
    assert.equal((await mcp(h, forged({}))).status, 200);
    assert.equal((await mcp(h, forged({ exp: now + 10 * 365 * 86400 }))).status, 401);
    assert.equal((await mcp(h, forged({ exp: now + 3600 + 61 }))).status, 401);
    assert.equal((await mcp(h, forged({ iat: now + 120, exp: now + 3600 }))).status, 401);
    assert.equal((await mcp(h, forged({ iat: now + 30, exp: now + 3600 }))).status, 200); // within skew
  });

  test('revokeAll rotates + persists the signing key; tokens signed with the old key die', async () => {
    const c = await connect(h);
    const oldKey = SECRETS.signingKey;
    h.auth.revokeAll();
    assert.notEqual(SECRETS.signingKey, oldKey);
    assert.equal(JSON.parse(readFileSync(join(h.dir, 'secrets.json'), 'utf8')).signingKey, SECRETS.signingKey);
    // attacker holding the old key guesses the new generation
    const gen = (JSON.parse(readFileSync(join(h.dir, 'oauth.json'), 'utf8')) as { generation: number }).generation;
    const forged = signJwt(claimsFor(c.clientId, { gen }) as any, oldKey);
    assert.equal((await mcp(h, forged)).status, 401);
    // legitimate reconnect with the new key works
    const c2 = await connect(h);
    assert.equal((await mcp(h, c2.access)).status, 200);
  });
});

describe('rate limits keyed on the real client address (tunnel)', () => {
  let h: Harness;
  before(async () => { h = await start(); });
  after(async () => { await h.close(); rmSync(h.dir, { recursive: true, force: true }); });

  const tokenFrom = (headers: Record<string, string>, body: Record<string, string>) =>
    fetch(`${h.base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });

  test('one flooding address does not starve others; known refresh tokens are never counted', async () => {
    const c = await connect(h);
    const bad = { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'nope' };
    let last = 0;
    for (let i = 0; i < 305; i++) last = (await tokenFrom({ 'cf-connecting-ip': '203.0.113.9' }, bad)).status;
    assert.equal(last, 429);
    // a different client address is unaffected
    assert.notEqual((await tokenFrom({ 'cf-connecting-ip': '198.51.100.7' }, bad)).status, 429);
    // x-forwarded-for: only the LAST entry counts (appended by our own proxy); rotating the spoofable first entry does not help
    for (let i = 0; i < 305; i++) last = (await tokenFrom({ 'x-forwarded-for': `10.0.0.${i % 250}, 203.0.113.50` }, bad)).status;
    assert.equal(last, 429);
    assert.notEqual((await tokenFrom({ 'x-forwarded-for': '10.0.0.1, 203.0.113.51' }, bad)).status, 429);
    // the legitimate refresh from the flooded address still goes through
    const r = await tokenFrom({ 'cf-connecting-ip': '203.0.113.9' }, { grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId });
    assert.equal(r.status, 200, await r.text());
  });
});
