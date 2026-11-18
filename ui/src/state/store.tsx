import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, createApi, type Api } from '../api/client';
import type { AuditEntry, SettingsPatch, Snapshot, StateResponse, StatusEvent } from '../api/types';
import { entryKey, toMs } from '../lib/format';
import { useToast } from './toast';

const FEED_MAX = 200;
const POLL_MS = 10_000;

export interface ActionOpts { success?: string }

export interface AppValue {
  snapshot: Snapshot | null;
  loadError: string | null;
  /** false while the server is unreachable (SSE dropped / polling failing). */
  online: boolean;
  feed: AuditEntry[];
  clientName(id: string | undefined): string;
  reload(): Promise<void>;
  updateSettings(patch: SettingsPatch, opts?: ActionOpts): Promise<boolean>;
  regeneratePin(): Promise<boolean>;
  unlockPin(): Promise<boolean>;
  revokeClient(id: string): Promise<boolean>;
  revokeAll(): Promise<boolean>;
  restartTunnel(): Promise<boolean>;
}

export const AppContext = createContext<AppValue | null>(null);

export function useApp(): AppValue {
  const v = useContext(AppContext);
  if (!v) throw new Error('useApp must be used inside <AppProvider>');
  return v;
}

function mergeFeed(prev: AuditEntry[], incoming: AuditEntry[]): AuditEntry[] {
  const seen = new Set(prev.map(entryKey));
  const fresh = incoming.filter((e) => !seen.has(entryKey(e)));
  if (!fresh.length) return prev;
  return [...fresh, ...prev].sort((a, b) => toMs(b.ts) - toMs(a.ts)).slice(0, FEED_MAX);
}

interface Props {
  children: ReactNode;
  api?: Api;
  /** Disable SSE and polling (tests). */
  live?: boolean;
}

export function AppProvider({ children, api: apiProp, live = true }: Props) {
  const api = useMemo(() => apiProp ?? createApi(), [apiProp]);
  const toast = useToast();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [online, setOnline] = useState(true);
  const [feed, setFeed] = useState<AuditEntry[]>([]);
  const loaded = useRef(false);

  const applyState = useCallback((s: StateResponse) => {
    const { recent, ...snap } = s;
    setSnapshot(snap);
    if (Array.isArray(recent)) setFeed((f) => mergeFeed(f, recent));
  }, []);

  const reload = useCallback(async () => {
    try {
      applyState(await api.getState());
      loaded.current = true;
      setLoadError(null);
      setOnline(true);
    } catch (e) {
      setOnline(false);
      if (!loaded.current) setLoadError(e instanceof Error ? e.message : 'Bağlanılamadı.');
    }
  }, [api, applyState]);

  // Initial load + polling (keeps clients / pin lock fresh).
  useEffect(() => {
    void reload();
    if (!live) return;
    const t = window.setInterval(() => { void reload(); }, POLL_MS);
    return () => window.clearInterval(t);
  }, [reload, live]);

  // Server-sent events with manual reconnect when the browser gives up.
  useEffect(() => {
    if (!live || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let retry = 0;
    let timer: number | undefined;
    let stopped = false;

    const open = () => {
      if (stopped) return;
      es = new EventSource(api.eventsUrl);
      es.addEventListener('hello', () => { retry = 0; setOnline(true); void reload(); });
      es.addEventListener('audit', (m) => {
        try { setFeed((f) => mergeFeed(f, [JSON.parse((m as MessageEvent<string>).data) as AuditEntry])); } catch { /* ignore malformed */ }
      });
      es.addEventListener('status', (m) => {
        try {
          const s = JSON.parse((m as MessageEvent<string>).data) as StatusEvent;
          setSnapshot((cur) => (cur ? { ...cur, tunnel: s.tunnel, engine: s.engine, connectorUrl: s.connectorUrl } : cur));
        } catch { /* ignore malformed */ }
      });
      es.onerror = () => {
        setOnline(false);
        if (es && es.readyState === EventSource.CLOSED) {
          es.close();
          retry += 1;
          timer = window.setTimeout(open, Math.min(15_000, 1000 * 2 ** Math.min(retry, 4)));
        }
      };
    };
    open();
    return () => { stopped = true; es?.close(); if (timer) window.clearTimeout(timer); };
  }, [api, live, reload]);

  const fail = useCallback((e: unknown) => {
    toast.push('error', e instanceof ApiError || e instanceof Error ? e.message : 'İşlem tamamlanamadı.');
    return false;
  }, [toast]);

  const updateSettings = useCallback(async (patch: SettingsPatch, opts?: ActionOpts) => {
    try {
      const { ok: _ok, note, ...snap } = await api.updateSettings(patch);
      setSnapshot(snap);
      if (opts?.success) toast.push('success', opts.success);
      else if (note) toast.push('info', note);
      return true;
    } catch (e) { return fail(e); }
  }, [api, fail, toast]);

  const regeneratePin = useCallback(async () => {
    try {
      const r = await api.regeneratePin();
      setSnapshot((s) => (s ? { ...s, pin: r.pin } : s));
      toast.push('success', 'PIN yenilendi');
      return true;
    } catch (e) { return fail(e); }
  }, [api, fail, toast]);

  const unlockPin = useCallback(async () => {
    try {
      const r = await api.unlockPin();
      setSnapshot((s) => (s ? { ...s, pinLocked: r.pinLocked } : s));
      toast.push('success', 'PIN kilidi açıldı');
      return true;
    } catch (e) { return fail(e); }
  }, [api, fail, toast]);

  const revokeClient = useCallback(async (id: string) => {
    try {
      const r = await api.revokeClient(id);
      setSnapshot((s) => (s ? { ...s, clients: r.clients } : s));
      toast.push('success', 'Erişim iptal edildi');
      return true;
    } catch (e) { return fail(e); }
  }, [api, fail, toast]);

  const revokeAll = useCallback(async () => {
    try {
      const r = await api.revokeAll();
      setSnapshot((s) => (s ? { ...s, clients: r.clients } : s));
      toast.push('success', 'Tüm erişimler iptal edildi');
      return true;
    } catch (e) { return fail(e); }
  }, [api, fail, toast]);

  const restartTunnel = useCallback(async () => {
    try {
      await api.restartTunnel();
      toast.push('info', 'Bağlantı yeniden başlatılıyor');
      return true;
    } catch (e) { return fail(e); }
  }, [api, fail, toast]);

  const clientName = useCallback((id: string | undefined) => {
    if (!id) return 'Bilinmeyen istemci';
    return snapshot?.clients.find((c) => c.clientId === id)?.clientName || 'Bilinmeyen istemci';
  }, [snapshot]);

  const value = useMemo<AppValue>(() => ({
    snapshot, loadError, online, feed, clientName, reload, updateSettings, regeneratePin, unlockPin, revokeClient, revokeAll, restartTunnel,
  }), [snapshot, loadError, online, feed, clientName, reload, updateSettings, regeneratePin, unlockPin, revokeClient, revokeAll, restartTunnel]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
