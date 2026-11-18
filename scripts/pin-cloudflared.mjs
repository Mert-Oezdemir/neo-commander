#!/usr/bin/env node
// Usage: node scripts/pin-cloudflared.mjs [version]
// Downloads the cloudflared release assets we support, hashes them, cross-checks against the hashes
// Cloudflare publishes in the release notes, and prints the PINNED_SHA256 table for src/tunnel/cloudflared.ts.
import { createHash } from 'node:crypto';

const version = process.argv[2] ?? '2025.11.1';
const assets = ['cloudflared-windows-amd64.exe', 'cloudflared-windows-386.exe', 'cloudflared-linux-amd64', 'cloudflared-linux-arm64', 'cloudflared-darwin-amd64.tgz', 'cloudflared-darwin-arm64.tgz'];
const rel = await (await fetch(`https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${version}`, { headers: { 'user-agent': 'neo-commander' } })).json();
const body = rel.body ?? '';
const out = {};
for (const a of assets) {
  const res = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${version}/${a}`, { headers: { 'user-agent': 'neo-commander' } });
  if (!res.ok) { console.error(`${a}: HTTP ${res.status}`); continue; }
  const h = createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex');
  const line = body.split(/\r?\n/).find((l) => l.includes(a) && l.toLowerCase().includes(h));
  console.error(`${a}: ${h} ${line ? '(matches release notes)' : '(NOT found in release notes!)'}`);
  out[a] = h;
}
console.log(`export const CLOUDFLARED_VERSION = '${version}';`);
console.log('export const PINNED_SHA256: Record<string, string> = ' + JSON.stringify(out, null, 2) + ';');
