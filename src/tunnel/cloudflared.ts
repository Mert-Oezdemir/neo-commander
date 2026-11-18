import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Pinned cloudflared release. Bump together with PINNED_SHA256.
 * Hashes copied from the 2026.10.4 release notes; the windows-amd64 hash was
 * independently verified by downloading and hashing the asset on Windows (2026-11-18).
 * For an unpinned version, integrity falls back to the release-notes hash (GitHub API).
 * Use scripts/pin-cloudflared.mjs to regenerate when bumping.
 */
export const CLOUDFLARED_VERSION = '2026.10.4';

/** asset name -> lowercase hex sha256. Fill with `node scripts/pin-cloudflared.mjs`. */
export const PINNED_SHA256: Record<string, string> = {
  'cloudflared-windows-amd64.exe': '411b16d40c8d872243efeb52c550053d00af0a8a97fbb32e730fb8aba429eaa8',
  'cloudflared-windows-386.exe': '6d38146a071184959adde89c299e87132d89777ee5318dcb066e6fac861ec63c',
  'cloudflared-linux-amd64': 'ae5e8add7884b0531d66bbca4570d1de491ff6da51e4ebe7eb160cdf241d9e42',
  'cloudflared-linux-arm64': '2b7203b4fb0ba28a0c1e12f8855ce2c25f76d266a8d5edafac5540b6812acff6',
  'cloudflared-darwin-amd64.tgz': 'fdec0f9a1c726f4c10283fc0cd70e602d510c72887b737270433c81a08c883a9',
  'cloudflared-darwin-arm64.tgz': '49e7963072b2ca83fb44c09f4d4a7cda52d390c0c9c6f55bac83454a5bc43910',
};

export function assetName(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const a = arch === 'arm64' ? 'arm64' : arch === 'ia32' ? '386' : 'amd64';
  if (platform === 'win32') return `cloudflared-windows-${a === 'arm64' ? 'amd64' : a}.exe`; // arm64 Windows runs amd64 via emulation
  if (platform === 'darwin') return `cloudflared-darwin-${a === '386' ? 'amd64' : a}.tgz`;
  return `cloudflared-linux-${a}`;
}

export function downloadUrl(asset: string, version = CLOUDFLARED_VERSION): string {
  return `https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset}`;
}

export function binaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

/** Ordered candidate locations (first existing wins). */
export function candidatePaths(opts: { binDir: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }): string[] {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const name = binaryName(platform);
  const out: string[] = [join(opts.binDir, name)];
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (dir.trim()) out.push(join(dir.trim().replace(/^"|"$/g, ''), name));
  }
  if (platform === 'win32') {
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    out.push(join(pf86, 'cloudflared', name), join(pf, 'cloudflared', name));
    if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', name));
  }
  return out;
}

export function resolveCloudflared(opts: { binDir: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean }): string | undefined {
  const exists = opts.exists ?? existsSync;
  return candidatePaths(opts).find((p) => exists(p));
}

const QUICK_URL = /https:\/\/([a-z0-9][a-z0-9-]*)\.trycloudflare\.com/gi;

/** Extract the quick-tunnel URL from cloudflared output. Ignores api.trycloudflare.com (appears in error text). */
export function parseQuickTunnelUrl(text: string): string | undefined {
  for (const m of text.matchAll(QUICK_URL)) {
    if (m[1].toLowerCase() !== 'api') return m[0].toLowerCase();
  }
  return undefined;
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export class HashMismatchError extends Error {}

export function verifyHash(data: Uint8Array, expectedHex: string): void {
  const actual = sha256Hex(data);
  if (actual !== expectedHex.trim().toLowerCase()) throw new HashMismatchError(`SHA-256 uyuşmuyor (beklenen ${expectedHex}, gelen ${actual})`);
}

/** Find "<asset> ... <64 hex>" (either order) in release notes body. */
export function hashFromReleaseBody(body: string, asset: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes(asset)) continue;
    // avoid matching e.g. "cloudflared-linux-amd64.deb" when asset is "cloudflared-linux-amd64"
    const idx = line.indexOf(asset);
    const next = line[idx + asset.length];
    if (next && /[A-Za-z0-9.\-_]/.test(next)) continue;
    const m = line.match(/\b[a-fA-F0-9]{64}\b/);
    if (m) return m[0].toLowerCase();
  }
  return undefined;
}

export interface DownloadOptions {
  binDir: string;
  version?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  fetchImpl?: typeof fetch;
  pinned?: Record<string, string>;
  onProgress?: (msg: string) => void;
}

async function expectedHash(asset: string, version: string, pinned: Record<string, string>, f: typeof fetch): Promise<string> {
  if (version === CLOUDFLARED_VERSION && pinned[asset]) return pinned[asset];
  const res = await f(`https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${version}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'neo-commander' } });
  if (!res.ok) throw new Error(`Sürüm özeti alınamadı (HTTP ${res.status}); doğrulama yapılamadığı için indirme iptal edildi.`);
  const json = (await res.json()) as { body?: string };
  const h = hashFromReleaseBody(json.body ?? '', asset);
  if (!h) throw new Error(`Sürüm notlarında ${asset} için SHA-256 bulunamadı; indirme iptal edildi.`);
  return h;
}

/** Minimal tar.gz extraction of the single `cloudflared` file (macOS asset). */
async function extractTgz(buf: Buffer): Promise<Buffer> {
  const { gunzipSync } = await import('node:zlib');
  const tar = gunzipSync(buf);
  let off = 0;
  while (off + 512 <= tar.length) {
    const name = tar.subarray(off, off + 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) break;
    const size = parseInt(tar.subarray(off + 124, off + 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    if (name.replace(/^\.\//, '') === 'cloudflared') return Buffer.from(tar.subarray(off + 512, off + 512 + size));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error('Arşivde cloudflared bulunamadı');
}

/** Download + verify + install cloudflared into binDir. Returns the final path. */
export async function downloadCloudflared(opts: DownloadOptions): Promise<string> {
  const version = opts.version ?? CLOUDFLARED_VERSION;
  const platform = opts.platform ?? process.platform;
  const f = opts.fetchImpl ?? fetch;
  const asset = assetName(platform, opts.arch);
  opts.onProgress?.(`cloudflared ${version} indiriliyor…`);
  const expected = await expectedHash(asset, version, opts.pinned ?? PINNED_SHA256, f);
  const res = await f(downloadUrl(asset, version), { headers: { 'user-agent': 'neo-commander' } });
  if (!res.ok) throw new Error(`cloudflared indirilemedi (HTTP ${res.status})`);
  const data = Buffer.from(await res.arrayBuffer());
  verifyHash(data, expected); // verify the downloaded bytes before anything touches disk
  const payload = asset.endsWith('.tgz') ? await extractTgz(data) : data;
  mkdirSync(opts.binDir, { recursive: true });
  const finalPath = join(opts.binDir, binaryName(platform));
  const tmp = `${finalPath}.${process.pid}.download`;
  try {
    writeFileSync(tmp, payload, { mode: 0o755 });
    if (platform !== 'win32') chmodSync(tmp, 0o755);
    renameSync(tmp, finalPath);
  } finally {
    rmSync(tmp, { force: true });
  }
  return finalPath;
}
