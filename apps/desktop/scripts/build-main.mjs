import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'dist-electron');
mkdirSync(out, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'node-pty'],
  sourcemap: false,
  logLevel: 'info',
};

await Promise.all([
  build({ ...common, entryPoints: [join(root, 'electron', 'main.ts')], outfile: join(out, 'main.cjs') }),
  build({ ...common, entryPoints: [join(root, 'electron', 'preload.ts')], outfile: join(out, 'preload.cjs') }),
]);
