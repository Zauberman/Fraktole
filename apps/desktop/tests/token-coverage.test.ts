import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { THEMES } from '../src/themes.js';

/** Every var() in the CSS layers must resolve: either a CSS-native token
 *  defined in the :root block (spacing/type/motion), or a ThemeTokens key.
 *  A component referencing a nonexistent theme token (--fg-dim, --danger…)
 *  silently inherits colors — this guard makes that bug class impossible. */
const CSS_NATIVE = new Set([
  '--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s8',
  '--r0', '--r-xs', '--r-sm', '--r-md', '--r-pill',
  '--text-2xs', '--text-xs', '--text-sm', '--text-md', '--text-lg',
  '--track-wide', '--track-tight',
  '--lh-tight', '--lh-body',
  '--dur-fast', '--dur-med', '--dur-slow',
  '--ease-out', '--ease-in',
  '--font-ui', '--font-mono', '--font-mono-alt', '--font-display',
]);

/** Derived surface tokens land in themes.ts before their consuming CSS
 *  layer does (Phase 2 of the vibrant-chrome rebase); this allowlist keeps
 *  the dead-token gate honest until then. Remove once every entry is
 *  referenced by a stylesheet. */
const DERIVED_PENDING = new Set([
  '--rgn-explorer', '--rgn-explorer-soft',
  '--rgn-editor', '--rgn-editor-soft',
  '--rgn-reviewer', '--rgn-reviewer-soft',
  '--rgn-palette', '--rgn-palette-soft',
  '--rgn-settings', '--rgn-settings-soft',
  '--cat-folder', '--cat-code', '--cat-doc', '--cat-config', '--cat-style', '--cat-data',
]);

const THEME_TOKENS = new Set(THEMES[0]!.tokens ? Object.keys(THEMES[0]!.tokens) : []);
const THEME_TOKENS_ARR = THEMES[0]!.tokens ? Object.keys(THEMES[0]!.tokens) : [];

async function layerFiles(): Promise<string[]> {
  const files = [join(import.meta.dirname, '..', 'src', 'theme.css')];
  try {
    const dir = join(import.meta.dirname, '..', 'src', 'styles');
    const names = (await readdir(dir)).filter((f) => f.endsWith('.css')).sort();
    files.push(...names.map((n) => join(dir, n)));
  } catch {
    // styles/ layer directory may not exist yet (pre-split phases)
  }
  return files;
}

describe('theme token coverage', () => {
  it('every var() used in the CSS layers is a defined token', async () => {
    const missing = new Set<string>();
    for (const file of await layerFiles()) {
      const css = await readFile(file, 'utf8');
      const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!);
      for (const name of used) {
        if (!CSS_NATIVE.has(name) && !THEME_TOKENS.has(name)) missing.add(name);
      }
    }
    expect([...missing], `undefined tokens referenced by CSS: ${[...missing].join(', ')}`).toEqual([]);
  });

  it('every theme token is actually used by some CSS layer (no dead tokens)', async () => {
    let all = '';
    for (const file of await layerFiles()) all += await readFile(file, 'utf8');
    const dead = THEME_TOKENS_ARR.filter(
      (name) => !all.includes(`var(${name}`) && !DERIVED_PENDING.has(name),
    );
    expect(dead, `theme tokens never used: ${dead.join(', ')}`).toEqual([]);
  });

  it('theme.css contains no raw colors outside the :root token block', async () => {
    const css = await readFile(join(import.meta.dirname, '..', 'src', 'theme.css'), 'utf8');
    // strip the :root block (and anything before it) — only the native token
    // block may hold raw oklch/hex/rgb values
    const afterRoot = css.split('}').slice(1).join('}');
    const raw = afterRoot.match(/(?:oklch\(|#[0-9a-fA-F]{3,8}\b|rgba?\()/g);
    expect(raw ?? [], 'raw colors outside the token block').toEqual([]);
  });

  it('component CSS layers contain no raw colors at all (tokens only)', async () => {
    const dir = join(import.meta.dirname, '..', 'src', 'styles');
    let names: string[] = [];
    try {
      names = (await readdir(dir)).filter((f) => f.endsWith('.css')).sort();
    } catch {
      return; // no layer directory yet
    }
    for (const name of names) {
      const css = await readFile(join(dir, name), 'utf8');
      const raw = css.match(/(?:oklch\(|#[0-9a-fA-F]{3,8}\b|rgba?\()/g);
      expect(raw ?? [], `${name} must use tokens only`).toEqual([]);
    }
  });
});
