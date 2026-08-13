import { describe, expect, it } from 'vitest';
import { PairingCodes } from '../electron/remote/pairing.js';

function make(ttlMs: number, start = 1_000_000): { codes: PairingCodes; tick(ms: number): void; now: () => number } {
  let t = start;
  const codes = new PairingCodes({ ttlMs, now: () => t });
  return { codes, tick: (ms) => (t += ms), now: () => t };
}

describe('PairingCodes', () => {
  it('generates codes in XXXX-XXXX form from the unambiguous alphabet', () => {
    const { codes } = make(5 * 60_000);
    for (let i = 0; i < 50; i += 1) {
      const { code } = codes.currentOrNew();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it('accepts the correct code case-insensitively and with or without dashes', () => {
    const { codes } = make(5 * 60_000);
    const { code } = codes.currentOrNew();
    expect(codes.check(code.toLowerCase())).toBe('ok');
    const next = codes.currentOrNew();
    expect(codes.check(next.code.replace('-', ''))).toBe('ok');
  });

  it('rejects a wrong code', () => {
    const { codes } = make(5 * 60_000);
    codes.currentOrNew();
    expect(codes.check('AAAA-AAAA')).toBe('invalid-code');
  });

  it('rejects malformed codes', () => {
    const { codes } = make(5 * 60_000);
    codes.currentOrNew();
    expect(codes.check('AB')).toBe('invalid-code');
    expect(codes.check('AAAA-AAAA-AAAA')).toBe('invalid-code');
    expect(codes.check('ABCD-EFGH')).toBe('invalid-code');
    expect(codes.check('')).toBe('invalid-code');
    expect(codes.check('AAAA AAAA')).toBe('invalid-code');
  });

  it('is single-use: the code is consumed on the first success', () => {
    const { codes } = make(5 * 60_000);
    const { code } = codes.currentOrNew();
    expect(codes.check(code)).toBe('ok');
    expect(codes.check(code)).toBe('invalid-code');
  });

  it('reports the correct code as expired after the TTL, then rotates', () => {
    const { codes, tick } = make(5 * 60_000);
    const { code } = codes.currentOrNew();
    tick(5 * 60_000 + 1);
    expect(codes.check(code)).toBe('expired');
    expect(codes.check(code)).toBe('expired');
    // after rotation a fresh code is accepted
    const next = codes.currentOrNew();
    expect(next.code).not.toBe(code);
    expect(codes.check(next.code)).toBe('ok');
  });

  it('does not reveal which code expired vs which is wrong', () => {
    const { codes, tick } = make(5 * 60_000);
    const { code } = codes.currentOrNew();
    tick(5 * 60_000 + 1);
    // the expired code still answers 'expired' (not 'invalid') — but a wrong
    // code gets 'invalid-code' in both states
    expect(codes.check('AAAA-AAAA')).toBe('invalid-code');
    expect(codes.check(code)).toBe('expired');
  });

  it('rotate() always produces a fresh code', () => {
    const { codes } = make(5 * 60_000);
    const seen = new Set<string>();
    for (let i = 0; i < 10; i += 1) {
      const { code } = codes.rotate();
      seen.add(code);
    }
    expect(seen.size).toBe(10);
  });

  it('currentOrNew never returns an expired code', () => {
    const { codes, tick } = make(1_000);
    const first = codes.currentOrNew();
    tick(2_000);
    const second = codes.currentOrNew();
    expect(second.code).not.toBe(first.code);
    expect(second.expiresAt).toBeGreaterThan(first.expiresAt);
  });
});
