import { describe, expect, it } from 'vitest';
import { fuzzyScore } from '../src/fuzzy.js';

describe('fuzzyScore', () => {
  it('matches case-insensitive subsequences and rejects non-subsequences', () => {
    expect(fuzzyScore('abc', 'a1B2c3')).not.toBeNull();
    expect(fuzzyScore('QP', 'QuickOpen')).not.toBeNull();
    expect(fuzzyScore('abc', 'acb')).toBeNull(); // right chars, wrong order
    expect(fuzzyScore('xz', 'abc')).toBeNull();
    expect(fuzzyScore('longquery', 'ab')).toBeNull();
  });

  it('is case-insensitive with identical scores for case variants', () => {
    expect(fuzzyScore('qp', 'QuickOpen')).toBe(fuzzyScore('QP', 'QuickOpen'));
    expect(fuzzyScore('NODE', 'node_modules')).not.toBeNull();
  });

  it('prefers contiguous runs over gappy matches', () => {
    const contiguous = fuzzyScore('ab', 'abx');
    const gappy = fuzzyScore('ab', 'axb');
    expect(contiguous).not.toBeNull();
    expect(gappy).not.toBeNull();
    expect(contiguous!).toBeGreaterThan(gappy!);
  });

  it('rewards word-start matches over mid-word ones', () => {
    const stringStart = fuzzyScore('n', 'node_modules');
    const midWord = fuzzyScore('n', 'xnode_modules');
    expect(stringStart!).toBeGreaterThan(midWord!);

    const afterSlash = fuzzyScore('u', 'src/utils');
    const afterLetter = fuzzyScore('u', 'srcxutils');
    expect(afterSlash!).toBeGreaterThan(afterLetter!);
  });

  it('values a word start above a contiguous run extension', () => {
    // 'a-b' matches at a word boundary (after the dash) with a gap;
    // 'xab' matches a contiguous run but mid-word. The word-start bonus
    // is specified as the bigger per-character bonus.
    expect(fuzzyScore('ab', 'a-b')!).toBeGreaterThan(fuzzyScore('ab', 'xab')!);
  });

  it('prefers earlier first matches and shorter texts', () => {
    const early = fuzzyScore('z', 'zeta');
    const late = fuzzyScore('z', 'aaaz');
    expect(early!).toBeGreaterThan(late!);

    const short = fuzzyScore('z', 'z');
    const long = fuzzyScore('z', 'z'.repeat(40));
    expect(short!).toBeGreaterThan(long!);
  });

  it('scores an empty query 0 for everything so input order is preserved', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('', '')).toBe(0);
    // Callers sort by score with a stable sort: all-zero scores mean the
    // original (e.g. filesystem walk) order comes through untouched.
    const inputs = ['b.txt', 'a.txt'];
    const ranked = inputs
      .map((t, i) => ({ t, i, s: fuzzyScore('', t) }))
      .sort((a, b) => (b.s ?? 0) - (a.s ?? 0) || a.i - b.i)
      .map((x) => x.t);
    expect(ranked).toEqual(['b.txt', 'a.txt']);
  });

  it('ranks equal-score items stably in input order', () => {
    const inputs = ['zzb', 'zza', 'zzc'];
    const scores = inputs.map((t) => fuzzyScore('zz', t));
    expect(new Set(scores).size).toBe(1); // identical scores
    const ranked = inputs
      .map((t, i) => ({ t, i, s: fuzzyScore('zz', t) }))
      .sort((a, b) => (b.s ?? 0) - (a.s ?? 0) || a.i - b.i)
      .map((x) => x.t);
    expect(ranked).toEqual(['zzb', 'zza', 'zzc']); // stable: input order kept
  });

  it('is deterministic for repeated calls', () => {
    expect(fuzzyScore('fz', 'fuzzy.ts')).toBe(fuzzyScore('fz', 'fuzzy.ts'));
  });
});
