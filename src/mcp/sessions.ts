import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ToolRouter } from './router.js';

export const SERVER_INSTRUCTIONS = `Neo Commander: this server operates the owner's own Windows PC (files, shell, processes, windows, screen, keyboard/mouse). The owner is Turkish; reply in Turkish unless asked otherwise.
Guidelines:
- For anything visual, use the loop desktop_screenshot -> act (click/type/key) -> desktop_screenshot to verify the result before continuing.
- Run long commands with start_process, then poll with read_process_output (do not block on them); use interact_with_process for REPLs/prompts.
- Prefer absolute paths. Stay inside the allowed directories; if a call is denied, explain the reason to the user instead of retrying with tricks.
- Access depends on the mode the owner chose in the panel (full / standard / readonly) and can be paused at any time.`;

export interface SessionManagerOptions {
  router: ToolRouter;
  version: string;
  idleTtlMs?: number;
  maxSessions?: number;
  sweepIntervalMs?: number;
}

interface Session {
  id: string;
  clientId: string;
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private sweeper: NodeJS.Timeout;
  private idleTtl: number;
  private max: number;

  constructor(private opts: SessionManagerOptions) {
    this.idleTtl = opts.idleTtlMs ?? 2 * 60 * 60 * 1000;
    this.max = opts.maxSessions ?? 64;
    this.sweeper = setInterval(() => this.sweep(), opts.sweepIntervalMs ?? 60_000);
    this.sweeper.unref?.();
  }

  get size(): number { return this.sessions.size; }

  sweep(now = Date.now()): void {
    for (const s of [...this.sessions.values()]) {
      if (now - s.lastSeen > this.idleTtl) void this.close(s);
    }
  }

  private async close(s: Session): Promise<void> {
    this.sessions.delete(s.id);
    try { await s.transport.close(); } catch { /* ignore */ }
    try { await s.server.close(); } catch { /* ignore */ }
  }

  private evictIfFull(): void {
    while (this.sessions.size >= this.max) {
      let oldest: Session | undefined;
      for (const s of this.sessions.values()) if (!oldest || s.lastSeen < oldest.lastSeen) oldest = s;
      if (!oldest) break;
      void this.close(oldest);
    }
  }

  private createServer(clientIdOf: () => string): Server {
    const server = new Server(
      { name: 'neo-commander', version: this.opts.version },
      { capabilities: { tools: { listChanged: true } }, instructions: SERVER_INSTRUCTIONS },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: this.opts.router.list() }));
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const clientId = extra.authInfo?.clientId ?? clientIdOf();
      return this.opts.router.call(
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
        clientId,
        extra.signal,
      );
    });
    return server;
  }

  /** Express handler for POST/GET/DELETE /mcp. Must run after requireAuth (req.auth set). */
  handle = async (req: Request, res: Response): Promise<void> => {
    try {
      const clientId = (req as Request & { auth?: { clientId?: string } }).auth?.clientId;
      if (!clientId) return rpcError(res, 401, -32001, 'Unauthorized');
      const sid = req.header('mcp-session-id');

      if (sid) {
        const s = this.sessions.get(sid);
        // Same answer for "unknown" and "belongs to someone else": do not leak existence.
        if (!s || s.clientId !== clientId) return rpcError(res, 404, -32001, 'Session not found');
        s.lastSeen = Date.now();
        await s.transport.handleRequest(req, res, req.body);
        return;
      }

      if (req.method === 'POST' && isInitializeRequest(req.body)) {
        this.evictIfFull();
        let session: Session | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => { if (session) { session.id = id; this.sessions.set(id, session); } },
        });
        const server = this.createServer(() => clientId);
        session = { id: '', clientId, server, transport, lastSeen: Date.now() };
        transport.onclose = () => { if (session?.id) this.sessions.delete(session.id); };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      rpcError(res, 400, -32000, 'Bad Request: missing Mcp-Session-Id header (send initialize first)');
    } catch (e) {
      rpcError(res, 500, -32603, `Internal error: ${(e as Error).message}`);
    }
  };

  /** Tell every connected client that the tool list changed (mode/blockedTools edits). */
  notifyToolsChanged(): void {
    for (const s of this.sessions.values()) {
      s.server.sendToolListChanged().catch(() => { /* client gone or no standalone stream */ });
    }
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((s) => this.close(s)));
  }
}
