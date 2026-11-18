import type { ClientInfo, SettingsPatch, SettingsResponse, StateResponse } from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = '') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Server error codes -> Turkish text. Unknown plain-language messages pass through. */
const ERROR_TEXT: Record<string, string> = {
  csrf: 'Oturum doğrulanamadı. Paneli yenileyip tekrar deneyin.',
  origin: 'İstek bu sayfadan gelmediği için reddedildi. Paneli yenileyin.',
  'cross-site': 'İstek bu sayfadan gelmediği için reddedildi. Paneli yenileyin.',
  mode: 'Geçersiz yetki seviyesi.',
  paused: 'Acil durdur ayarı değiştirilemedi.',
  autostart: 'Otomatik başlatma ayarı değiştirilemedi.',
  addDirectory: 'Klasör yolu geçersiz. Tam yolu yazın.',
  removeDirectory: 'Klasör kaldırılamadı.',
  tunnel: 'Bağlantı ayarı geçersiz.',
  'tunnel.kind': 'Geçersiz bağlantı türü.',
  'not found': 'İstenen kaynak bulunamadı.',
};

export function describeError(code: string, status: number): string {
  const known = ERROR_TEXT[code];
  if (known) return known;
  if (code && /\s/.test(code)) return code; // already a sentence from the server
  if (status === 404) return 'Panel bu adresten erişilebilir değil.';
  if (status >= 500) return 'Neo Commander bir hata verdi. Biraz sonra tekrar deneyin.';
  return 'İşlem tamamlanamadı. Tekrar deneyin.';
}

export interface ApiOptions {
  base?: string;
  /** Returns the CSRF token. Defaults to the <meta name="neo-csrf"> tag. */
  getCsrf?: () => string;
  fetchImpl?: typeof fetch;
}

export function readCsrfFromDocument(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="neo-csrf"]')?.content ?? '';
}

export function createApi(opts: ApiOptions = {}) {
  const base = opts.base ?? '/panel/api';
  const getCsrf = opts.getCsrf ?? readCsrfFromDocument;
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const init: RequestInit = { method, headers, cache: 'no-store' };
    if (method === 'POST') {
      headers['x-neo-csrf'] = getCsrf();
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    let res: Response;
    try {
      res = await doFetch(base + path, init);
    } catch {
      throw new ApiError('Neo Commander’a ulaşılamıyor.', 0, 'network');
    }
    let json: unknown = {};
    try { json = await res.json(); } catch { /* empty body */ }
    if (!res.ok) {
      const code = typeof (json as { error?: unknown }).error === 'string' ? (json as { error: string }).error : '';
      throw new ApiError(describeError(code, res.status), res.status, code);
    }
    return json as T;
  }

  return {
    getState: () => request<StateResponse>('GET', '/state'),
    updateSettings: (patch: SettingsPatch) => request<SettingsResponse>('POST', '/settings', patch),
    regeneratePin: () => request<{ ok: true; pin: string }>('POST', '/pin/regenerate'),
    unlockPin: () => request<{ ok: true; pinLocked: boolean }>('POST', '/pin/unlock'),
    revokeClient: (id: string) => request<{ ok: true; clients: ClientInfo[] }>('POST', `/clients/${encodeURIComponent(id)}/revoke`),
    revokeAll: () => request<{ ok: true; clients: ClientInfo[] }>('POST', '/clients/revoke-all'),
    restartTunnel: () => request<{ ok: true }>('POST', '/tunnel/restart'),
    eventsUrl: `${base}/events`,
  };
}

export type Api = ReturnType<typeof createApi>;
