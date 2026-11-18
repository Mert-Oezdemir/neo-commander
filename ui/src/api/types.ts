export type Mode = 'full' | 'standard' | 'readonly';
export type TunnelKind = 'none' | 'cloudflare-quick' | 'cloudflare-named' | 'tailscale' | 'manual';

export interface EngineStatus {
  state: 'starting' | 'ready' | 'error';
  toolCount: number;
  message?: string;
}

export interface TunnelStatus {
  kind: TunnelKind;
  state: 'off' | 'starting' | 'online' | 'error';
  publicUrl?: string;
  message?: string;
  stable: boolean;
}

export interface ClientInfo {
  clientId: string;
  clientName: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface TunnelSettings {
  kind: TunnelKind;
  publicUrl: string;
  hasToken: boolean;
}

export interface AuditEntry {
  ts: string | number;
  clientId?: string;
  tool: string;
  source?: 'engine' | 'own';
  ok?: boolean;
  decision?: 'allowed' | 'denied' | 'error';
  reason?: string;
  durationMs?: number;
  argsPreview?: unknown;
}

export interface Snapshot {
  version: string;
  engine: EngineStatus;
  tunnel: TunnelStatus;
  connectorUrl: string | null;
  pin: string;
  pinLocked: boolean;
  mode: Mode;
  paused: boolean;
  allowedDirectories: string[];
  autostart: boolean;
  port: number;
  tunnelSettings: TunnelSettings;
  clients: ClientInfo[];
}

export interface StateResponse extends Snapshot {
  recent: AuditEntry[];
}

export interface SettingsPatch {
  mode?: Mode;
  paused?: boolean;
  addDirectory?: string;
  removeDirectory?: string;
  autostart?: boolean;
  tunnel?: { kind?: TunnelKind; publicUrl?: string; cloudflareToken?: string };
}

export interface SettingsResponse extends Snapshot {
  ok: true;
  note?: string;
}

/** Payload of the SSE `status` event. */
export interface StatusEvent {
  tunnel: TunnelStatus;
  engine: EngineStatus;
  connectorUrl: string | null;
}
