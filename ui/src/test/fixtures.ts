import { createApi } from '../api/client';
import type { StateResponse } from '../api/types';

export const URL_FIXTURE = 'https://abc.trycloudflare.com/mcp';

export function makeState(over: Partial<StateResponse> = {}): StateResponse {
  return {
    version: '0.1.0',
    engine: { state: 'ready', toolCount: 42 },
    tunnel: { kind: 'cloudflare-quick', state: 'online', publicUrl: 'https://abc.trycloudflare.com', stable: false },
    connectorUrl: URL_FIXTURE,
    pin: 'AAAA-BBBB-CCCC-DDDD',
    pinLocked: false,
    mode: 'standard',
    paused: false,
    allowedDirectories: [],
    autostart: false,
    port: 8790,
    tunnelSettings: { kind: 'cloudflare-quick', publicUrl: '', hasToken: false },
    clients: [{ clientId: 'c1', clientName: 'Claude', createdAt: 1_700_000_000_000 }],
    recent: [],
    ...over,
  };
}

export interface Call { url: string; method: string; headers: Record<string, string>; body: unknown }

/** A fake server: GET /state returns `state`; POST /settings merges the patch like the real router. */
export function fakeServer(initial: StateResponse = makeState()) {
  let state = initial;
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/state')) return json(state);
    if (url.endsWith('/settings')) {
      if (body && typeof body.paused === 'boolean') state = { ...state, paused: body.paused };
      if (body && body.mode) state = { ...state, mode: body.mode };
      const { recent: _r, ...snap } = state;
      return json({ ok: true, ...snap });
    }
    return json({ ok: true });
  }) as typeof fetch;
  const api = createApi({ fetchImpl, getCsrf: () => 'tok-123' });
  return { api, calls };
}
