/**
 * Color math for the theme contrast suite: oklch → sRGB (WCAG relative
 * luminance) and hex parsing. Pure functions, no dependencies.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const DEG2RAD = Math.PI / 180;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** oklch(l c h / a) → sRGB, alpha composited over `over` (sRGB gamma space). */
export function oklchToSrgb(color: string, over?: Rgb): Rgb {
  const m = color.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
  if (!m) throw new Error(`cannot parse oklch: ${color}`);
  const L = Number(m[1]);
  const C = Number(m[2]);
  const h = Number(m[3]) * DEG2RAD;
  const alpha = m[4] === undefined ? 1 : Number(m[4]);

  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l2_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m2_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s2_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l2 = l2_ ** 3;
  const m2 = m2_ ** 3;
  const s2 = s2_ ** 3;

  const rgb: Rgb = {
    r: clamp01(4.0767416621 * l2 - 3.3077115913 * m2 + 0.2309699292 * s2),
    g: clamp01(-1.2684380046 * l2 + 2.6097574011 * m2 - 0.3413193965 * s2),
    b: clamp01(-0.0041960863 * l2 - 0.7034186147 * m2 + 1.707614701 * s2),
  };

  // linear → sRGB encoding (gamma); luminance() linearizes back
  const enc = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  const srgb: Rgb = { r: enc(rgb.r), g: enc(rgb.g), b: enc(rgb.b) };

  if (alpha >= 1) return srgb;
  const base = over ?? { r: 0, g: 0, b: 0 };
  return {
    r: alpha * srgb.r + (1 - alpha) * base.r,
    g: alpha * srgb.g + (1 - alpha) * base.g,
    b: alpha * srgb.b + (1 - alpha) * base.b,
  };
}

/** #rrggbb → sRGB (gamma space, 0..1). */
export function hexToSrgb(hex: string): Rgb {
  const m = hex.match(/^#([0-9a-fA-F]{6})$/);
  if (!m) throw new Error(`cannot parse hex: ${hex}`);
  const n = Number.parseInt(m[1]!, 16);
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
  };
}

function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB (gamma) color. */
export function luminance(c: Rgb): number {
  return 0.2126 * srgbToLinear(c.r) + 0.7152 * srgbToLinear(c.g) + 0.0722 * srgbToLinear(c.b);
}

/** WCAG contrast ratio between two sRGB colors (either order). */
export function contrast(a: Rgb, b: Rgb): number {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/** Convenience: contrast of two oklch strings (fg first, bg second). */
export function contrastOklch(fg: string, bg: string): number {
  return contrast(oklchToSrgb(fg), oklchToSrgb(bg));
}

/** The hue component (degrees 0..360) of an oklch string. */
export function oklchHue(color: string): number {
  const m = color.match(/oklch\([\d.]+\s+[\d.]+\s+([\d.]+)(?:\s*\/\s*[\d.]+)?\)/);
  if (!m) throw new Error(`cannot parse oklch: ${color}`);
  return Number(m[1]);
}

/** Shortest angular distance between two hues. */
export function hueDistance(a: string, b: string): number {
  const d = Math.abs(oklchHue(a) - oklchHue(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/** Perceptual lightness gap between two oklch strings (for hairline
 *  visibility — the L component difference). */
export function deltaL(a: string, b: string): number {
  const la = a.match(/oklch\(([\d.]+)/);
  const lb = b.match(/oklch\(([\d.]+)/);
  if (!la || !lb) throw new Error(`cannot parse oklch: ${a} / ${b}`);
  return Math.abs(Number(la[1]) - Number(lb[1]));
}
