/** Pure token-count formatting for the usage graphs: 0, raw counts under
 *  1000, then three significant digits with trailing zeros stripped
 *  (12.3k, 1.25M). Rounding that reaches the next unit bumps the suffix
 *  (999999 → 1M, never 1000k). */

export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  return fmtScaled(n / 1000, 'k');
}

function fmtScaled(v: number, suffix: string): string {
  if (v >= 1000) return fmtScaled(v / 1000, suffix === 'k' ? 'M' : 'G');
  const rounded = v >= 100 ? Math.round(v) : Number(stripZeros(v.toFixed(2)));
  if (rounded >= 1000) return fmtScaled(rounded / 1000, suffix === 'k' ? 'M' : 'G');
  return `${rounded}${suffix}`;
}

function stripZeros(s: string): string {
  return s.replace(/\.?0+$/, '');
}
