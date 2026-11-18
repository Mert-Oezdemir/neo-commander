import { describe, expect, it } from 'vitest';
import { ApiError, createApi, describeError } from '../api/client';
import { fakeServer } from './fixtures';

describe('api client', () => {
  it('GET sends no CSRF header and hits /panel/api/state', async () => {
    const { api, calls } = fakeServer();
    const s = await api.getState();
    expect(s.version).toBe('0.1.0');
    expect(calls[0]).toMatchObject({ url: '/panel/api/state', method: 'GET' });
    expect(calls[0]!.headers['x-neo-csrf']).toBeUndefined();
  });

  it('POST sends the CSRF header and a JSON body', async () => {
    const { api, calls } = fakeServer();
    await api.updateSettings({ paused: true });
    await api.revokeClient('a b/c');
    expect(calls[0]).toMatchObject({ url: '/panel/api/settings', method: 'POST', body: { paused: true } });
    expect(calls[0]!.headers['x-neo-csrf']).toBe('tok-123');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[1]!.url).toBe('/panel/api/clients/a%20b%2Fc/revoke');
  });

  it('reads the CSRF token from the meta tag by default', async () => {
    document.head.insertAdjacentHTML('beforeend', '<meta name="neo-csrf" content="from-meta">');
    const seen: string[] = [];
    const api = createApi({ fetchImpl: (async (_u: unknown, init?: RequestInit) => { seen.push((init!.headers as Record<string, string>)['x-neo-csrf']!); return new Response('{}'); }) as typeof fetch });
    await api.restartTunnel();
    expect(seen).toEqual(['from-meta']);
  });

  it('maps server error codes to Turkish messages and keeps server sentences', async () => {
    const mk = (status: number, error: string) => createApi({ getCsrf: () => 't', fetchImpl: (async () => new Response(JSON.stringify({ error }), { status })) as typeof fetch });
    await expect(mk(403, 'csrf').updateSettings({})).rejects.toMatchObject({ name: 'ApiError', status: 403, message: describeError('csrf', 403) });
    await expect(mk(400, 'Adres https:// ile başlamalı.').updateSettings({})).rejects.toThrow('Adres https:// ile başlamalı.');
  });

  it('turns network failures into an ApiError', async () => {
    const api = createApi({ fetchImpl: (async () => { throw new TypeError('x'); }) as typeof fetch });
    const err = await api.getState().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('network');
  });
});
