import { randomBytes, timingSafeEqual } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 — unambiguous
const CODE_CHARS = 8;

export interface PairingCodesOpts {
  /** How long a code stays valid before it rotates (default 5 min). */
  ttlMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface PairingCode {
  /** Display form: XXXX-XXXX. */
  code: string;
  expiresAt: number;
}

export type CodeVerdict = 'ok' | 'invalid-code';

/**
 * One-time pairing codes. A code is valid for `ttlMs`, is invalidated as soon
 * as it is used, and a fresh code is generated on demand (the bridge rotates
 * on a timer and right after a successful pair).
 *
 * The wire verdict is deliberately two-valued: a stale code answers
 * `invalid-code` exactly like a wrong one, so an attacker can never learn
 * that a guess matched the (about-to-rotate) code.
 */
export class PairingCodes {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private current: PairingCode | null = null;

  constructor(opts: PairingCodesOpts = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** The live code, generated lazily; never returns an expired code. */
  currentOrNew(): PairingCode {
    if (!this.current || this.current.expiresAt <= this.now()) {
      this.current = this.generate();
    }
    return this.current;
  }

  /** Forces a fresh code (used right after a successful pair). */
  rotate(): PairingCode {
    this.current = this.generate();
    return this.current;
  }

  get ttl(): number {
    return this.ttlMs;
  }

  /** Validates a submitted code: format, expiry, constant-time compare,
   *  and consumes it on success (single use). */
  check(submitted: string): CodeVerdict {
    const cleaned = submitted.toUpperCase().replace(/[\s-]/g, '');
    if (!/^[A-Z2-9]{8}$/.test(cleaned)) return 'invalid-code';
    const current = this.current;
    if (!current) return 'invalid-code';
    if (current.expiresAt <= this.now()) {
      // a matching stale code is consumed so rotation is forced; the verdict
      // stays 'invalid-code' — the response must not confirm a guess
      if (current.code.replace('-', '') === cleaned) this.current = null;
      return 'invalid-code';
    }
    if (!timingSafeEqual(Buffer.from(current.code.replace('-', '')), Buffer.from(cleaned))) {
      return 'invalid-code';
    }
    // single use: consume it even on the happy path
    this.current = null;
    return 'ok';
  }

  private generate(): PairingCode {
    const bytes = randomBytes(CODE_CHARS);
    let raw = '';
    for (let i = 0; i < CODE_CHARS; i += 1) {
      raw += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]!;
    }
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: this.now() + this.ttlMs };
  }
}
