import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, 'src', 'assets', 'fonts');
await mkdir(outDir, { recursive: true });

const FAMILIES = [
  ['space-grotesk', 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500&display=swap'],
  ['jetbrains-mono', 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap'],
  ['instrument-serif', 'https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap'],
  ['ibm-plex-mono', 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap'],
];

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

for (const [family, cssUrl] of FAMILIES) {
  const res = await fetch(cssUrl, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`font css ${cssUrl} -> HTTP ${res.status}`);
  const css = await res.text();

  const blocks = css.split('}');
  let count = 0;
  for (const block of blocks) {
    const urlMatch = block.match(/url\((https:\/\/[^)]+\.woff2)\)/);
    const weightMatch = block.match(/font-weight:\s*(\d+)/);
    const styleMatch = block.match(/font-style:\s*(\w+)/);
    if (!urlMatch || !urlMatch[1]) continue;
    const weight = weightMatch?.[1] ?? '400';
    const style = styleMatch?.[1] ?? 'normal';
    const url = urlMatch[1];
    const file = `${family}-${weight}${style !== 'normal' ? `-${style}` : ''}.woff2`;
    const font = await fetch(url);
    if (!font.ok) throw new Error(`font ${file} -> HTTP ${font.status}`);
    await writeFile(join(outDir, file), Buffer.from(await font.arrayBuffer()));
    console.log(`downloaded ${file}`);
    count += 1;
  }
  if (count === 0) throw new Error(`no woff2 urls parsed for ${family}`);
}
console.log(`fonts ready in src/assets/fonts/ (${FAMILIES.length} families)`);
