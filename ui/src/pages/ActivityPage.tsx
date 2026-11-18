import { Ban, CheckCircle2, ChevronDown, Pause, Play, TriangleAlert, Waves } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AuditEntry } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { decisionOf, entryKey, formatClock, formatDateTime, formatDuration, formatRelative, type Decision } from '../lib/format';
import { useNow } from '../state/hooks';
import { useApp } from '../state/store';

type Filter = 'all' | Decision;
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'Tümü' },
  { key: 'allowed', label: 'İzin verilen' },
  { key: 'denied', label: 'Reddedilen' },
  { key: 'error', label: 'Hatalı' },
];
const BADGE = {
  allowed: { text: 'İzin verildi', Icon: CheckCircle2 },
  denied: { text: 'Reddedildi', Icon: Ban },
  error: { text: 'Hata', Icon: TriangleAlert },
} as const;

function preview(v: unknown): string {
  try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? ''; } catch { return ''; }
}

function Row({ e, name, now }: { e: AuditEntry; name: string; now: number }) {
  const [open, setOpen] = useState(false);
  const d = decisionOf(e);
  const { text, Icon } = BADGE[d];
  const args = preview(e.argsPreview);
  const hasDetail = Boolean(args && args !== '{}' && args !== 'null') || Boolean(e.reason);
  return (
    <li className={`feed-row feed-${d}`}>
      <div className="feed-main">
        <span className="feed-tool">{e.tool}</span>
        <span className="feed-client">{name}</span>
        <span className={`badge badge-${d}`}><Icon size={14} aria-hidden="true" />{text}</span>
        <span className="feed-dur">{formatDuration(e.durationMs)}</span>
        <time className="feed-time" dateTime={new Date(e.ts).toISOString()} title={formatDateTime(e.ts)}>{formatRelative(e.ts, now)}</time>
        {hasDetail ? (
          <button type="button" className="icon-btn" aria-expanded={open} aria-label={`${e.tool} ayrıntılarını ${open ? 'gizle' : 'göster'}`} onClick={() => setOpen((v) => !v)}>
            <ChevronDown size={18} aria-hidden="true" className={open ? 'rot' : ''} />
          </button>
        ) : <span className="icon-btn-spacer" />}
      </div>
      {open && (
        <div className="feed-detail">
          <p className="feed-clock">{formatClock(e.ts)}</p>
          {e.reason && <p className="feed-reason">{e.reason}</p>}
          {args && <pre tabIndex={0} aria-label="Çağrı parametreleri">{args}</pre>}
        </div>
      )}
    </li>
  );
}

export function ActivityPage() {
  const { feed, clientName } = useApp();
  const now = useNow(10_000);
  const [filter, setFilter] = useState<Filter>('all');
  const [paused, setPaused] = useState(false);
  // While paused, freeze the visible list at the entries known when pausing.
  const frozen = useRef<AuditEntry[]>([]);
  useEffect(() => { if (paused) frozen.current = feed; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [paused]);

  const source = paused ? frozen.current : feed;
  const missed = paused ? feed.filter((e) => !new Set(frozen.current.map(entryKey)).has(entryKey(e))).length : 0;
  const shown = useMemo(() => source.filter((e) => filter === 'all' || decisionOf(e) === filter), [source, filter]);

  return (
    <>
      <PageHeader
        title="Etkinlik"
        lead="Yapay zekanın bu bilgisayarda yaptığı her işlem burada anında görünür."
        actions={
          <button type="button" className="btn btn-secondary" aria-pressed={paused} onClick={() => setPaused((p) => !p)}>
            {paused ? <Play size={18} aria-hidden="true" /> : <Pause size={18} aria-hidden="true" />}
            {paused ? 'Akışı sürdür' : 'Akışı duraklat'}
          </button>
        }
      />
      <section className="card feed-card" aria-label="Etkinlik akışı">
        <div className="feed-toolbar">
          <div className="segmented" role="radiogroup" aria-label="Filtre">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" role="radio" aria-checked={filter === f.key} className={`seg ${filter === f.key ? 'is-on' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
            ))}
          </div>
          {paused && (
            <p className="feed-paused" role="status">Akış duraklatıldı{missed > 0 ? `, ${missed} yeni etkinlik bekliyor` : ''}.</p>
          )}
        </div>
        {shown.length === 0 ? (
          <div className="empty">
            <Waves size={28} aria-hidden="true" />
            <p className="empty-title">{feed.length === 0 ? 'Henüz etkinlik yok' : 'Bu filtreyle eşleşen etkinlik yok'}</p>
            <p>{feed.length === 0 ? 'Yapay zeka bir araç kullandığında burada görünecek.' : 'Filtreyi “Tümü” yapıp tekrar bakın.'}</p>
          </div>
        ) : (
          <ul className="feed" aria-live={paused ? 'off' : 'polite'} aria-relevant="additions">
            <li className="feed-head" aria-hidden="true"><span>Araç</span><span>İstemci</span><span>Sonuç</span><span>Süre</span><span>Zaman</span><span /></li>
            {shown.map((e) => <Row key={entryKey(e)} e={e} name={clientName(e.clientId)} now={now} />)}
          </ul>
        )}
      </section>
    </>
  );
}
