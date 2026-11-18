import type { AuditEntry, TunnelKind } from '../api/types';

export function toMs(ts: string | number | undefined): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const n = Date.parse(ts);
    return Number.isNaN(n) ? 0 : n;
  }
  return 0;
}

export function formatRelative(ts: string | number | undefined, now: number = Date.now()): string {
  const t = toMs(ts);
  if (!t) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'şimdi';
  if (s < 60) return `${s} sn önce`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk önce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa önce`;
  const d = Math.floor(h / 24);
  return `${d} gün önce`;
}

const dateTime = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export function formatDateTime(ts: string | number | undefined): string {
  const t = toMs(ts);
  return t ? dateTime.format(new Date(t)) : '';
}

const clock = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function formatClock(ts: string | number | undefined): string {
  const t = toMs(ts);
  return t ? clock.format(new Date(t)) : '';
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} sn`;
}

export const TUNNEL_LABEL: Record<TunnelKind, string> = {
  'cloudflare-quick': 'Hızlı Cloudflare',
  tailscale: 'Tailscale',
  'cloudflare-named': 'Cloudflare (adlandırılmış)',
  manual: 'Elle adres',
  none: 'Kapalı',
};

export type Decision = 'allowed' | 'denied' | 'error';
export function decisionOf(e: AuditEntry): Decision {
  if (e.decision) return e.decision;
  return e.ok === false ? 'denied' : 'allowed';
}

export function entryKey(e: AuditEntry): string {
  return `${toMs(e.ts)}|${e.clientId ?? ''}|${e.tool}|${e.durationMs ?? ''}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const a = parts[0]?.[0] ?? '?';
  const b = parts.length > 1 ? parts[1]?.[0] ?? '' : '';
  return (a + b).toLocaleUpperCase('tr-TR');
}

/** Same rule as the server: absolute Windows/UNC/POSIX path or ~. */
export function validateDirectory(raw: string): string | null {
  const t = raw.trim();
  if (!t) return 'Klasör yolunu yazın.';
  if (t.length > 500) return 'Yol çok uzun.';
  if (/[\0\r\n]/.test(t)) return 'Yol geçersiz karakter içeriyor.';
  if (!/^([a-zA-Z]:[\\/]|\\\\|\/|~)/.test(t)) return 'Tam yolu yazın, örneğin C:\\Users\\Ad\\Belgeler.';
  return null;
}
