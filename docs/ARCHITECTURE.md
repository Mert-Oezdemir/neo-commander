# Neo Commander — Architecture

Neo Commander lets a web AI client (Claude.ai, ChatGPT) operate **your own computer**
through a self-hosted remote MCP server. No paid relay, no third-party account except
an optional tunnel provider.

```
Claude.ai ──HTTPS/OAuth 2.1──► tunnel (cloudflared / tailscale funnel)
                                   │
                                   ▼  127.0.0.1:<port>
                         ┌──────────────────────────┐
                         │  Neo Commander (Node 22) │
                         │  ├─ auth/   OAuth 2.1 AS + RS (MCP SDK router)
                         │  ├─ mcp/    Streamable HTTP, one Server per session
                         │  ├─ policy/ mode, kill switch, path & command guards,
                         │  │          rate limit, audit log
                         │  ├─ engine/ Desktop Commander (pinned npm dep) over stdio
                         │  ├─ desktop/ own desktop tools, Windows + macOS (screen, OCR, input,
                         │  │          windows, clipboard, apps, system)
                         │  ├─ tunnel/ cloudflared download+verify, quick/named
                         │  │          tunnel, tailscale funnel detection
                         │  └─ panel/  loopback-only control panel (/panel)
                         └──────────────────────────┘
```

## Principles

1. **Upstream engine, not a rewrite.** File, search, edit and process tools come from
   `@wonderwhy-er/desktop-commander` at a pinned version, run as a child process with
   telemetry disabled (`DESKTOP_COMMANDER_DISABLE_TELEMETRY=1`) and an isolated config
   directory. Our own tools are added next to it under the same policy layer.
2. **Fail closed.** `/mcp` never runs without a valid OAuth access token whose audience
   is this server. The panel is reachable only from a direct loopback connection with no
   proxy headers. Tokens never travel in query strings.
3. **One policy gate.** Every tool call — engine or own — goes through
   `PolicyEngine.check()` and `AuditLog.record()`. No tool bypasses it.
4. **Modes instead of popups.** `full` (everything incl. mouse/keyboard), `standard`
   (no input control, no config tools), `readonly` (read/list/search/screenshot only).
   Kill switch (`paused`) refuses all calls instantly.
5. **Stable identity across tunnel URL changes.** Signing keys live in the state
   directory; the issuer/resource URL follows the current public URL. A changed quick
   tunnel URL means the connector must be re-added — the panel says so and shows the new
   link. Tailscale Funnel or a named Cloudflare tunnel give a stable link.

## State directory

`%LOCALAPPDATA%\NeoCommander` on Windows, `~/.neo-commander` elsewhere
(override: `NEO_HOME`). Contents: `secrets.json` (signing key, owner PIN),
`settings.json` (mode, allowed dirs, tunnel), `oauth.json` (clients, refresh tokens),
`audit.jsonl`, `dc-config/` (isolated Desktop Commander config), `bin/` (cloudflared).
Never committed.

## Tool contract (`src/tools/types.ts`)

Every own tool is a `ToolDef`: name, description, JSON-schema `inputSchema`, `risk`
(`read` | `write` | `exec` | `control`) and an async `handler(args, ctx)` returning an
MCP `CallToolResult`. Engine tools are mapped to a risk class by name in
`src/policy/risk.ts`.

Mode → allowed risk: `readonly` = read; `standard` = read, write, exec;
`full` = read, write, exec, control.

## Module ownership

| Path | Contents |
|---|---|
| `src/config.ts` | state dir, settings & secrets load/save |
| `src/auth/*` | OAuth provider, consent page, token signing |
| `src/mcp/*` | session manager, tool router (engine + own tools) |
| `src/engine/*` | Desktop Commander stdio client |
| `src/policy/*` | modes, risk map, guards, rate limit, audit |
| `src/desktop/*` | own desktop tools (Windows first, graceful elsewhere) |
| `src/tunnel/*` | cloudflared / tailscale |
| `src/panel/*` | loopback panel API + static file serving (CSRF token injected into index.html) |
| `ui/` → `panel/` | React + Vite control panel source (`cd ui && npm run build` emits the committed `panel/` bundle) |
| `scripts/`, `Neo-Commander.cmd` | one-click install/start |
| `electron/` → `dist-electron/` | desktop shell: runs `startServer()` in-process, window + tray/menu bar, single instance; packaged by electron-builder (`build` key in package.json). DC child runs with `ELECTRON_RUN_AS_NODE=1`; `node_modules` is unpacked from the asar |
| `assets/` | app/tray icons (`npm run icons` regenerates PNGs from SVG) |
