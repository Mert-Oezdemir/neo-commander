import { RefreshCw, ServerCrash } from 'lucide-react';
import { AppShell } from './components/AppShell';
import { LogoMark } from './components/Logo';
import { ActivityPage } from './pages/ActivityPage';
import { ClientsPage } from './pages/ClientsPage';
import { ConnectPage } from './pages/ConnectPage';
import { SecurityPage } from './pages/SecurityPage';
import { SettingsPage } from './pages/SettingsPage';
import { useRoute } from './state/hooks';
import { useApp } from './state/store';

function Splash() {
  const { loadError, reload } = useApp();
  return (
    <div className="splash" role="status">
      <LogoMark size={56} />
      {loadError ? (
        <>
          <ServerCrash size={28} aria-hidden="true" />
          <h1 className="splash-title">Panele ulaşılamadı</h1>
          <p>{loadError} Neo Commander’ın çalıştığından emin olup tekrar deneyin.</p>
          <button type="button" className="btn btn-primary" onClick={() => void reload()}><RefreshCw size={18} aria-hidden="true" /> Tekrar dene</button>
        </>
      ) : (
        <p className="splash-title">Neo Commander açılıyor…</p>
      )}
    </div>
  );
}

export function App() {
  const { snapshot } = useApp();
  const route = useRoute();
  if (!snapshot) return <Splash />;
  return (
    <AppShell route={route}>
      {route === 'baglan' && <ConnectPage />}
      {route === 'etkinlik' && <ActivityPage />}
      {route === 'guvenlik' && <SecurityPage />}
      {route === 'baglantilar' && <ClientsPage />}
      {route === 'ayarlar' && <SettingsPage />}
    </AppShell>
  );
}
