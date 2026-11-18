const SECRET_KEY = /pass|secret|token|key|pin|auth|cookie/i;
const CONTENT_KEY = /^(content|new_string|old_string|text|data)$/i;
const MAX_STR = 400;
const MAX_DEPTH = 4;
const MAX_ITEMS = 25;

function scrubString(s: string): string {
  return s
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, '$1***')
    .replace(/((?:pass(?:word)?|pwd|token|secret|api[-_]?key)\s*[=:]\s*)\S+/gi, '$1***');
}

export function redact(value: unknown, key?: string, depth = 0): unknown {
  if (key && SECRET_KEY.test(key) && value !== null && value !== undefined && typeof value !== 'object') return '***';
  if (key && SECRET_KEY.test(key) && typeof value === 'object' && value !== null) return '***';
  if (typeof value === 'string') {
    if (key && CONTENT_KEY.test(key) && value.length > 80) return `${scrubString(value.slice(0, 80))}… [${value.length} chars]`;
    const s = scrubString(value);
    return s.length > MAX_STR ? `${s.slice(0, MAX_STR)}… [${value.length} chars]` : s;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_DEPTH) return '[depth limit]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ITEMS).map((v) => redact(v, undefined, depth + 1));
    if (value.length > MAX_ITEMS) out.push(`… [${value.length - MAX_ITEMS} more]`);
    return out;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) out[k] = redact(v, k, depth + 1);
    return out;
  }
  return String(value);
}
