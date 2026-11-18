// Pure helpers (no electron import) so they can be unit-tested with node:test.
import { isIP } from 'node:net';

/** Origin of the local panel, e.g. http://127.0.0.1:8787 */
export function panelOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Same origin as the panel? (127.0.0.1 or localhost on the panel port, http only). */
export function isPanelUrl(url: string, port: number): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && u.port === String(port);
  } catch {
    return false;
  }
}

/** Only https URLs may be handed to the OS browser (no file:, javascript:, custom schemes). */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname.length > 0 && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** MCP connector URL for Claude.ai from the current public tunnel URL. */
export function connectorUrl(publicUrl: string | undefined | null): string | null {
  if (!publicUrl) return null;
  return `${publicUrl.replace(/\/+$/, '')}/mcp`;
}

/**
 * True when the app was launched by the OS login item (start hidden to the tray).
 * Windows: we register the login item with `--hidden`. macOS: Electron >= 38 has no
 * "open as hidden" login item, so a login launch (`wasOpenedAtLogin`) starts hidden.
 */
export function shouldStartHidden(
  argv: string[],
  loginItem: { wasOpenedAsHidden?: boolean; wasOpenedAtLogin?: boolean },
  platform: NodeJS.Platform = process.platform,
): boolean {
  return argv.includes('--hidden') || Boolean(loginItem.wasOpenedAsHidden) || (platform === 'darwin' && Boolean(loginItem.wasOpenedAtLogin));
}

export function loadingPage(message: string, isError = false): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const esc = message.replace(/[&<>"]/g, (c) => map[c] ?? c);
  const html = `<!doctype html><meta charset="utf-8"><title>Neo Commander</title>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1220;color:#e5edf7;font:16px system-ui,sans-serif">
<div style="text-align:center;max-width:560px;padding:24px"><div style="font-size:22px;font-weight:600;margin-bottom:12px">Neo Commander</div>
<div style="${isError ? 'color:#fca5a5;' : 'opacity:.8;'}white-space:pre-wrap">${esc}</div></div></body>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

/** Exact-origin check: is `url` served from the verified panel origin (http://127.0.0.1:<port>)? */
export function isVerifiedPanelOrigin(url: string, port: number | undefined): boolean {
  if (port === undefined || port < 0) return false;
  try { return new URL(url).origin === panelOrigin(port); } catch { return false; }
}

/** Hosts the panel may hand to the OS browser (exact match, no subdomain wildcards). */
export const EXTERNAL_HOST_ALLOWLIST: ReadonlySet<string> = new Set([
  'claude.ai', 'claude.com', 'support.claude.com',
  'chatgpt.com', 'openai.com', 'help.openai.com',
  'github.com',
  'tailscale.com', 'login.tailscale.com',
  'developers.cloudflare.com', 'dash.cloudflare.com',
  'geminicli.com',
]);

/** https only, no credentials, default port, host on the allowlist. */
export function isAllowedExternalUrl(url: string): boolean {
  if (!isSafeExternalUrl(url)) return false;
  const u = new URL(url);
  return u.port === '' && EXTERNAL_HOST_ALLOWLIST.has(u.hostname.toLowerCase());
}

/** shell.openExternal gate: the asking page must be the verified panel AND the target allowlisted. */
export function mayOpenExternal(senderUrl: string, panelPort: number | undefined, target: string): boolean {
  return isVerifiedPanelOrigin(senderUrl, panelPort) && isAllowedExternalUrl(target);
}

/** Only the sanitized clipboard write is ever granted, and only to the verified panel origin. */
export function mayGrantPermission(permission: string, requestingUrl: string, panelPort: number | undefined): boolean {
  return permission === 'clipboard-sanitized-write' && isVerifiedPanelOrigin(requestingUrl, panelPort);
}

/** A connector link we are willing to put on the clipboard: https://<hostname>/mcp, hostname not an IP literal. */
export function isValidConnectorUrl(link: string | null | undefined): link is string {
  if (!link) return false;
  try {
    const u = new URL(link);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return false;
    if (!u.pathname.endsWith('/mcp')) return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    return host.length > 0 && isIP(host) === 0;
  } catch {
    return false;
  }
}

export function portInUseMessage(port: number): string {
  return `${port} numaralı port başka bir program tarafından kullanılıyor (Neo Commander olarak doğrulanamadı). `
    + `Programı kapatın veya settings.json dosyasındaki "port" değerini değiştirerek farklı bir port seçin.`;
}
