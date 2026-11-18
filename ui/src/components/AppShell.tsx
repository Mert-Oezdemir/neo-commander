import { Activity, Link2, OctagonX, Plug, Settings, ShieldCheck, WifiOff, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ROUTES, type RouteKey } from '../state/hooks';
import { useApp } from '../state/store';
import { Wordmark } from './Logo';
import { ThemeToggle } from './ThemeToggle';

const NAV: Record<RouteKey, { label: string; Icon: LucideIcon }> = {
  baglan: { label: 'Bağlan', Icon: Link2 },
  etkinlik: { label: 'Etkinlik', Icon: Activity },
  guvenlik: { label: 'Güvenlik', Icon: ShieldCheck },
  baglantilar: { label: 'Bağlantılar', Icon: Plug },
  ayarlar: { label: 'Ayarlar', Icon: Settings },
};

export function AppShell({ route, children }: { route: RouteKey; children: ReactNode }) {
  const { snapshot, online, updateSettings } = useApp();
  const paused = snapshot?.paused ?? false;

  return (
    <div className="shell">
      <aside className="side">
        <div className="side-brand"><Wordmark /></div>
        <nav className="nav" aria-label="Ana menü">
          {ROUTES.map((key) => {
            const { label, Icon } = NAV[key];
            const count = key === 'baglantilar' ? snapshot?.clients.length : undefined;
            return (
              <a key={key} href={`#/${key}`} className={`nav-item ${route === key ? 'is-on' : ''}`} aria-current={route === key ? 'page' : undefined}>
                <span className="nav-icon">
                  <Icon size={20} aria-hidden="true" />
                  {key === 'guvenlik' && paused && <span className="nav-dot" aria-hidden="true" />}
                </span>
                <span className="nav-label">{label}</span>
                {count ? <span className="nav-count" aria-label={`${count} bağlantı`}>{count}</span> : null}
                {key === 'guvenlik' && paused && <span className="sr-only"> (durduruldu)</span>}
              </a>
            );
          })}
        </nav>
        <div className="side-foot">
          <ThemeToggle />
          {snapshot && <span className="side-ver">v{snapshot.version}</span>}
        </div>
      </aside>

      <div className="stage">
        <div className="topbar"><Wordmark /><ThemeToggle /></div>
        {!online && (
          <div className="banner banner-offline" role="status">
            <WifiOff size={18} aria-hidden="true" />
            <span><b>Bağlantı koptu.</b> Neo Commander’a yeniden bağlanılıyor. Uygulama kapanmış olabilir.</span>
          </div>
        )}
        {paused && (
          <div className="banner banner-paused" role="status">
            <OctagonX size={18} aria-hidden="true" />
            <span><b>Acil durdur açık.</b> Hiçbir araç çalışmıyor.</span>
            <button type="button" className="btn btn-inverse btn-sm" onClick={() => void updateSettings({ paused: false }, { success: 'Devam ediliyor. Yapay zeka tekrar çalışabilir.' })}>Devam et</button>
          </div>
        )}
        <main className="main" id="main">{children}</main>
      </div>
    </div>
  );
}
