import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** How dangerous a tool is. Modes allow a subset of these. */
export type Risk = 'read' | 'write' | 'exec' | 'control';

export interface ToolContext {
  /** Directories file-path arguments must stay within. Empty = unrestricted. */
  allowedDirectories: string[];
  /** Abort when the client cancels or the kill switch fires. */
  signal: AbortSignal;
  /** State directory for scratch files (screenshots etc.). */
  stateDir: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema (type: "object") for the arguments. */
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };
  risk: Risk;
  /** Names of arguments that are file-system paths (checked against allowedDirectories). */
  pathArgs?: string[];
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean; title?: string };
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult>;
}

export function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

export function imageResult(base64Png: string, caption?: string, mimeType = 'image/png'): CallToolResult {
  const content: CallToolResult['content'] = [{ type: 'image', data: base64Png, mimeType }];
  if (caption) content.push({ type: 'text', text: caption });
  return { content };
}
