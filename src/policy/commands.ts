/**
 * Command guard. SEATBELT, NOT A SANDBOX: a determined attacker with shell access can evade
 * any pattern list. This catches the obvious/obfuscated footguns an AI (or a prompt injection)
 * might emit, and keeps Neo Commander's own state files out of reach.
 */
import { looseKey } from './paths.js';

const CMD_START = String.raw`(?:^|[;&|(]|\bcmd(?:\.exe)?\s+\/[ck]\s+|\bsudo\s+|\bstart\s+|\bcall\s+)\s*`;

const DENY_PATTERNS: Array<[RegExp, string]> = [
  [/\bFromBase64String\b/i, 'obfuscated PowerShell (FromBase64String)'],
  [/\bInvoke-Expression\b/i, 'Invoke-Expression'],
  [/(?:^|[|;&(\s"'])iex(?=[\s("')]|$)/i, 'Invoke-Expression (iex)'],
  [/\[\s*scriptblock\s*\]\s*::\s*create/i, '[ScriptBlock]::Create'],
  [new RegExp(CMD_START + String.raw`format(?:\.com|\.exe)?\s+(?:\/\S*\s+)*["']?[a-z]:`, 'i'), 'format <drive>'],
  [/(?:^|[;&|(\s])(?:Format-Volume|Clear-Disk|Remove-Partition)\b/i, 'disk-destroying cmdlet'],
  [new RegExp(CMD_START + String.raw`diskpart(?:\.exe)?(?:\s|$)`, 'i'), 'diskpart'],
  [/\bvssadmin(?:\.exe)?\s+delete\b/i, 'vssadmin delete'],
  [/\bwbadmin(?:\.exe)?\s+delete\b/i, 'wbadmin delete'],
  [/\bwmic(?:\.exe)?\s+shadowcopy\s+delete\b/i, 'shadow copy deletion'],
  [new RegExp(CMD_START + String.raw`bcdedit(?:\.exe)?(?:\s|$)`, 'i'), 'bcdedit'],
  [/\bcipher(?:\.exe)?\s+(?:\/\S+\s+)*\/w\b/i, 'cipher /w'],
];

/** powershell -e / -ec / -enc / -EncodedCommand <base64> */
const ENCODED = /(?:^|\s)[-/](?:e|ec|en[a-z]*)\s+["']?[A-Za-z0-9+/]{20,}={0,2}["']?/i;

const RM_NAMES = new Set(['rm', 'del', 'erase', 'rd', 'rmdir', 'ri', 'remove-item']);
const RECURSIVE = (t: string) =>
  /^-[rRfFvVi]*[rR][rRfFvVi]*$/.test(t) || /^-recurse$/i.test(t) || t === '--recursive' || /^\/s$/i.test(t);
const DANGEROUS_TARGET: RegExp[] = [
  /^[a-z]:\\?(\*(\.\*)?)?$/i,
  /^[a-z]:\\(windows|windows\\system32|users|programdata)\\?(\*(\.\*)?)?$/i,
  /^(%systemroot%|%windir%|%userprofile%|\$env:(systemroot|windir|userprofile|systemdrive))\\?(\*(\.\*)?)?$/i,
  /^\/\*?$/,
  /^\/(bin|etc|usr|home|var|boot|lib|root|sbin)\/?\*?$/,
  /^~\/?\*?$/,
  /^\$home\/?\*?$/i,
];

/**
 * Single linear pass per segment (was O(n^2): each rm token re-sliced/re-scanned the rest of the line).
 * Scanning right-to-left we keep two booleans for "everything after this token": is there a recursive
 * flag, is there a dangerous target. An rm-like token is a hit when both hold for its remainder.
 */
function dangerousRemoval(cmd: string): string | undefined {
  const isFlag = (t: string) => /^-{1,2}[a-zA-Z][\w-]*$/.test(t) || /^\/[a-zA-Z]$/.test(t);
  for (const seg of cmd.split(/[;&|\n\r]+/)) {
    const tokens = seg.replace(/["'`]/g, ' ').trim().split(/\s+/).filter(Boolean);
    let restRecursive = false;
    let restDangerous = false;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const t = tokens[i]!;
      const name = t.toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
      if (RM_NAMES.has(name) && restRecursive && restDangerous) return 'recursive delete of a drive root / system or home directory';
      if (isFlag(t)) {
        if (RECURSIVE(t)) restRecursive = true;
      } else if (!restDangerous) {
        const cleaned = t.replace(/,$/, '').replace(/^-path:?/i, '');
        const win = /^[a-z]:/i.test(cleaned) ? cleaned.replace(/\//g, '\\') : cleaned;
        if (DANGEROUS_TARGET.some((re) => re.test(win))) restDangerous = true;
      }
    }
  }
  return undefined;
}

/** Linear-time glob match (`*`, `?`, `[...]` treated as one char), case-insensitive. */
function globMatches(pattern: string, text: string): boolean {
  const pat = pattern.toLowerCase().replace(/\[[^\]]*\]/g, '?');
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === text[t])) { p++; t++; }
    else if (p < pat.length && pat[p] === '*') { star = p++; mark = t; }
    else if (star >= 0) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (p < pat.length && pat[p] === '*') p++;
  return p === pat.length;
}

const STATE_DIR_NAMES = ['neocommander', '.neo-commander'];

/**
 * Best-effort: does the command reference the state dir by %LOCALAPPDATA%\NeoCommander, a
 * Join-Path style bare name, an 8.3 alias (NEOCOM~1) or a wildcard (Neo*Comm*, N?oC*)?
 */
function touchesStateDirIndirectly(cmd: string): boolean {
  if (/neocommander/i.test(cmd) || /\bneocom~\d/i.test(cmd)) return true;
  // each path segment of each token that is a glob able to expand to a state dir name (>= 3 literal chars,
  // so "*", "*.txt" or "n*" do not trip it)
  for (const tok of cmd.match(/[^\s"'`;|&()=,<>]+/g) ?? []) {
    if (!/[*?[]/.test(tok)) continue;
    for (const seg of tok.split(/[\\/]/)) {
      if (seg.length > 64 || !/[*?[]/.test(seg)) continue;
      if (seg.replace(/[*?]|\[[^\]]*\]/g, '').length < 3) continue;
      if (STATE_DIR_NAMES.some((n) => globMatches(seg, n))) return true;
    }
  }
  return false;
}

/** Commands / interact_with_process input above this are refused outright (bounds every scan below). */
export const MAX_COMMAND_BYTES = 32 * 1024;

export interface CommandGuardOptions { protectedPaths: string[] }

/** Returns a denial reason, or undefined if the command looks acceptable. */
export function checkCommand(cmd: string, opts: CommandGuardOptions): string | undefined {
  if (cmd.length > MAX_COMMAND_BYTES || Buffer.byteLength(cmd, 'utf8') > MAX_COMMAND_BYTES) {
    return 'command is longer than 32 KB; split it up or put it in a script file';
  }
  if (/powershell|pwsh/i.test(cmd) && ENCODED.test(cmd)) return 'obfuscated PowerShell (-EncodedCommand)';
  for (const [re, why] of DENY_PATTERNS) if (re.test(cmd)) return why;
  const rm = dangerousRemoval(cmd);
  if (rm) return rm;
  if (touchesStateDirIndirectly(cmd)) return "touches Neo Commander's own state directory";
  const loose = looseKey(cmd);
  if (/(?:\.neo-commander|[\\/]neocommander)(?:[\\/"'\s]|$)/i.test(cmd) || /\bNEO_HOME\b/.test(cmd)) {
    return "touches Neo Commander's own state directory";
  }
  for (const p of opts.protectedPaths) {
    const k = looseKey(p);
    if (k && loose.includes(k)) return "touches Neo Commander's own state directory";
  }
  return undefined;
}
