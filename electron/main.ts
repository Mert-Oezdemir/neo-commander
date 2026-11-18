// Neo Commander desktop shell: starts the server in-process, shows the panel in a window,
// lives in the tray (Windows) / menu bar (macOS).
import { app, BrowserWindow, clipboard, dialog, Menu, nativeImage, Notification, session, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { connectorUrl, isPanelUrl, isValidConnectorUrl, loadingPage, mayGrantPermission, mayOpenExternal, panelOrigin, portInUseMessage, shouldStartHidden } from './util.js';

type ServerModule = typeof import('../dist/server.js');
type RunningServer = import('../dist/server.js').RunningServer;

const APP_ID = 'dev.mertoezdemir.neocommander';
const isMac = process.platform === 'darwin';
const root = join(import.meta.dirname, '..');
const assets = join(root, 'assets');

/** What the tray needs from whatever is serving the panel (our own server or another Neo Commander instance). */
interface Controller {
  readonly port: number;
  /** true = we own the server in this process, so settings can be changed directly. */
  readonly own: boolean;
  connectorUrl(): Promise<string | null>;
  isPaused(): boolean | undefined;
  setPaused(paused: boolean): void;
  setAutostartFlag(enabled: boolean): void;
  close(): Promise<void>;
}

let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let controller: Controller | undefined;
let quitting = false;
let startedHidden = false;

// ---- tiny persistent flags (userData) ----
const flagsFile = () => join(app.getPath('userData'), 'desktop-flags.json');
function readFlags(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(flagsFile(), 'utf8')) as Record<string, unknown>; } catch { return {}; }
}
function writeFlag(key: string, value: unknown): void {
  try {
    mkdirSync(dirname(flagsFile()), { recursive: true });
    writeFileSync(flagsFile(), JSON.stringify({ ...readFlags(), [key]: value }));
  } catch { /* ignore */ }
}

function notify(title: string, body: string): void {
  try { if (Notification.isSupported()) new Notification({ title, body, icon: join(assets, 'icon.png') }).show(); } catch { /* ignore */ }
}

// ---- login item (auto start) ----
const canAutostart = () => app.isPackaged && (process.platform === 'win32' || isMac);
function loginItemEnabled(): boolean {
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
}
function applyLoginItem(enabled: boolean): { ok: boolean; message: string } {
  if (!canAutostart()) {
    return { ok: false, message: 'Otomatik başlatma yalnızca kurulu uygulamada kullanılabilir.' };
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: enabled ? ['--hidden'] : [] });
    return { ok: true, message: enabled ? 'Bilgisayar açılınca Neo Commander kendiliğinden başlayacak.' : 'Otomatik başlatma kapatıldı.' };
  } catch (e) {
    return { ok: false, message: `Otomatik başlatma ayarlanamadı: ${(e as Error).message}` };
  }
}

