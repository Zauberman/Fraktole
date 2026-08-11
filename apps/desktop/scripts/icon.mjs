import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const svg = await readFile(join(root, 'build', 'icon.svg'));
await sharp(svg)
  .resize(512, 512)
  .png()
  .toFile(join(root, 'build', 'icon.png'));
console.log('build/icon.png written (512x512)');
