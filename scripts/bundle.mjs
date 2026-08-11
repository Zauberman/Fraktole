import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist');
mkdirSync(outdir, { recursive: true });

const SHEBANG = '#!/usr/bin/env node';

// ink's devtools import is DEV-guarded, but esbuild hoists it; alias to a no-op
const devtoolsStub = join(root, 'scripts/stubs/react-devtools-core.js');

// ESM output: give the bundle a working `require` for the few CJS dependencies
// (signal-exit et al.) that call require() dynamically at runtime.
const BANNER = `${SHEBANG}
import { createRequire as _fraktRequire } from 'node:module';
globalThis.require = _fraktRequire(import.meta.url);`;

const targets = [
  {
    entryPoints: [join(root, 'packages/cli/src/entry.ts')],
    outfile: join(outdir, 'fraktole.mjs'),
  },
  {
    entryPoints: [join(root, 'packages/daemon/src/index.ts')],
    outfile: join(outdir, 'fraktole-daemon.mjs'),
  },
];

for (const target of targets) {
  await build({
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: target.outfile,
    entryPoints: target.entryPoints,
    banner: { js: BANNER },
    alias: { 'react-devtools-core': devtoolsStub },
    sourcemap: false,
    minify: false,
    logLevel: 'info',
  });
}
console.log(`bundled ${targets.map((t) => t.outfile).join(', ')}`);