// ---- window ----
function lockDownWebContents(wc: Electron.WebContents, getPort: () => number): void {
  // External links: only when the page asking is the verified panel itself and the target is allowlisted.
  wc.setWindowOpenHandler(({ url }) => {
    if (mayOpenExternal(wc.getURL(), getPort(), url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Navigation away from the panel is blocked outright (never forwarded to the OS browser).
  const guard = (event: Electron.Event, url: string) => {
    if (isPanelUrl(url, getPort())) return;
    event.preventDefault();
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
  wc.on('will-attach-webview', (e) => e.preventDefault());
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'Neo Commander',
    backgroundColor: '#0b1220',
    icon: join(assets, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  lockDownWebContents(w.webContents, () => controller?.port ?? -1);
  w.once('ready-to-show', () => { if (!startedHidden) showWindow(); });
  w.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideWindow();
    if (!readFlags().trayNoticeShown) {
      writeFlag('trayNoticeShown', true);
      notify('Neo Commander çalışmaya devam ediyor',
        isMac ? 'Uygulama menü çubuğunda çalışıyor. Tamamen kapatmak için simgeye tıklayıp Çıkış\'ı seçin.'
          : 'Uygulama sistem tepsisinde çalışıyor. Tamamen kapatmak için simge üzerinde sağ tıklayıp Çıkış\'ı seçin.');
    }
  });
  w.webContents.on('did-fail-load', (_e, code, _d, url, isMainFrame) => {
    // Retry panel loads (server may still be warming up); ignore aborted (-3) navigations.
    if (isMainFrame && code !== -3 && controller && isPanelUrl(url, controller.port)) {
      setTimeout(() => { if (!w.isDestroyed()) void w.loadURL(url).catch(() => undefined); }, 1000);
    }
  });
  return w;
}

function showWindow(): void {
  if (!win || win.isDestroyed()) return;
  if (isMac) void app.dock?.show();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function hideWindow(): void {
  win?.hide();
  if (isMac) app.dock?.hide();
}

function openPanel(): void {
  if (!win || win.isDestroyed() || !controller) return;
  const url = `${panelOrigin(controller.port)}/panel`;
  if (!win.webContents.getURL().startsWith(url)) void win.loadURL(url).catch(() => undefined);
  showWindow();
}

// ---- tray ----
function trayImage(): Electron.NativeImage {
  if (isMac) {
    const img = nativeImage.createFromPath(join(assets, 'trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(join(assets, 'tray.png'));
}

let lastMenuKey = '';
async function refreshTrayMenu(force = false): Promise<void> {
  if (!tray || !controller) return;
  const c = controller;
  const link = await c.connectorUrl().catch(() => null);
  const paused = c.isPaused();
  const autostart = canAutostart() ? loginItemEnabled() : false;
  const key = JSON.stringify([link, paused, autostart]);
  if (!force && key === lastMenuKey) return;
  lastMenuKey = key;

  const items: MenuItemConstructorOptions[] = [
    { label: 'Paneli aç', click: () => openPanel() },
    {
      label: link ? 'Bağlantı linkini kopyala' : 'Bağlantı linkini kopyala (tünel hazırlanıyor…)',
      enabled: Boolean(link),
      click: () => {
        if (!link) return;
        if (!isValidConnectorUrl(link)) {
          notify('Bağlantı kopyalanmadı', 'Bağlantı adresi beklenen biçimde değil (https://…/mcp, IP adresi olmayan bir alan adı). Panelden kontrol edin.');
          return;
        }
        clipboard.writeText(link);
        notify('Bağlantı kopyalandı', 'Claude.ai → Ayarlar → Bağlayıcılar bölümüne yapıştırın.');
      },
    },
    c.own
      ? {
        label: 'Acil Durdur (tüm araç çağrılarını reddet)', type: 'checkbox', checked: Boolean(paused),
        click: (item) => { c.setPaused(item.checked); void refreshTrayMenu(true); },
      }
      : { label: 'Acil Durdur (panelden)', click: () => openPanel() },
    {
      label: 'Bilgisayar açılınca başlat', type: 'checkbox', checked: autostart, enabled: canAutostart() && c.own,
      click: (item) => {
        const r = applyLoginItem(item.checked);
        if (r.ok) c.setAutostartFlag(item.checked); else notify('Neo Commander', r.message);
        void refreshTrayMenu(true);
      },
    },
    { type: 'separator' },
    { label: 'Çıkış', click: () => { app.quit(); } },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray(): void {
  tray = new Tray(trayImage());
  tray.setToolTip('Neo Commander');
  if (!isMac) {
    tray.on('click', () => { if (win?.isVisible() && win.isFocused()) hideWindow(); else openPanel(); });
  }
  void refreshTrayMenu(true);
  const t = setInterval(() => { void refreshTrayMenu(); }, 2000);
  t.unref();
}

// ---- server ----
class OwnController implements Controller {
  readonly own = true;
  constructor(private server: RunningServer) {}
  get port() { return this.server.port; }
  async connectorUrl() { return connectorUrl(this.server.tunnel.publicUrl()); }
  isPaused() { return this.server.getSettings().paused; }
  setPaused(paused: boolean) { this.server.updateSettings({ paused }); }
  setAutostartFlag(enabled: boolean) { this.server.updateSettings({ autostart: enabled }); }
  close() { return this.server.close(); }
}

/** Another Neo Commander (e.g. started from the command line) already owns the port: just show its panel. */
class ExternalController implements Controller {
  readonly own = false;
  constructor(readonly port: number, private verify: () => Promise<boolean>) {}
  private async state(): Promise<{ connectorUrl?: string | null; paused?: boolean } | null> {
    try {
      // Re-prove identity every time: the verified instance may have exited and been replaced by a squatter.
      if (!(await this.verify())) return null;
      const r = await fetch(`http://127.0.0.1:${this.port}/panel/api/state`, { signal: AbortSignal.timeout(2000) });
      return r.ok ? ((await r.json()) as { connectorUrl?: string | null; paused?: boolean }) : null;
    } catch { return null; }
  }
  async connectorUrl() { return (await this.state())?.connectorUrl ?? null; }
  isPaused() { return undefined; }
  setPaused() { /* needs the panel's CSRF token: the tray opens the panel instead */ }
  setAutostartFlag() { /* not ours */ }
  async close() { /* not ours */ }
}

async function startNeo(): Promise<Controller> {
  const mod: ServerModule = await import('../dist/server.js');
  try {
    const server = await mod.startServer({
      openBrowser: false,
      installSignalHandlers: false,
      overrides: { setAutostart: (enabled) => applyLoginItem(enabled) },
    });
    return new OwnController(server);
  } catch (e) {
    if (e instanceof mod.PortInUseError) {
      // otherNeoCommander is only true when the listener answered the HMAC identity challenge.
      if (e.otherNeoCommander && e.stateDir) {
        const dir = e.stateDir; const port = e.port;
        return new ExternalController(port, () => mod.probeHealthz(port, dir));
      }
      throw new Error(portInUseMessage(e.port));
    }
    throw e;
  }
}

// ---- app lifecycle ----
function hardenSession(): void {
  const ses = session.defaultSession;
  // Deny every permission except the sanitized clipboard write used by the panel's "Kopyala" button,
  // and even that only for the verified panel origin.
  const port = () => controller?.port;
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(mayGrantPermission(permission, details.requestingUrl, port())));
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => mayGrantPermission(permission, requestingOrigin, port()));
  ses.setDevicePermissionHandler(() => false);
}

function setupMenu(): void {
  if (isMac) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (controller) openPanel(); else showWindow();
  });

  app.on('activate', () => { if (controller) openPanel(); else showWindow(); });
  app.on('window-all-closed', () => { /* stay alive in tray */ });

  app.on('before-quit', (e) => {
    if (quitting) return;
    quitting = true;
    if (!controller) return;
    e.preventDefault();
    const c = controller;
    controller = undefined;
    const done = () => { tray?.destroy(); app.exit(0); };
    const timer = setTimeout(done, 8000);
    void c.close().catch(() => undefined).finally(() => { clearTimeout(timer); done(); });
  });

  void app.whenReady().then(async () => {
    hardenSession();
    setupMenu();
    startedHidden = shouldStartHidden(process.argv, app.getLoginItemSettings() as { wasOpenedAsHidden?: boolean; wasOpenedAtLogin?: boolean });
    win = createWindow();
    void win.loadURL(loadingPage('Başlatılıyor…'));
    try {
      controller = await startNeo();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Neo Commander başlatılamadı:', e);
      showWindow();
      void win.loadURL(loadingPage(`Neo Commander başlatılamadı.\n\n${msg}`, true));
      dialog.showErrorBox('Neo Commander başlatılamadı', msg);
      return;
    }
    createTray();
    void win.loadURL(`${panelOrigin(controller.port)}/panel`);
    if (startedHidden && isMac) app.dock?.hide();
  });
}

// Fail visibly instead of silently dying in the background.
process.on('uncaughtException', (e) => { console.error('[uncaught]', e); });
process.on('unhandledRejection', (e) => { console.error('[unhandled]', e); });

