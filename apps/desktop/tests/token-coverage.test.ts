import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { THEMES } from '../src/themes.js';

/** Every var() in theme.css must resolve: either a CSS-native token defined
 *  in the :root block (spacing/type/motion), or a ThemeTokens key. A
 *  component referencing a nonexistent theme token (--fg-dim, --danger…)
 *  silently inherits colors — this guard makes that bug class impossible. */
const CSS_NATIVE = new Set([
  '--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s8',
  '--r0', '--r-xs', '--r-sm', '--r-md', '--r-pill',
  '--text-2xs', '--text-xs', '--text-sm', '--text-md',
  '--track-wide', '--track-tight',
  '--lh-tight', '--lh-body',
  '--dur-fast', '--dur-med', '--dur-slow',
  '--ease-out', '--ease-in',
  '--font-ui', '--font-mono',
]);

const THEME_TOKENS = new Set(THEMES[0]!.tokens ? Object.keys(THEMES[0]!.tokens) : []);

describe('theme.css token coverage', () => {
  it('every var() used in theme.css is a defined token', async () => {
    const css = await readFile(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');
    const used = new Set(
      [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!),
    );
    const missing = [...used].filter((name) => !CSS_NATIVE.has(name) && !THEME_TOKENS.has(name));
    expect(missing, `undefined tokens referenced by theme.css: ${missing.join(', ')}`).toEqual([]);
  });

  it('theme.css contains no raw colors outside the :root token block', async () => {
    const css = await readFile(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');
    // strip the :root block (and anything before it) — only the native token
    // block may hold raw oklch/hex/rgb values
    const afterRoot = css.split('}').slice(1).join('}');
    const raw = afterRoot.match(/(?:oklch\(|#[0-9a-fA-F]{3,8}\b|rgba?\()/g);
    expect(raw ?? [], 'raw colors outside the token block').toEqual([]);
  });
});
