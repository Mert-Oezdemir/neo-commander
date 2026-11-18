import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Mode = 'full' | 'standard' | 'readonly';
export type TunnelKind = 'none' | 'cloudflare-quick' | 'cloudflare-named' | 'tailscale' | 'manual';

export interface Settings {
  /** Which risk classes are allowed. See docs/ARCHITECTURE.md. */
  mode: Mode;
  /** Kill switch: refuse every tool call while true. */
  paused: boolean;
  /** File tools must stay inside these. Empty = whole disk. */
  allowedDirectories: string[];
  /** Local listen port (always bound to 127.0.0.1). */
  port: number;
  tunnel: {
    kind: TunnelKind;
    /** For kind=manual: the public HTTPS base URL. For cloudflare-named: its hostname URL. */
    publicUrl?: string;
    /** For cloudflare-named: the connector token from the Cloudflare dashboard. */
    cloudflareToken?: string;
  };
  /** Max tool calls per minute per OAuth client. */
  rateLimitPerMinute: number;
  /** Extra tool names to hide/refuse regardless of mode. */
  blockedTools: string[];
  /** Start automatically at Windows logon. */
  autostart: boolean;
}

export interface Secrets {
  /** HMAC key for access tokens (base64url, 48 bytes). */
  signingKey: string;
  /** Owner PIN typed on the consent page when connecting a new client. */
  ownerPin: string;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'full',
  paused: false,
  allowedDirectories: [],
  port: 8790,
  tunnel: { kind: 'cloudflare-quick' },
  rateLimitPerMinute: 240,
  blockedTools: [],
  autostart: false,
};

export function stateDir(): string {
  const override = process.env.NEO_HOME?.trim();
  const dir = override
    ? override
    : process.platform === 'win32' && process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'NeoCommander')
      : join(homedir(), '.neo-commander');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Atomic JSON write with owner-only permissions where the OS supports it. */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* windows: inherits profile ACL */ }
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** A PIN that is easy to type but not guessable at 5 tries/minute: 4 groups of 4 base32 chars. */
export function generatePin(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i] % alphabet.length];
    if (i % 4 === 3 && i < 15) out += '-';
  }
  return out;
}

export function loadSecrets(dir = stateDir()): Secrets {
  const path = join(dir, 'secrets.json');
  const existing = readJson<Partial<Secrets>>(path) ?? {};
  const secrets: Secrets = {
    signingKey: existing.signingKey && existing.signingKey.length >= 43 ? existing.signingKey : randomBytes(48).toString('base64url'),
    ownerPin: existing.ownerPin && existing.ownerPin.length >= 12 ? existing.ownerPin : generatePin(),
  };
  if (secrets.signingKey !== existing.signingKey || secrets.ownerPin !== existing.ownerPin) writeJsonAtomic(path, secrets);
  return secrets;
}

export function saveSecrets(secrets: Secrets, dir = stateDir()): void {
  writeJsonAtomic(join(dir, 'secrets.json'), secrets);
}

export function loadSettings(dir = stateDir()): Settings {
  const path = join(dir, 'settings.json');
  const raw = readJson<Partial<Settings>>(path);
  const merged: Settings = { ...DEFAULT_SETTINGS, ...(raw ?? {}), tunnel: { ...DEFAULT_SETTINGS.tunnel, ...(raw?.tunnel ?? {}) } };
  if (!['full', 'standard', 'readonly'].includes(merged.mode)) merged.mode = DEFAULT_SETTINGS.mode;
  if (!Number.isInteger(merged.port) || merged.port < 1024 || merged.port > 65535) merged.port = DEFAULT_SETTINGS.port;
  if (!raw) writeJsonAtomic(path, merged);
  return merged;
}

export function saveSettings(settings: Settings, dir = stateDir()): void {
  writeJsonAtomic(join(dir, 'settings.json'), settings);
}
