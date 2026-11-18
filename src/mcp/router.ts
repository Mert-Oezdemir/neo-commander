import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Risk, ToolDef } from '../tools/types.js';
import { textResult } from '../tools/types.js';

// Structural views of the policy/engine modules so this file does not depend on their internals.
export interface ToolMetaLike { name: string; risk: Risk; pathArgs: string[]; source: 'engine' | 'own' }
export type DecisionLike = { ok: true; args: Record<string, unknown> } | { ok: false; reason: string };
export interface PolicyLike {
  engineToolMeta(name: string, inputSchema?: unknown): ToolMetaLike;
  isVisible(meta: ToolMetaLike): boolean;
  check(meta: ToolMetaLike, args: Record<string, unknown>, clientId: string): DecisionLike;
}
export interface RateLimiterLike { take(key: string): { ok: boolean; retryAfterSec: number } }
export interface AuditLike {
  record(e: {
    clientId: string; tool: string; source: 'engine' | 'own'; ok: boolean;
    decision: 'allowed' | 'denied' | 'error'; reason?: string; durationMs?: number; args: unknown;
  }): void;
}
export interface EngineLike {
  listTools(): Tool[];
  callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CallToolResult>;
}

export const MAX_TEXT_BYTES = 200_000;

export interface RouterDeps {
  engine: EngineLike;
  policy: PolicyLike;
  limiter: RateLimiterLike;
  audit: AuditLike;
  ownTools: ToolDef[];
  getAllowedDirectories(): string[];
  stateDir: string;
}

interface Entry { meta: ToolMetaLike; own?: ToolDef; tool?: Tool }

function truncateResult(res: CallToolResult): CallToolResult {
  if (!Array.isArray(res.content)) return res;
  let changed = false;
  const content = res.content.map((c) => {
    if (c.type === 'text' && typeof c.text === 'string' && Buffer.byteLength(c.text, 'utf8') > MAX_TEXT_BYTES) {
      changed = true;
      const buf = Buffer.from(c.text, 'utf8');
      const cut = buf.subarray(0, MAX_TEXT_BYTES).toString('utf8').replace(/�$/, '');
      return { ...c, text: `${cut}\n\n[... çıktı ${Math.round(buf.length / 1000)} kB idi; ilk 200 kB gösterildi / output truncated at 200 kB]` };
    }
    return c;
  });
  return changed ? { ...res, content } : res;
}

export class ToolRouter {
  private ownByName = new Map<string, ToolDef>();

  constructor(private deps: RouterDeps) {
    for (const t of deps.ownTools) {
      if (this.ownByName.has(t.name)) throw new Error(`Duplicate own tool name: ${t.name}`);
      this.ownByName.set(t.name, t);
    }
    const engineNames = new Set(deps.engine.listTools().map((t) => t.name));
    for (const n of this.ownByName.keys()) {
      if (engineNames.has(n)) throw new Error(`Tool name collision between engine and own tool: ${n}`);
    }
  }

  private entries(): Map<string, Entry> {
    const out = new Map<string, Entry>();
    for (const tool of this.deps.engine.listTools()) {
      out.set(tool.name, { meta: this.deps.policy.engineToolMeta(tool.name, tool.inputSchema), tool });
    }
    for (const own of this.ownByName.values()) {
      if (out.has(own.name)) throw new Error(`Tool name collision between engine and own tool: ${own.name}`);
      out.set(own.name, { meta: { name: own.name, risk: own.risk, pathArgs: own.pathArgs ?? [], source: 'own' }, own });
    }
    return out;
  }

  list(): Tool[] {
    const tools: Tool[] = [];
    for (const e of this.entries().values()) {
      if (!this.deps.policy.isVisible(e.meta)) continue;
      if (e.tool) tools.push(e.tool);
      else if (e.own) {
        tools.push({
          name: e.own.name,
          description: e.own.description,
          inputSchema: e.own.inputSchema as Tool['inputSchema'],
          ...(e.own.annotations ? { annotations: e.own.annotations } : {}),
        });
      }
    }
    return tools;
  }

  async call(name: string, args: Record<string, unknown> | undefined, clientId: string, signal: AbortSignal): Promise<CallToolResult> {
    const { audit, policy, limiter } = this.deps;
    const input = args ?? {};
    const entry = this.entries().get(name);
    if (!entry) return textResult(`Bilinmeyen araç / Unknown tool: ${name}`, true);
    const { meta } = entry;

    const rl = limiter.take(clientId);
    if (!rl.ok) {
      const reason = `Hız sınırı aşıldı / rate limit exceeded; ${rl.retryAfterSec} sn sonra tekrar deneyin (retry after ${rl.retryAfterSec}s)`;
      audit.record({ clientId, tool: name, source: meta.source, ok: false, decision: 'denied', reason, args: input });
      return textResult(reason, true);
    }

    let decision: DecisionLike;
    try {
      decision = policy.check(meta, input, clientId);
    } catch (e) {
      decision = { ok: false, reason: `policy error: ${(e as Error).message}` };
    }
    if (!decision.ok) {
      audit.record({ clientId, tool: name, source: meta.source, ok: false, decision: 'denied', reason: decision.reason, args: input });
      return textResult(`Reddedildi / Denied: ${decision.reason}`, true);
    }

    const started = Date.now();
    try {
      let res: CallToolResult;
      if (entry.own) {
        res = await entry.own.handler(decision.args, {
          allowedDirectories: this.deps.getAllowedDirectories(),
          signal,
          stateDir: this.deps.stateDir,
        });
      } else {
        res = await this.deps.engine.callTool(name, decision.args, { signal });
      }
      res = truncateResult(res);
      audit.record({
        clientId, tool: name, source: meta.source, ok: !res.isError, decision: res.isError ? 'error' : 'allowed',
        durationMs: Date.now() - started, args: decision.args,
      });
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      audit.record({
        clientId, tool: name, source: meta.source, ok: false, decision: 'error', reason: msg,
        durationMs: Date.now() - started, args: decision.args,
      });
      return textResult(`Araç hatası / Tool error (${name}): ${msg}`, true);
    }
  }
}
