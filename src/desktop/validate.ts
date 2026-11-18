/** Argument validation helpers. All throw ArgError with a clear message. */

export class ArgError extends Error {}

export type Args = Record<string, unknown>;

function isNil(v: unknown): boolean {
  return v === undefined || v === null;
}

export function reqString(a: Args, key: string, max = 2000): string {
  const v = a[key];
  if (typeof v !== 'string' || v.length === 0) throw new ArgError(`"${key}" is required and must be a non-empty string.`);
  if (v.length > max) throw new ArgError(`"${key}" is too long (${v.length} > ${max} characters).`);
  if (v.includes('\u0000')) throw new ArgError(`"${key}" must not contain NUL characters.`);
  return v;
}

export function optString(a: Args, key: string, max = 2000): string | undefined {
  const v = a[key];
  if (isNil(v)) return undefined;
  if (typeof v !== 'string') throw new ArgError(`"${key}" must be a string.`);
  if (v.length === 0) return undefined;
  if (v.length > max) throw new ArgError(`"${key}" is too long (${v.length} > ${max} characters).`);
  if (v.includes('\u0000')) throw new ArgError(`"${key}" must not contain NUL characters.`);
  return v;
}

function toNumber(v: unknown, key: string): number {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) n = Number(v);
  else throw new ArgError(`"${key}" must be a number.`);
  if (!Number.isFinite(n)) throw new ArgError(`"${key}" must be a finite number.`);
  return Math.round(n);
}

export function reqInt(a: Args, key: string, min: number, max: number): number {
  const v = a[key];
  if (isNil(v)) throw new ArgError(`"${key}" is required (integer ${min}..${max}).`);
  const n = toNumber(v, key);
  if (n < min || n > max) throw new ArgError(`"${key}" must be between ${min} and ${max} (got ${n}).`);
  return n;
}

export function optInt(a: Args, key: string, min: number, max: number): number | undefined {
  const v = a[key];
  if (isNil(v)) return undefined;
  const n = toNumber(v, key);
  if (n < min || n > max) throw new ArgError(`"${key}" must be between ${min} and ${max} (got ${n}).`);
  return n;
}

export function optBool(a: Args, key: string): boolean | undefined {
  const v = a[key];
  if (isNil(v)) return undefined;
  if (typeof v !== 'boolean') throw new ArgError(`"${key}" must be true or false.`);
  return v;
}

export function enumOf<T extends string>(a: Args, key: string, values: readonly T[], def?: T): T {
  const v = a[key];
  if (isNil(v)) {
    if (def !== undefined) return def;
    throw new ArgError(`"${key}" is required. One of: ${values.join(', ')}.`);
  }
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v.toLowerCase())) {
    throw new ArgError(`"${key}" must be one of: ${values.join(', ')}.`);
  }
  return v.toLowerCase() as T;
}

export function optStringArray(a: Args, key: string, maxItems = 32, maxLen = 2000): string[] | undefined {
  const v = a[key];
  if (isNil(v)) return undefined;
  const arr = typeof v === 'string' ? [v] : v;
  if (!Array.isArray(arr)) throw new ArgError(`"${key}" must be an array of strings.`);
  if (arr.length > maxItems) throw new ArgError(`"${key}" has too many items (max ${maxItems}).`);
  return arr.map((x, i) => {
    if (typeof x !== 'string') throw new ArgError(`"${key}[${i}]" must be a string.`);
    if (x.length > maxLen) throw new ArgError(`"${key}[${i}]" is too long (max ${maxLen}).`);
    if (x.includes('\u0000')) throw new ArgError(`"${key}[${i}]" must not contain NUL characters.`);
    return x;
  });
}

/** Window handle: positive integer, decimal/hex string accepted. */
export function optHandle(a: Args, key = 'handle'): number | undefined {
  const v = a[key];
  if (isNil(v)) return undefined;
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^(0x[0-9a-f]+|\d+)$/i.test(v.trim())) n = Number(v.trim());
  else throw new ArgError(`"${key}" must be a window handle number (as returned by desktop_list_windows).`);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ArgError(`"${key}" must be a positive integer window handle.`);
  return n;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function optRegion(a: Args, key = 'region'): Region | undefined {
  const v = a[key];
  if (isNil(v)) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new ArgError(`"${key}" must be an object {x, y, width, height}.`);
  const o = v as Args;
  return {
    x: reqInt(o, 'x', -100000, 100000),
    y: reqInt(o, 'y', -100000, 100000),
    width: reqInt(o, 'width', 1, 30000),
    height: reqInt(o, 'height', 1, 30000),
  };
}
