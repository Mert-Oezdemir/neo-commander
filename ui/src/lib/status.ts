import type { Mode, Snapshot } from '../api/types';
import type { BeaconTone } from '../components/Beacon';
import { TUNNEL_LABEL } from './format';

export const MODE_LABEL: Record<Mode, string> = { full: 'Tam yetki', standard: 'Standart', readonly: 'Salt okunur' };

export interface HeroStatus { tone: BeaconTone; title: string; sub: string }

export function deriveStatus(s: Snapshot): HeroStatus {
  const { engine: e, tunnel: t } = s;
  const tunnelOk = t.state === 'online' || t.kind === 'none';
  if (s.paused) return { tone: 'paused', title: 'Durduruldu', sub: 'Acil durdur açık. Yapay zeka şu an hiçbir araç çalıştıramaz.' };
  if (e.state === 'error') return { tone: 'error', title: 'Sorun var', sub: e.message || 'Motor başlatılamadı. Uygulamayı yeniden başlatmayı deneyin.' };
  if (t.state === 'error') return { tone: 'error', title: 'Sorun var', sub: t.message || 'Bağlantı kurulamadı. Ayarlar’dan bağlantıyı yeniden başlatın.' };
  if (e.state === 'ready' && tunnelOk) {
    return { tone: 'ready', title: 'Hazır', sub: t.kind === 'none' ? 'Yalnızca bu bilgisayarda çalışıyor. Dışarıdan bağlantı kapalı.' : 'Yapay zeka bu bilgisayara bağlanabilir.' };
  }
  return { tone: 'starting', title: 'Hazırlanıyor…', sub: t.message || (e.state === 'starting' ? 'Motor başlıyor.' : 'Bağlantı kuruluyor.') };
}

export function engineLine(s: Snapshot): string {
  const e = s.engine;
  if (e.state === 'ready') return `${e.toolCount} araç hazır`;
  if (e.state === 'error') return 'Başlatılamadı';
  return 'Başlıyor';
}

export function tunnelLine(s: Snapshot): string {
  const t = s.tunnel;
  const name = TUNNEL_LABEL[t.kind];
  if (t.kind === 'none') return 'Kapalı';
  const st = t.state === 'online' ? 'çevrimiçi' : t.state === 'error' ? 'hata' : 'bağlanıyor';
  return `${name}, ${st}`;
}
