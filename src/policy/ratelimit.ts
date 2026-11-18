/** Sliding-window limiter, per key. A limit <= 0 means unlimited. */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private lastSweep = 0;
  constructor(private getPerMinute: () => number, private now: () => number = Date.now) {}

  take(key: string): { ok: boolean; retryAfterSec: number } {
    const limit = this.getPerMinute();
    const t = this.now();
    if (t - this.lastSweep > 60_000) this.sweep(t);
    if (!(limit > 0)) return { ok: true, retryAfterSec: 0 };
    const arr = (this.hits.get(key) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((arr[0] + 60_000 - t) / 1000)) };
    }
    arr.push(t);
    this.hits.set(key, arr);
    return { ok: true, retryAfterSec: 0 };
  }

  private sweep(t: number): void {
    this.lastSweep = t;
    for (const [k, arr] of this.hits) if (arr.length === 0 || t - arr[arr.length - 1] >= 60_000) this.hits.delete(k);
  }
}
