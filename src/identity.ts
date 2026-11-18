// Instance identity proof. Anybody can bind our port first and answer /healthz with {"ok":true}.
// To tell "another Neo Commander" from a squatter, the running server publishes a random key in
// <stateDir>/instance.json (0600) and answers HMAC(key, nonce) on a loopback-only endpoint.
// Only a process that can read the state directory (i.e. the same OS user) can verify, and a
// squatter that cannot read the key cannot forge the MAC.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './config.js';

export interface InstanceInfo { instanceKey: string; port: number; pid: number }

export const instanceFile = (dir: string): string => join(dir, 'instance.json');
const NONCE_RE = /^[0-9a-f]{16,128}$/;

export function isValidNonce(nonce: unknown): nonce is string {
  return typeof nonce === 'string' && NONCE_RE.test(nonce);
}

export function computeMac(instanceKey: string, nonce: string): string {
  return createHmac('sha256', Buffer.from(instanceKey, 'hex')).update(nonce).digest('hex');
}

/** Creates a fresh key and writes instance.json atomically (0600). Call only after the port is bound. */
export function writeInstanceFile(dir: string, port: number): InstanceInfo {
  const info: InstanceInfo = { instanceKey: randomBytes(32).toString('hex'), port, pid: process.pid };
  writeJsonAtomic(instanceFile(dir), info);
  return info;
}

export function readInstanceFile(dir: string): InstanceInfo | undefined {
  try {
    const j = JSON.parse(readFileSync(instanceFile(dir), 'utf8')) as Partial<InstanceInfo>;
    if (typeof j.instanceKey === 'string' && /^[0-9a-f]{64}$/.test(j.instanceKey) && Number.isInteger(j.port)) {
      return { instanceKey: j.instanceKey, port: j.port as number, pid: Number(j.pid) || 0 };
    }
  } catch { /* missing or corrupt */ }
  return undefined;
}

/** Removes instance.json, but only if it still holds OUR key (never delete another instance's file). */
export function removeInstanceFile(dir: string, info: InstanceInfo): void {
  try {
    if (readInstanceFile(dir)?.instanceKey === info.instanceKey) unlinkSync(instanceFile(dir));
  } catch { /* ignore */ }
}

/**
 * Is the program listening on 127.0.0.1:<port> really a Neo Commander using this state directory?
 * Sends a fresh random nonce and checks the MAC in constant time.
 */
export async function verifyInstance(port: number, dir: string): Promise<boolean> {
  try {
    const info = readInstanceFile(dir);
    if (!info || info.port !== port) return false;
    const nonce = randomBytes(16).toString('hex');
    const r = await fetch(`http://127.0.0.1:${port}/healthz/identity?nonce=${nonce}`, {
      signal: AbortSignal.timeout(2000), redirect: 'manual',
    });
    if (!r.ok) return false;
    const j = (await r.json()) as { mac?: unknown };
    if (typeof j.mac !== 'string' || !/^[0-9a-f]{64}$/.test(j.mac)) return false;
    return timingSafeEqual(Buffer.from(j.mac, 'hex'), Buffer.from(computeMac(info.instanceKey, nonce), 'hex'));
  } catch {
    return false;
  }
}
