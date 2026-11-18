import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redact.js';

export interface AuditEntry {
  ts: string; clientId: string; tool: string; source: 'engine' | 'own'; ok: boolean;
  decision: 'allowed' | 'denied' | 'error'; reason?: string; durationMs?: number; argsPreview: unknown;
}

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;
const RING = 500;

export class AuditLog extends EventEmitter {
  private file: string;
  private ring: AuditEntry[] = []; // newest first
  private size = 0;

  constructor(stateDir: string) {
    super();
    mkdirSync(stateDir, { recursive: true });
    this.file = join(stateDir, 'audit.jsonl');
    try { this.size = existsSync(this.file) ? statSync(this.file).size : 0; } catch { this.size = 0; }
    this.loadTail();
  }

  private readLines(path: string): AuditEntry[] {
    try {
      if (!existsSync(path)) return [];
      const out: AuditEntry[] = [];
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line) as AuditEntry); } catch { /* skip torn line */ }
      }
      return out;
    } catch { return []; }
  }

  private loadTail(): void {
    let entries = this.readLines(this.file);
    for (let i = 1; entries.length < RING && i <= KEEP; i++) entries = this.readLines(`${this.file}.${i}`).concat(entries);
    this.ring = entries.slice(-RING).reverse();
  }

  private rotate(): void {
    try {
      rmSync(`${this.file}.${KEEP}`, { force: true });
      for (let i = KEEP - 1; i >= 1; i--) if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
      renameSync(this.file, `${this.file}.1`);
      this.size = 0;
    } catch (e) { console.error('[audit] rotate failed', e); }
  }

  record(e: Omit<AuditEntry, 'ts' | 'argsPreview'> & { args: unknown }): void {
    const { args, ...rest } = e;
    const entry: AuditEntry = { ts: new Date().toISOString(), ...rest, argsPreview: redact(args) };
    const line = JSON.stringify(entry) + '\n';
    try {
      if (this.size + Buffer.byteLength(line) > MAX_BYTES) this.rotate();
      appendFileSync(this.file, line, { mode: 0o600 });
      this.size += Buffer.byteLength(line);
    } catch (err) { console.error('[audit] write failed', err); }
    this.ring.unshift(entry);
    if (this.ring.length > RING) this.ring.length = RING;
    this.emit('entry', entry);
  }

  recent(limit = 100): AuditEntry[] {
    return this.ring.slice(0, Math.max(0, Math.min(limit, RING)));
  }
}
