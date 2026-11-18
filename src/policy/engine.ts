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
import path from 'node:path';
import { expandTilde, isInsideAny, isWindowsStyle, realCandidates, realContains, realRoots } from './paths.js';
import { ENGINE_ALWAYS_DENIED, ENGINE_PATH_ARGS, ENGINE_RECURSIVE_ARGS, ENGINE_RISK, MODE_RISKS, heuristicPathArgs } from './risk.js';

export interface ToolMeta {
  name: string; risk: Risk; pathArgs: string[]; source: 'engine' | 'own';
  /** Path args whose value is a recursion ROOT (search / deep listing): denied if it contains a protected path. */
  recursiveArgs?: string[];
  /** Own tools: args that are command text (checked like start_process); the first one is also path-checked if it looks like a path. */
  commandArgs?: string[];
}
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
    const recursiveArgs = ENGINE_RECURSIVE_ARGS[name];
    return { name, risk, pathArgs, source: 'engine', ...(recursiveArgs ? { recursiveArgs } : {}) };
  }

  private hardBlocked(meta: ToolMeta): boolean {
    return (meta.source === 'engine' && ENGINE_ALWAYS_DENIED.has(meta.name)) || this.getSettings().blockedTools.includes(meta.name);
  }

  isVisible(meta: ToolMeta): boolean {
    // Paused tools stay listed (stable tool list for clients); calls are refused in check().
    if (this.hardBlocked(meta)) return false;
    return MODE_RISKS[this.getSettings().mode].has(meta.risk);
  }

  /** protectedPaths + allowedDirectories checks for one path value: lexical first, then real-path (symlink/junction/8.3). */
  private checkPath(argName: string, p: string, restricted: boolean, allowed: string[]): Decision | undefined {
    const protectedMsg: Decision = { ok: false, reason: `"${argName}" Neo Commander'ın kendi durum klasöründe. / "${argName}" is inside Neo Commander's protected state directory.` };
    if (this.protectedPaths.length > 0) {
      if (isInsideAny(p, this.protectedPaths, { base: process.cwd() })) return protectedMsg;
      // Real-path: protected dirs are resolved at check time (they may be reached through junctions or 8.3 names).
      const prot = realRoots(this.protectedPaths);
      if (prot.length > 0 && realCandidates(p, process.cwd()).some((c) => prot.some((r) => realContains(r, c)))) return protectedMsg;
    }
    if (restricted) {
      const outside: Decision = { ok: false, reason: `Yol izinli klasörlerin dışında: ${p} / Path is outside the allowed directories: ${p}` };
      if (!isInsideAny(p, allowed)) return outside;
      // Every real-path reading of p must stay inside a real allowed dir (a link inside the allowed dir may point out of it).
      const roots = realRoots(allowed);
      const cands = realCandidates(p, allowed.find((d) => !isWindowsStyle(expandTilde(d))) ?? process.cwd());
      if (roots.length > 0 && cands.length > 0 && !cands.every((c) => roots.some((r) => realContains(r, c)))) return outside;
    }
    return undefined;
  }

  /** Would a recursive walk rooted at `p` reach a protected path (p is an ancestor of, or equal to, one)? */
  private coversProtected(p: string): boolean {
    if (this.protectedPaths.length === 0) return false;
    const t = expandTilde(p.trim());
    const abs = isWindowsStyle(t) || path.isAbsolute(t) ? t : path.resolve(process.cwd(), t);
    if (this.protectedPaths.some((pp) => isInsideAny(pp, [abs], { base: process.cwd() }))) return true;
    const prot = realRoots(this.protectedPaths);
    return realCandidates(p, process.cwd()).some((c) => prot.some((r) => realContains(c, r)));
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
        const denied = this.checkPath(argName, p, restricted, s.allowedDirectories);
        if (denied) return denied;
        // Recursive tools (content search, deep listing) must not be rooted at an ancestor of the state dir.
        // list_directory is only non-recursive with an explicit depth of 1 (upstream default is 2).
        const recursive = meta.recursiveArgs?.includes(argName) && !(meta.name === 'list_directory' && args.depth === 1);
        if (recursive && this.coversProtected(p)) {
          return { ok: false, reason: `"${argName}" Neo Commander'ın durum klasörünü kapsıyor; daha dar bir klasörde arayın/listeleyin. / "${argName}" contains Neo Commander's protected state directory; search or list a narrower folder instead.` };
        }
      }
    }

    // Own tools whose args are command text (e.g. desktop_open target + args)
    if (meta.source === 'own' && meta.commandArgs?.length) {
      const parts: string[] = [];
      for (const name of meta.commandArgs) {
        const v = args[name];
        if (typeof v === 'string') parts.push(v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') parts.push(x);
      }
      const why = checkCommand(parts.join(' '), { protectedPaths: this.protectedPaths });
      if (why) return { ok: false, reason: `Komut engellendi: ${why}. / Command blocked: ${why}.` };
      const first = args[meta.commandArgs[0]!];
      if (typeof first === 'string' && looksLikePath(first)) {
        const denied = this.checkPath(meta.commandArgs[0]!, first, restricted, s.allowedDirectories);
        if (denied) return denied;
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

/** Does a command-ish target look like a filesystem path (vs. a URL or bare app name)? */
export function looksLikePath(t: string): boolean {
  return /^[a-zA-Z]:/.test(t) || t.startsWith('\\\\') || t.startsWith('.') || t.startsWith('/') || t.startsWith('~') || t.includes('\\');
}
