import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRgLine, walkSearch } from '../electron/project-search.js';

describe('parseRgLine', () => {
  it('parses path:line:text rows', () => {
    expect(parseRgLine('src/a.ts:12:hello world')).toEqual({
      path: 'src/a.ts',
      line: 12,
      text: 'hello world',
    });
  });

  it('keeps colons inside the path and the text', () => {
    const hit = parseRgLine('a:b/c.ts:3:time 12:30');
    expect(hit).toEqual({ path: 'a:b/c.ts', line: 3, text: 'time 12:30' });
  });

  it('keeps empty hit text', () => {
    expect(parseRgLine('empty.ts:1:')).toEqual({ path: 'empty.ts', line: 1, text: '' });
  });

  it('rejects non-hit rows and bogus line numbers', () => {
    expect(parseRgLine('just some warning text')).toBeNull();
    expect(parseRgLine('file.ts:0:x')).toBeNull();
    expect(parseRgLine('file.ts:x:y')).toBeNull();
    expect(parseRgLine('')).toBeNull();
  });
});

describe('walkSearch', () => {
  it('finds case-insensitive matches and skips hidden, vendored and binary files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frakt-walk-'));
    await writeFile(join(root, 'a.ts'), 'nothing here\nNEEDLE found\nsecond needle line\n');
    await mkdir(join(root, 'deep'));
    await writeFile(join(root, 'deep', 'b.txt'), 'deep needle\n');
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'x.js'), 'vendored needle\n');
    await writeFile(join(root, '.hidden.txt'), 'secret needle\n');
    await writeFile(join(root, 'img.png'), 'binary needle\n');
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist', 'out.js'), 'built needle\n');

    const res = await walkSearch(root, 'needle');
    expect(res.engine).toBe('walk');
    expect(res.truncated).toBe(false);
    const paths = res.hits.map((h) => h.path);
    expect(paths).toContain(join(root, 'a.ts'));
    expect(paths).toContain(join(root, 'deep', 'b.txt'));
    expect(res.hits.filter((h) => h.path === join(root, 'a.ts')).length).toBe(2);
    expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.'))).toBe(false);
    expect(paths.some((p) => p.endsWith('.png'))).toBe(false);
    expect(paths.some((p) => p.includes('dist'))).toBe(false);
    await rm(root, { recursive: true, force: true });
  });

  it('caps matches per file at 5 and skips files over 512KB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frakt-walkcap-'));
    await writeFile(join(root, 'many.txt'), Array.from({ length: 8 }, (_, i) => `needle ${i}`).join('\n'));
    const bigTail = `${'filler '.repeat(1024)}needle\n`;
    await writeFile(join(root, 'big.log'), 'x'.repeat(513 * 1024 - bigTail.length) + bigTail);
    await writeFile(join(root, 'small.log'), 'a needle\n');

    const res = await walkSearch(root, 'needle');
    const manyHits = res.hits.filter((h) => h.path === join(root, 'many.txt'));
    expect(manyHits.length).toBe(5);
    expect(res.hits.some((h) => h.path === join(root, 'big.log'))).toBe(false);
    expect(res.hits.some((h) => h.path === join(root, 'small.log'))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it('respects the 200-hit total cap and flags truncation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frakt-walkmax-'));
    for (let i = 0; i < 210; i++) {
      await writeFile(join(root, `f${i}.txt`), 'capneedle\n');
    }
    const res = await walkSearch(root, 'capneedle');
    expect(res.hits.length).toBe(200);
    expect(res.truncated).toBe(true);
    await rm(root, { recursive: true, force: true });
  });
});
