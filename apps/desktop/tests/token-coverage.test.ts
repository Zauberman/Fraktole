import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { THEMES } from '../src/themes.js';

/** Every var() in the CSS layers must resolve: either a CSS-native token
 *  defined in the :root block (spacing/type/motion), or a ThemeTokens key.
 *  A component referencing a nonexistent theme token (--fg-dim, --danger…)
 *  silently inherits colors — this guard makes that bug class impossible. */
const CSS_NATIVE = new Set([
  '--s1', '--s2', '--s3', '--s4', '--s5', '--s6',
  '--r-xs', '--r-sm', '--r-md', '--r-pill',
  '--text-2xs', '--text-xs', '--text-sm', '--text-md', '--text-lg',
  '--track-wide', '--track-tight',
  '--lh-tight', '--lh-body',
  '--dur-fast', '--dur-med', '--dur-slow',
  '--ease-out',
  '--font-ui', '--font-mono', '--font-mono-alt', '--font-display',
]);

const THEME_TOKENS = new Set(Object.keys(THEMES[0]!.tokens));
const THEME_TOKENS_ARR = Object.keys(THEMES[0]!.tokens);

const STYLES_DIR = join(import.meta.dirname, '..', 'src', 'styles');

async function layerFiles(): Promise<string[]> {
  const names = (await readdir(STYLES_DIR)).filter((f) => f.endsWith('.css')).sort();
  return names.map((n) => join(STYLES_DIR, n));
}

describe('theme token coverage', () => {
  it('every var() used in the CSS layers is a defined token', async () => {
    const files = await layerFiles();
    const contents = await Promise.all(files.map((f) => readFile(f, 'utf8')));
    const definedInLayers = new Set(
      contents.flatMap((c) => [...c.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!)),
    );
    const missing = new Set<string>();
    contents.forEach((css) => {
      const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!);
      for (const name of used) {
        if (!CSS_NATIVE.has(name) && !THEME_TOKENS.has(name) && !definedInLayers.has(name)) {
          missing.add(name);
        }
      }
    });
    expect([...missing], `undefined tokens referenced by CSS: ${[...missing].join(', ')}`).toEqual([]);
  });

  it('every theme token is actually used by some CSS layer (no dead tokens)', async () => {
    let all = '';
    for (const file of await layerFiles()) all += await readFile(file, 'utf8');
    const dead = THEME_TOKENS_ARR.filter(
      (name) => !all.includes(`var(${name}`),
    );
    expect(dead, `theme tokens never used: ${dead.join(', ')}`).toEqual([]);
  });

  it('tokens.css holds the only raw values; every other layer is tokens-only', async () => {
    for (const file of await layerFiles()) {
      const name = file.split('/').pop()!;
      const css = await readFile(file, 'utf8');
      if (name === 'tokens.css') {
        // tokens.css may hold raw oklch ONLY inside @font-face / :root —
        // strip everything up to and including the :root block, then forbid
        const afterRoot = css.split('}').slice(1).join('}');
        const raw = afterRoot.match(/(?:oklch\(|#[0-9a-fA-F]{3,8}\b|rgba?\()/g);
        expect(raw ?? [], 'raw colors outside the token block').toEqual([]);
      } else {
        const raw = css.match(/(?:oklch\(|#[0-9a-fA-F]{3,8}\b|rgba?\()/g);
        expect(raw ?? [], `${name} must use tokens only`).toEqual([]);
      }
    }
  });

  it('every var() in TSX components is a defined token too', async () => {
    const srcDir = join(import.meta.dirname, '..', 'src');
    const roots = [srcDir];
    const files: string[] = [];
    while (roots.length > 0) {
      const dir = roots.pop()!;
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) roots.push(p);
        else if (/\.(tsx|ts)$/.test(e.name) && !e.name.endsWith('.test.ts')) files.push(p);
      }
    }
    const missing = new Set<string>();
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      for (const m of src.matchAll(/var\((--[a-z0-9-]+)/g)) {
        const name = m[1]!;
        if (!CSS_NATIVE.has(name) && !THEME_TOKENS.has(name)) missing.add(name);
      }
    }
    expect([...missing], `undefined tokens referenced by TSX: ${[...missing].join(', ')}`).toEqual([]);
  });
});
