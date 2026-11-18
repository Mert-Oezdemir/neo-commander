import { useEffect, useState } from 'react';

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export type RouteKey = 'baglan' | 'etkinlik' | 'guvenlik' | 'baglantilar' | 'ayarlar';
export const ROUTES: RouteKey[] = ['baglan', 'etkinlik', 'guvenlik', 'baglantilar', 'ayarlar'];

function parse(): RouteKey {
  const k = window.location.hash.replace(/^#\/?/, '') as RouteKey;
  return ROUTES.includes(k) ? k : 'baglan';
}

export function useRoute(): RouteKey {
  const [r, setR] = useState<RouteKey>(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}
