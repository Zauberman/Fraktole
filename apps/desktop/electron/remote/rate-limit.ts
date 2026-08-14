/** Sliding-window per-connection message rate limiter.
 *
 *  Budget: `limit` messages per rolling `windowMs`. Every allowance is a
 *  timestamp in a deque; entries older than the window are dropped on each
 *  check, so the count over ANY windowMs-long span is bounded by `limit` —
 *  bursts that cross a clock boundary cannot exceed it.
 */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly limit = 120,
    private readonly windowMs = 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns false once the connection exceeds its per-window budget. */
  allow(): boolean {
    const t = this.now();
    while (this.stamps.length > 0 && t - this.stamps[0]! >= this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(t);
    return true;
  }

  get used(): number {
    return this.stamps.length;
  }
}
