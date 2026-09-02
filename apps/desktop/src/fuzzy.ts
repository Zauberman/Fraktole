/** Fuzzy subsequence scoring for the unified command palette.
 *
 *  `fuzzyScore(query, text)` returns a score when `query` appears as a
 *  case-insensitive subsequence of `text`, and null when it does not.
 *  Higher is better:
 *    - every matched character adds a base bonus,
 *    - each extension of a contiguous run adds a run bonus,
 *    - matches at word starts (string start, or right after `/ _ - .`
 *      or a digit) get the biggest per-character bonus,
 *    - matches that start earlier score higher,
 *    - shorter texts score higher,
 *    - characters skipped between matches subtract a small penalty.
 *
 *  An empty query scores 0 for every text, so callers that sort by score
 *  with a stable sort keep their input order untouched.
 *  Pure and deterministic: no locale, no randomness.
 */

const BASE = 8; // per matched character
const RUN_BONUS = 4; // per extension of a contiguous run
const WORD_BONUS = 10; // match at a word boundary (biggest per-char bonus)
const GAP_PENALTY = 1; // per character skipped between matches
const FIRST_BONUS_MAX = 16; // earlier first match → up to this much
const LENGTH_BONUS_MAX = 32; // shorter text → up to this much
const WORD_BREAKS = '/_.-0123456789';

export function fuzzyScore(query: string, text: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let qi = 0;
  let prev = -2;
  let first = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti += 1) {
    if (t[ti] !== q[qi]) continue;
    if (qi === 0) {
      first = ti;
    } else if (ti === prev + 1) {
      score += RUN_BONUS;
    } else {
      score -= (ti - prev - 1) * GAP_PENALTY;
    }
    if (ti === 0 || WORD_BREAKS.includes(t[ti - 1] ?? '')) score += WORD_BONUS;
    score += BASE;
    prev = ti;
    qi += 1;
  }
  if (qi < q.length) return null;
  score += Math.max(0, FIRST_BONUS_MAX - first);
  score += Math.max(0, LENGTH_BONUS_MAX - t.length);
  return score;
}
