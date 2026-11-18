import { AlertTriangle, ArrowRight, Eye, EyeOff, KeyRound, Link2, LockOpen, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { Snapshot } from '../api/types';
import { useApp } from '../state/store';
import { ConfirmDialog } from './ConfirmDialog';
import { CopyButton } from './CopyButton';

function urlPlaceholder(s: Snapshot): string {
  if (s.tunnel.state === 'error') return 'Bağlantı kurulamadı';
  if (s.tunnel.kind === 'none') return 'Bağlantı kapalı. Ayarlar’dan bir bağlantı türü seçin.';
  return 'Bağlantı hazırlanıyor…';
}

export function ConnectorCard({ snapshot: s }: { snapshot: Snapshot }) {
  const app = useApp();
  const [shown, setShown] = useState(false);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const quick = s.tunnel.kind === 'cloudflare-quick' && s.tunnel.state === 'online';

  return (
    <section className="card connector" aria-labelledby="connector-title">
      <h2 id="connector-title" className="card-title">Bağlantı bilgileri</h2>

      {quick && (
        <div className="notice notice-warn">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <p>Bu link, bilgisayar yeniden başlayınca değişir. Her seferinde yeniden eklemek istemiyorsanız sabit bir link kurun.</p>
            <a className="link-arrow" href="#/ayarlar">Sabit link ayarlarına git <ArrowRight size={15} aria-hidden="true" /></a>
          </div>
        </div>
      )}

      <div className="field">
        <span className="field-label" id="url-label"><Link2 size={15} aria-hidden="true" /> Bağlayıcı linki</span>
        <div className="copy-row">
          <output className={`mono-box mono-url ${s.connectorUrl ? '' : 'is-empty'}`} aria-labelledby="url-label">{s.connectorUrl ?? urlPlaceholder(s)}</output>
          <CopyButton text={s.connectorUrl ?? ''} label="Linki kopyala" doneToast="Link kopyalandı" variant="primary" disabled={!s.connectorUrl} />
        </div>
      </div>

      <div className="field">
        <span className="field-label" id="pin-label"><KeyRound size={15} aria-hidden="true" /> Sahip PIN’i</span>
        <div className="copy-row">
          <output className="mono-box mono-pin" aria-labelledby="pin-label">{shown ? s.pin : '••••-••••-••••-••••'}</output>
          <div className="btn-group">
            <button type="button" className="btn btn-secondary" onClick={() => setShown((v) => !v)} aria-pressed={shown}>
              {shown ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
              {shown ? 'Gizle' : 'Göster'}
            </button>
            <CopyButton text={s.pin} label="Kopyala" doneToast="PIN kopyalandı" />
            <button type="button" className="btn btn-ghost" onClick={() => setConfirmRegen(true)}>
              <RefreshCw size={18} aria-hidden="true" /> Yenile
            </button>
          </div>
        </div>
        <p className="field-hint">Claude veya ChatGPT ilk kez bağlanırken bu PIN’i sorar. PIN’i yalnızca siz bilirsiniz.</p>
        {s.pinLocked && (
          <div className="notice notice-danger">
            <LockOpen size={18} aria-hidden="true" />
            <div>
              <p>PIN çok fazla yanlış girildiği için kilitlendi. Yeni bağlantılar kilit açılana kadar reddedilir.</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void app.unlockPin()}>Kilidi aç</button>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmRegen}
        title="PIN yenilensin mi?"
        body="Eski PIN çalışmaz. Bağlı olanlar etkilenmez, ama yeni bağlanacaklar yeni PIN’i girmek zorunda kalır."
        confirmLabel="PIN’i yenile"
        onCancel={() => setConfirmRegen(false)}
        onConfirm={() => { setConfirmRegen(false); void app.regeneratePin(); }}
      />
    </section>
  );
}
