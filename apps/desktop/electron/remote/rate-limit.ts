/** Sliding-window per-connection message rate limiter.
 *
 *  Budget: `limit` messages per rolling `windowMs`. The window slides at the
 *  start of every check, so bursts that cross a clock boundary are still
 *  bounded by the limit over any 1-second span.
 */
export class RateLimiter {
  private windowStart = 0;
  private count = 0;

  constructor(
    private readonly limit = 120,
    private readonly windowMs = 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Returns false once the connection exceeds its per-window budget. */
  allow(): boolean {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.count = 0;
    }
    this.count += 1;
    return this.count <= this.limit;
  }

  get used(): number {
    return this.count;
  }
}
