import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AutostartOptions {
  /** Override the Startup folder (tests). */
  startupDir?: string;
  platform?: NodeJS.Platform;
}

export function startupFilePath(startupDir: string): string {
  return join(startupDir, 'Neo Commander.cmd');
}

function defaultStartupDir(): string | undefined {
  const appdata = process.env.APPDATA;
  return appdata ? join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup') : undefined;
}

/** Windows only: create/remove a launcher in the user's Startup folder. */
export function setAutostart(enabled: boolean, appDir: string, opts: AutostartOptions = {}): { ok: boolean; message: string } {
  if ((opts.platform ?? process.platform) !== 'win32') return { ok: false, message: 'Otomatik başlatma şimdilik yalnızca Windows\'ta destekleniyor.' };
  const dir = opts.startupDir ?? defaultStartupDir();
  if (!dir) return { ok: false, message: 'Başlangıç klasörü bulunamadı (APPDATA tanımlı değil).' };
  const file = startupFilePath(dir);
  try {
    if (!enabled) {
      rmSync(file, { force: true });
      return { ok: true, message: 'Otomatik başlatma kapatıldı.' };
    }
    if (/["%\r\n&|<>^]/.test(appDir)) return { ok: false, message: 'Klasör yolunda desteklenmeyen karakter var.' };
    if (!existsSync(join(appDir, 'Neo-Commander.cmd'))) return { ok: false, message: 'Neo-Commander.cmd bu klasörde bulunamadı.' };
    mkdirSync(dir, { recursive: true });
    const body = [
      '@echo off',
      'rem Neo Commander otomatik baslatma (Neo Commander panelinden olusturuldu)',
      `cd /d "${appDir}"`,
      'set "NEO_NO_BROWSER=1"',
      'start "Neo Commander" /min cmd /c "Neo-Commander.cmd"',
      '',
    ].join('\r\n');
    writeFileSync(file, body);
    return { ok: true, message: 'Bilgisayar açılınca Neo Commander kendiliğinden başlayacak.' };
  } catch (e) {
    return { ok: false, message: `Otomatik başlatma ayarlanamadı: ${(e as Error).message}` };
  }
}
