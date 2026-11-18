import { Cloud, CloudCog, Link, PlugZap, RefreshCw, Server, WifiOff } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { Snapshot, TunnelKind } from '../api/types';
import { TUNNEL_LABEL } from '../lib/format';
import { useApp } from '../state/store';

const KINDS: { kind: TunnelKind; Icon: typeof Cloud; help: string }[] = [
  { kind: 'cloudflare-quick', Icon: Cloud, help: 'Hesap gerekmez, hemen çalışır. Adres bilgisayar her açıldığında değişir; yapay zekaya her seferinde yeniden eklemeniz gerekir.' },
  { kind: 'tailscale', Icon: PlugZap, help: 'Sabit adres verir. Ücretsiz bir Tailscale hesabı açıp Tailscale’i bu bilgisayara kurmanız ve Funnel özelliğini açmanız gerekir.' },
  { kind: 'cloudflare-named', Icon: CloudCog, help: 'Kendi alan adınızla sabit adres. Cloudflare hesabınızda bir tünel oluşturun, tünel token’ını yapıştırın ve tünelin genel adresini yazın.' },
  { kind: 'manual', Icon: Link, help: 'Kendi kurduğunuz bir tünelin https adresini yazın. Neo Commander bu durumda tünel açmaz.' },
  { kind: 'none', Icon: WifiOff, help: 'Yalnızca bu bilgisayarda çalışır. Claude ve ChatGPT dışarıdan bağlanamaz.' },
];

function tunnelStateText(s: Snapshot): string {
  const t = s.tunnel;
  if (t.message) return t.message;
  if (t.state === 'online') return 'Bağlantı çevrimiçi.';
  if (t.state === 'starting') return 'Bağlantı kuruluyor…';
  return '';
}

export function TunnelSettings({ snapshot: s }: { snapshot: Snapshot }) {
  const app = useApp();
  const [kind, setKind] = useState<TunnelKind>(s.tunnelSettings.kind);
  const [url, setUrl] = useState(s.tunnelSettings.publicUrl);
  const [token, setToken] = useState('');
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const urlId = useId(); const tokenId = useId(); const errId = useId();

  // Follow the server until the user starts editing.
  useEffect(() => {
    if (dirty) return;
    setKind(s.tunnelSettings.kind);
    setUrl(s.tunnelSettings.publicUrl);
  }, [dirty, s.tunnelSettings.kind, s.tunnelSettings.publicUrl]);

  const needsUrl = kind === 'manual' || kind === 'cloudflare-named';
  const pick = (k: TunnelKind) => { setKind(k); setDirty(true); setError(null); };

  const onKey = (e: KeyboardEvent) => {
    const i = KINDS.findIndex((x) => x.kind === kind);
    let n = i;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % KINDS.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + KINDS.length) % KINDS.length;
    else return;
    e.preventDefault();
    const next = KINDS[n]!;
    pick(next.kind);
    refs.current[next.kind]?.focus();
  };

  const save = async () => {
    if (needsUrl && !/^https:\/\/\S+$/i.test(url.trim())) { setError('Adres https:// ile başlamalı, örneğin https://neo.ornek.com.'); return; }
    if (kind === 'cloudflare-named' && !token.trim() && !s.tunnelSettings.hasToken) { setError('Cloudflare tünel token’ını yapıştırın.'); return; }
    setError(null);
    setBusy(true);
    const tunnel: { kind: TunnelKind; publicUrl?: string; cloudflareToken?: string } = { kind };
    if (needsUrl) tunnel.publicUrl = url.trim();
    if (kind === 'cloudflare-named' && token.trim()) tunnel.cloudflareToken = token.trim();
    const ok = await app.updateSettings({ tunnel }, { success: 'Bağlantı ayarı kaydedildi' });
    setBusy(false);
    if (ok) { setDirty(false); setToken(''); }
  };

  const msg = tunnelStateText(s);

  return (
    <section className="card" aria-labelledby="tunnel-title">
      <h2 id="tunnel-title" className="card-title">Bağlantı türü</h2>
      <p className="card-lead">Yapay zeka bu bilgisayara internet üzerinden nasıl ulaşsın?</p>

      <div className="kind-list" role="radiogroup" aria-labelledby="tunnel-title" onKeyDown={onKey}>
        {KINDS.map(({ kind: k, Icon, help }) => (
          <button
            key={k}
            ref={(el) => { refs.current[k] = el; }}
            type="button"
            role="radio"
            aria-checked={kind === k}
            tabIndex={kind === k ? 0 : -1}
            className={`kind ${kind === k ? 'is-on' : ''}`}
            onClick={() => pick(k)}
          >
            <span className="kind-icon"><Icon size={20} aria-hidden="true" /></span>
            <span className="kind-body">
              <span className="kind-name">{TUNNEL_LABEL[k]}{(k === 'tailscale' || k === 'cloudflare-named') && <span className="tag">Sabit link</span>}</span>
              <span className="kind-help">{help}</span>
            </span>
          </button>
        ))}
      </div>

      {needsUrl && (
        <div className="kind-fields">
          <div className="field">
            <label className="field-label" htmlFor={urlId}>Genel adres</label>
            <input id={urlId} className="input" type="url" inputMode="url" value={url} placeholder="https://neo.ornek.com" autoComplete="off" spellCheck={false}
              onChange={(e) => { setUrl(e.target.value); setDirty(true); setError(null); }} aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined} />
          </div>
          {kind === 'cloudflare-named' && (
            <div className="field">
              <label className="field-label" htmlFor={tokenId}>Cloudflare tünel token’ı</label>
              <input id={tokenId} className="input" type="password" value={token} autoComplete="off" spellCheck={false}
                placeholder={s.tunnelSettings.hasToken ? 'Kayıtlı. Değiştirmek için yenisini yapıştırın' : 'Token’ı yapıştırın'}
                onChange={(e) => { setToken(e.target.value); setDirty(true); setError(null); }} />
              <p className="field-hint">Token yalnızca bu bilgisayarda saklanır ve bir daha gösterilmez.</p>
            </div>
          )}
        </div>
      )}
      {error && <p id={errId} className="field-error" role="alert">{error}</p>}

      <div className="actions-row">
        <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={busy || !dirty}>Kaydet ve uygula</button>
        <button type="button" className="btn btn-secondary" onClick={() => void app.restartTunnel()}><RefreshCw size={18} aria-hidden="true" /> Bağlantıyı yeniden başlat</button>
      </div>
      {msg && <p className={`tunnel-msg tunnel-${s.tunnel.state}`} role="status"><Server size={15} aria-hidden="true" /> {msg}</p>}
    </section>
  );
}
