import { Palette } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { Switch } from '../components/Switch';
import { ThemeToggle } from '../components/ThemeToggle';
import { TunnelSettings } from '../components/TunnelSettings';
import { useApp } from '../state/store';

export function SettingsPage() {
  const app = useApp();
  const { snapshot } = app;
  if (!snapshot) return null;
  return (
    <>
      <PageHeader title="Ayarlar" />
      <TunnelSettings snapshot={snapshot} />

      <section className="card" aria-labelledby="general-title">
        <h2 id="general-title" className="card-title">Genel</h2>
        <Switch
          checked={snapshot.autostart}
          label="Bilgisayar açılınca otomatik başlat"
          hint="Neo Commander oturum açtığınızda arka planda kendiliğinden çalışır."
          onChange={(v) => void app.updateSettings({ autostart: v }, { success: v ? 'Otomatik başlatma açıldı' : 'Otomatik başlatma kapatıldı' })}
        />
        <div className="setting-row">
          <span className="switch-text">
            <span className="switch-label"><Palette size={16} aria-hidden="true" /> Görünüm</span>
            <span className="switch-hint">Sistem temasını izler veya sabit bir tema seçersiniz.</span>
          </span>
          <ThemeToggle />
        </div>
      </section>

      <section className="card about" aria-labelledby="about-title">
        <h2 id="about-title" className="card-title">Hakkında</h2>
        <dl className="kv">
          <div><dt>Sürüm</dt><dd>Neo Commander {snapshot.version}</dd></div>
          <div><dt>Yerel adres</dt><dd className="mono">127.0.0.1:{snapshot.port}</dd></div>
        </dl>
      </section>
    </>
  );
}
