/**
 * PolicyEngine: the single gate every tool call passes through.
 *
 * SEATBELT, NOT A SANDBOX. Path and command guards are best-effort: shell commands
 * (start_process) can reach anywhere the OS user can, symlinks/junctions and 8.3 short names
 * are not resolved, and pattern lists can be evaded. The hard boundaries are the mode,
 * the kill switch, the OAuth gate and the fact that this is the owner's own machine.
 */
import type { Settings } from '../config.js';
import type { Risk } from '../tools/types.js';
import { checkCommand } from './commands.js';
import { isInsideAny } from './paths.js';
import { ENGINE_ALWAYS_DENIED, ENGINE_PATH_ARGS, ENGINE_RISK, MODE_RISKS, heuristicPathArgs } from './risk.js';

export interface ToolMeta { name: string; risk: Risk; pathArgs: string[]; source: 'engine' | 'own'; }
export type Decision = { ok: true; args: Record<string, unknown> } | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 30_000;

export class PolicyEngine {
  private protectedPaths: string[];
  constructor(private getSettings: () => Settings, protectedPaths: string[] = []) {
    this.protectedPaths = protectedPaths;
  }

  engineToolMeta(name: string, inputSchema?: unknown): ToolMeta {
    const risk = ENGINE_RISK[name] ?? 'exec';
    const pathArgs = ENGINE_PATH_ARGS[name] ?? (name in ENGINE_RISK ? [] : heuristicPathArgs(inputSchema));
    return { name, risk, pathArgs, source: 'engine' };
  }

  private hardBlocked(meta: ToolMeta): boolean {
    return (meta.source === 'engine' && ENGINE_ALWAYS_DENIED.has(meta.name)) || this.getSettings().blockedTools.includes(meta.name);
  }

  isVisible(meta: ToolMeta): boolean {
    // Paused tools stay listed (stable tool list for clients); calls are refused in check().
    if (this.hardBlocked(meta)) return false;
    return MODE_RISKS[this.getSettings().mode].has(meta.risk);
  }

  check(meta: ToolMeta, args: Record<string, unknown>, _clientId: string): Decision {
    const s = this.getSettings();
    if (s.paused) {
      return { ok: false, reason: 'Neo Commander duraklatıldı (kill switch açık). / Neo Commander is paused (kill switch is on); all tool calls are refused.' };
    }
    if (this.hardBlocked(meta)) {
      return { ok: false, reason: `"${meta.name}" bu sunucuda devre dışı. / "${meta.name}" is disabled on this server.` };
    }
    if (!MODE_RISKS[s.mode].has(meta.risk)) {
      return { ok: false, reason: `"${meta.name}" (${meta.risk}) "${s.mode}" modunda izinli değil. / "${meta.name}" (${meta.risk}) is not allowed in ${s.mode} mode.` };
    }

    // Path guard
    const restricted = s.allowedDirectories.length > 0;
    if (restricted && meta.source === 'engine' && meta.name === 'read_file' && args.isUrl === true) {
      return { ok: false, reason: 'URL okuma, izinli klasörler ayarlıyken kapalı. / Reading URLs is disabled while allowed directories are set.' };
    }
    for (const argName of meta.pathArgs) {
      const v = args[argName];
      if (v === undefined || v === null) continue;
      const list = Array.isArray(v) ? v : [v];
      for (const p of list) {
        if (typeof p !== 'string' || p.trim() === '') {
          return { ok: false, reason: `Geçersiz yol "${argName}". / Invalid path argument "${argName}".` };
        }
        if (this.protectedPaths.length > 0 && isInsideAny(p, this.protectedPaths, { base: process.cwd() })) {
          return { ok: false, reason: `"${argName}" Neo Commander'ın kendi durum klasöründe. / "${argName}" is inside Neo Commander's protected state directory.` };
        }
        if (restricted && !isInsideAny(p, s.allowedDirectories)) {
          return { ok: false, reason: `Yol izinli klasörlerin dışında: ${p} / Path is outside the allowed directories: ${p}` };
        }
      }
    }

    // Command guard
    if (meta.source === 'engine' && (meta.name === 'start_process' || meta.name === 'interact_with_process')) {
      const text = meta.name === 'start_process' ? args.command : args.input;
      if (typeof text === 'string') {
        const why = checkCommand(text, { protectedPaths: this.protectedPaths });
        if (why) return { ok: false, reason: `Komut engellendi: ${why}. / Command blocked: ${why}.` };
      }
    }

    // Normalization
    const out = { ...args };
    if (meta.source === 'engine' && meta.name === 'start_process') {
      const t = out.timeout_ms;
      if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) out.timeout_ms = DEFAULT_TIMEOUT_MS;
    }
    return { ok: true, args: out };
  }
}
