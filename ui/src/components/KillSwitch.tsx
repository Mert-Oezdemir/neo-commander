import { OctagonX, Play } from 'lucide-react';
import { useState } from 'react';
import { useApp } from '../state/store';

export function KillSwitch({ paused }: { paused: boolean }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    setBusy(true);
    await app.updateSettings({ paused: !paused }, { success: paused ? 'Devam ediliyor. Yapay zeka tekrar çalışabilir.' : 'Durduruldu. Hiçbir araç çalışmıyor.' });
    setBusy(false);
  };

  return (
    <section className={`kill ${paused ? 'is-paused' : ''}`} aria-labelledby="kill-title">
      <div className="kill-text">
        <h2 id="kill-title" className="kill-title">{paused ? 'Her şey durduruldu' : 'Acil durdur'}</h2>
        <p className="kill-sub">
          {paused
            ? 'Yapay zeka şu an bu bilgisayarda hiçbir şey yapamıyor. Hazır olunca devam ettirin.'
            : 'Tek tıkla yapay zekanın tüm işlemlerini anında engeller. Bağlantılar silinmez.'}
        </p>
      </div>
      <button type="button" className={`kill-btn ${paused ? 'kill-resume' : ''}`} aria-pressed={paused} disabled={busy} onClick={() => void toggle()}>
        {paused ? <Play size={26} aria-hidden="true" /> : <OctagonX size={26} aria-hidden="true" />}
        <span>{paused ? 'Devam et' : 'Acil durdur'}</span>
      </button>
    </section>
  );
}
