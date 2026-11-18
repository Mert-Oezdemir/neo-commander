import { EventEmitter } from 'node:events';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings, TunnelKind } from '../config.js';
import { downloadCloudflared, parseQuickTunnelUrl, resolveCloudflared } from './cloudflared.js';

export interface TunnelStatus {
  kind: TunnelKind;
  state: 'off' | 'starting' | 'online' | 'error';
  publicUrl?: string;
  message?: string;
  stable: boolean;
}

export interface TunnelManagerOptions {
  stateDir: string;
  port: number;
  getSettings: () => Settings;
  /** Test hooks. */
  cloudflaredPath?: string;
  healthCheck?: (url: string) => Promise<boolean>;
  healthTimeoutMs?: number;
  tailscalePath?: string;
  restartDelaysMs?: number[];
}

const liveChildren = new Set<ChildProcess>();
let exitHookInstalled = false;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
    } else {
      child.kill('SIGTERM');
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
      t.unref();
    }
  } catch { /* already gone */ }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const c of liveChildren) {
      if (c.pid === undefined) continue;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else c.kill('SIGKILL');
      } catch { /* ignore */ }
    }
  });
}

async function defaultHealthCheck(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
    return res.ok;
  } catch {
    return false;
  }
}

function run(file: string, args: string[], timeoutMs = 20000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout ?? ''}\n${stderr ?? ''}`.trim() + (err && !stdout && !stderr ? `\n${err.message}` : '') });
    });
  });
}

export function findTailscale(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists = existsSync): string | undefined {
  const name = platform === 'win32' ? 'tailscale.exe' : 'tailscale';
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of (env.PATH ?? env.Path ?? '').split(sep)) {
    if (dir.trim() && exists(join(dir.trim(), name))) return join(dir.trim(), name);
  }
  const extra = platform === 'win32'
    ? [join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', name), 'C:\\Program Files\\Tailscale\\tailscale.exe']
    : platform === 'darwin' ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'] : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
  return extra.find((p) => exists(p));
}

export class TunnelManager extends EventEmitter {
  private readonly opts: TunnelManagerOptions;
  private current: TunnelStatus = { kind: 'none', state: 'off', stable: false };
  private child?: ChildProcess;
  private generation = 0; // bumps on every start/stop; stale async work checks it
  private restartTimer?: NodeJS.Timeout;
  private tailscaleUsed?: string;

  constructor(opts: TunnelManagerOptions) {
    super();
    this.opts = opts;
    installExitHook();
  }

  status(): TunnelStatus { return { ...this.current }; }
  publicUrl(): string | undefined { return this.current.publicUrl; }

  private set(next: TunnelStatus): void {
    const urlChanged = next.publicUrl !== this.current.publicUrl;
    this.current = next;
    this.emit('status', this.status());
    if (urlChanged) this.emit('url', next.publicUrl);
  }

  async start(): Promise<void> {
    await this.stop();
    const gen = ++this.generation;
    const settings = this.opts.getSettings();
    const kind = settings.tunnel.kind;
    switch (kind) {
      case 'none':
        this.set({ kind, state: 'off', stable: false, message: 'Yalnızca bu bilgisayarda çalışıyor (tünel kapalı).' });
        return;
      case 'manual': {
        const url = normalizeUrl(settings.tunnel.publicUrl);
        if (!url) return this.set({ kind, state: 'error', stable: true, message: 'Elle girilen adres geçerli bir https:// adresi değil.' });
        return this.set({ kind, state: 'online', publicUrl: url, stable: true });
      }
      case 'cloudflare-quick':
        this.set({ kind, state: 'starting', stable: false, message: 'Tünel hazırlanıyor…' });
        void this.runCloudflared(gen, 'quick', 0);
        return;
      case 'cloudflare-named': {
        const url = normalizeUrl(settings.tunnel.publicUrl);
        if (!settings.tunnel.cloudflareToken) return this.set({ kind, state: 'error', stable: true, message: 'Cloudflare token girilmemiş.' });
        if (!url) return this.set({ kind, state: 'error', stable: true, message: 'Cloudflare tünelinin https:// adresi girilmemiş.' });
        this.set({ kind, state: 'starting', stable: true, publicUrl: url, message: 'Tünel hazırlanıyor…' });
        void this.runCloudflared(gen, 'named', 0);
        return;
      }
      case 'tailscale':
        this.set({ kind, state: 'starting', stable: true, message: 'Tailscale Funnel açılıyor…' });
        await this.startTailscale(gen);
        return;
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    const c = this.child;
    this.child = undefined;
    if (c) killTree(c);
    if (this.tailscaleUsed) {
      const ts = this.tailscaleUsed;
      this.tailscaleUsed = undefined;
      await run(ts, ['funnel', '--https=443', 'off'], 10000).catch(() => undefined);
    }
    if (this.current.state !== 'off' || this.current.publicUrl) {
      this.set({ kind: this.current.kind, state: 'off', stable: this.current.stable });
    }
  }

  // ---- cloudflared ----

  private async ensureCloudflared(gen: number): Promise<string | undefined> {
    if (this.opts.cloudflaredPath) return this.opts.cloudflaredPath;
    const binDir = join(this.opts.stateDir, 'bin');
    const found = resolveCloudflared({ binDir });
    if (found) return found;
    this.patch({ message: 'cloudflared indiriliyor (bir kereye mahsus)…' });
    try {
      const p = await downloadCloudflared({ binDir, onProgress: (m) => this.patch({ message: m }) });
      return gen === this.generation ? p : undefined;
    } catch (e) {
      if (gen === this.generation) this.fail(`cloudflared indirilemedi: ${(e as Error).message}`);
      return undefined;
    }
  }

  private patch(p: Partial<TunnelStatus>): void {
    this.set({ ...this.current, ...p });
  }

  private fail(message: string): void {
    this.set({ ...this.current, state: 'error', message, publicUrl: this.current.kind === 'cloudflare-quick' ? undefined : this.current.publicUrl });
  }

  private async runCloudflared(gen: number, mode: 'quick' | 'named', attempt: number): Promise<void> {
    const bin = await this.ensureCloudflared(gen);
    if (!bin || gen !== this.generation) return;
    const settings = this.opts.getSettings();
    const args = mode === 'quick'
      ? ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.opts.port}`]
      : ['tunnel', '--no-autoupdate', 'run', '--token', settings.tunnel.cloudflareToken ?? ''];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    liveChildren.add(child);
    let buf = '';
    let sawUrl = false;
    let connected = false;
    let lastErr = '';
    const onData = (d: Buffer): void => {
      if (gen !== this.generation) return;
      const text = d.toString('utf8');
      buf = (buf + text).slice(-8192);
      const lines = text.split(/\r?\n/).filter((l) => /\b(ERR|error|failed)\b/i.test(l));
      if (lines.length) lastErr = redact(lines[lines.length - 1]).slice(0, 300);
      if (mode === 'quick' && !sawUrl) {
        const url = parseQuickTunnelUrl(buf);
        if (url) { sawUrl = true; void this.waitHealthy(gen, url, () => attempt = 0); }
      } else if (mode === 'named' && !connected && /Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(text)) {
        connected = true;
        attempt = 0;
        this.set({ ...this.current, state: 'online', message: undefined });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (e) => { if (gen === this.generation) lastErr = e.message; });
    child.on('close', (code) => {
      liveChildren.delete(child);
      if (gen !== this.generation) return;
      this.child = undefined;
      const delays = this.opts.restartDelaysMs ?? [2000, 4000, 8000, 15000, 30000, 60000];
      const delay = delays[Math.min(attempt, delays.length - 1)];
      this.set({ ...this.current, state: 'error', publicUrl: mode === 'quick' ? undefined : this.current.publicUrl, message: `Tünel kapandı (kod ${code}). ${Math.round(delay / 1000)} sn sonra yeniden denenecek.${lastErr ? ' ' + lastErr : ''}` });
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (gen !== this.generation) return;
        this.set({ ...this.current, state: 'starting', message: 'Tünel yeniden başlatılıyor…' });
        void this.runCloudflared(gen, mode, attempt + 1);
      }, delay);
    });
  }

  private async waitHealthy(gen: number, url: string, onOk: () => void): Promise<void> {
    const check = this.opts.healthCheck ?? defaultHealthCheck;
    const deadline = Date.now() + (this.opts.healthTimeoutMs ?? 30000);
    this.patch({ message: 'Bağlantı doğrulanıyor…' });
    while (gen === this.generation && Date.now() < deadline) {
      if (await check(url).catch(() => false)) {
        if (gen !== this.generation) return;
        onOk();
        this.set({ kind: 'cloudflare-quick', state: 'online', publicUrl: url, stable: false });
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (gen !== this.generation) return;
    // never became reachable: drop the process; the close handler restarts with backoff
    this.patch({ message: 'Tünel adresi 30 sn içinde yanıt vermedi, yeniden deneniyor…' });
    if (this.child) killTree(this.child);
  }

  // ---- tailscale ----

  private async startTailscale(gen: number): Promise<void> {
    const ts = this.opts.tailscalePath ?? findTailscale();
    const bad = (message: string): void => { if (gen === this.generation) this.set({ kind: 'tailscale', state: 'error', stable: true, message }); };
    if (!ts) return bad('Tailscale bulunamadı. https://tailscale.com/download adresinden kurup giriş yapın, sonra tekrar deneyin.');
    const st = await run(ts, ['status', '--json']);
    if (gen !== this.generation) return;
    let dns: string | undefined;
    try {
      const j = JSON.parse(st.out.slice(st.out.indexOf('{'))) as { BackendState?: string; Self?: { DNSName?: string } };
      if (j.BackendState && j.BackendState !== 'Running') return bad(`Tailscale çalışmıyor (durum: ${j.BackendState}). Tailscale uygulamasında giriş yapın.`);
      dns = j.Self?.DNSName?.replace(/\.$/, '');
    } catch {
      return bad('Tailscale durumu okunamadı. Tailscale açık ve giriş yapılmış mı?');
    }
    if (!dns) return bad('Tailscale cihaz adı (DNSName) bulunamadı. Yönetim panelinde MagicDNS ve HTTPS sertifikalarını açın.');
    const fr = await run(ts, ['funnel', '--bg', String(this.opts.port)], 30000);
    if (gen !== this.generation) return;
    if (fr.code !== 0 || /not enabled|funnel.*(disabled|not allowed)|enable.*funnel|https.*not enabled/i.test(fr.out)) {
      const link = fr.out.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
      return bad(`Tailscale Funnel bu hesapta açık değil.${link ? ` Şu adresten açın: ${link}` : ' Tailscale yönetim panelinde HTTPS ve Funnel özelliğini etkinleştirin.'}`);
    }
    this.tailscaleUsed = ts;
    this.set({ kind: 'tailscale', state: 'online', publicUrl: `https://${dns}`, stable: true });
  }
}

export function normalizeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined;
  try {
    const url = new URL(u.trim());
    if (url.protocol !== 'https:') return undefined;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return undefined; }
}

function redact(s: string): string {
  return s.replace(/eyJ[A-Za-z0-9_\-.]{20,}/g, '[token]');
}
