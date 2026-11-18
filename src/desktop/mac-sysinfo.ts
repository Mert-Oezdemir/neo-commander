/** Parsers for macOS command output used by desktop_system_info (pure, unit-tested with fixtures). */
import { basename } from 'node:path';

export function parseSwVers(out: string): { name: string; version: string; build: string } {
  const get = (k: string): string => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(out)?.[1]?.trim() ?? '';
  return { name: get('ProductName') || 'macOS', version: get('ProductVersion'), build: get('BuildVersion') };
}

/** `vm_stat`: available memory ~ free + inactive + speculative (+ purgeable) pages. Returns MB. */
export function parseVmStat(out: string): { freeMB: number; pageSize: number } {
  const ps = /page size of (\d+) bytes/.exec(out);
  const pageSize = ps ? Number(ps[1]) : 4096;
  const pages = (label: string): number => {
    const m = new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(out);
    return m ? Number(m[1]) : 0;
  };
  const avail = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
  return { freeMB: Math.round((avail * pageSize) / 1048576), pageSize };
}

export interface DiskInfo {
  drive: string;
  label: string;
  totalGB: number;
  freeGB: number;
}

const SKIP_MOUNT = /^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware)$|^\/private\/var\/vm|^\/Library\/Developer\/CoreSimulator/;

/**
 * `df -k` (1024-byte blocks). Shows real volumes only: on APFS the sealed system volume "/" is tiny and shares a
 * container with "/System/Volumes/Data", so the Data volume's size/free (container-wide) is reported as "/".
 */
export function parseDf(out: string): DiskInfo[] {
  const lines = out.split(/\r?\n/).slice(1).filter((l) => l.trim().length > 0);
  const rows: { dev: string; total: number; avail: number; mount: string }[] = [];
  for (const l of lines) {
    // Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s+\d+\s+\d+\s+\S+\s+(\/.*)$/.exec(l.trim());
    if (!m) continue;
    const dev = m[1] as string;
    if (!dev.startsWith('/dev/')) continue;
    rows.push({ dev, total: Number(m[2]), avail: Number(m[4]), mount: m[5] as string });
  }
  const data = rows.find((r) => r.mount === '/System/Volumes/Data');
  const out2: DiskInfo[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (SKIP_MOUNT.test(r.mount)) continue;
    let { total, avail } = r;
    const mount = r.mount;
    if (r.mount === '/System/Volumes/Data') continue; // folded into "/"
    if (r.mount === '/' && data) {
      total = data.total;
      avail = data.avail;
    }
    if (seen.has(mount)) continue;
    seen.add(mount);
    out2.push({
      drive: mount,
      label: mount === '/' ? 'Macintosh HD' : basename(mount),
      totalGB: Math.round((total / 1048576) * 10) / 10,
      freeGB: Math.round((avail / 1048576) * 10) / 10,
    });
  }
  if (out2.length === 0 && data) {
    out2.push({ drive: '/', label: 'Macintosh HD', totalGB: Math.round((data.total / 1048576) * 10) / 10, freeGB: Math.round((data.avail / 1048576) * 10) / 10 });
  }
  return out2;
}

export interface Battery {
  percent: number;
  charging: boolean;
  status: string;
}

/** `pmset -g batt`; null on desktops without an internal battery. */
export function parsePmsetBatt(out: string): Battery | null {
  const m = /(\d+)%;\s*([^;]+);/.exec(out);
  if (!m || !/InternalBattery/.test(out)) return null;
  const status = (m[2] as string).trim();
  return { percent: Number(m[1]), charging: /^(charging|finishing charge|charged|AC attached)/i.test(status), status };
}

export interface ProcInfo {
  pid: number;
  cpu: number;
  rssKB: number;
  name: string;
}

/** `ps -Ao pid=,pcpu=,rss=,comm=`; comm is the full executable path (may contain spaces). */
export function parsePs(out: string): ProcInfo[] {
  const procs: ProcInfo[] = [];
  for (const l of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+?)\s*$/.exec(l);
    if (!m) continue;
    procs.push({ pid: Number(m[1]), cpu: Number(m[2]), rssKB: Number(m[3]), name: basename(m[4] as string) });
  }
  return procs;
}

export function topByCpu(p: ProcInfo[], n = 10): { name: string; pid: number; cpuPercent: number; memoryMB: number }[] {
  return [...p]
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, n)
    .map((x) => ({ name: x.name, pid: x.pid, cpuPercent: Math.round(x.cpu), memoryMB: Math.round(x.rssKB / 1024) }));
}

export function topByMemory(p: ProcInfo[], n = 10): { name: string; pid: number; memoryMB: number }[] {
  return [...p]
    .sort((a, b) => b.rssKB - a.rssKB)
    .slice(0, n)
    .map((x) => ({ name: x.name, pid: x.pid, memoryMB: Math.round(x.rssKB / 1024) }));
}

/** `ifconfig`: IPv4 addresses per interface, without loopback / link-local. */
export function parseIfconfig(out: string): { adapter: string; ipv4: string }[] {
  const res: { adapter: string; ipv4: string }[] = [];
  let cur = '';
  for (const l of out.split(/\r?\n/)) {
    const h = /^([A-Za-z0-9_.-]+):\s+flags=/.exec(l);
    if (h) {
      cur = h[1] as string;
      continue;
    }
    const m = /^\s+inet\s+(\d+\.\d+\.\d+\.\d+)\s/.exec(l);
    if (m && cur) {
      const ip = m[1] as string;
      if (ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      res.push({ adapter: cur, ipv4: ip });
    }
  }
  return res;
}

/** `sysctl -n kern.boottime` -> uptime seconds. */
export function parseBoottime(out: string, nowSec = Math.floor(Date.now() / 1000)): number | null {
  const m = /sec\s*=\s*(\d+)/.exec(out);
  return m ? Math.max(0, nowSec - Number(m[1])) : null;
}
