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

function dangerousRemoval(cmd: string): string | undefined {
  for (const seg of cmd.split(/[;&|\n\r]+/)) {
    const tokens = seg.replace(/["'`]/g, ' ').trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const name = tokens[i].toLowerCase().replace(/^.*[\\/]/, '').replace(/\.exe$/, '');
      if (!RM_NAMES.has(name)) continue;
      const rest = tokens.slice(i + 1);
      const isFlag = (t: string) => /^-{1,2}[a-zA-Z][\w-]*$/.test(t) || /^\/[a-zA-Z]$/.test(t);
      if (!rest.filter(isFlag).some(RECURSIVE)) continue;
      for (const t of rest) {
        if (isFlag(t)) continue;
        const cleaned = t.replace(/,$/, '').replace(/^-path:?/i, '');
        const win = /^[a-z]:/i.test(cleaned) ? cleaned.replace(/\//g, '\\') : cleaned;
        if (DANGEROUS_TARGET.some((re) => re.test(win))) return 'recursive delete of a drive root / system or home directory';
      }
    }
  }
  return undefined;
}

export interface CommandGuardOptions { protectedPaths: string[] }

/** Returns a denial reason, or undefined if the command looks acceptable. */
export function checkCommand(cmd: string, opts: CommandGuardOptions): string | undefined {
  if (/powershell|pwsh/i.test(cmd) && ENCODED.test(cmd)) return 'obfuscated PowerShell (-EncodedCommand)';
  for (const [re, why] of DENY_PATTERNS) if (re.test(cmd)) return why;
  const rm = dangerousRemoval(cmd);
  if (rm) return rm;
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
