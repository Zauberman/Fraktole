import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confineOrThrow, confinePath } from '../electron/fs-scope.js';

let root = '';

beforeAll(async () => {
  root = join(tmpdir(), `fraktole-scope-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  await mkdir(join(root, 'proj', 'src'), { recursive: true });
  await writeFile(join(root, 'proj', 'src', 'a.ts'), 'x');
  await mkdir(join(root, 'outside'), { recursive: true });
  await writeFile(join(root, 'outside', 'secret.txt'), 's');
  await symlink(join(root, 'outside', 'secret.txt'), join(root, 'proj', 'leak.txt'));
  await mkdir(join(root, 'other'), { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('fs-scope confinement', () => {
  it('allows paths inside a registered root', async () => {
    const p = await confinePath([join(root, 'proj')], join(root, 'proj', 'src', 'a.ts'));
    expect(p).toBe(join(root, 'proj', 'src', 'a.ts'));
  });

  it('refuses paths outside every root', async () => {
    expect(await confinePath([join(root, 'proj')], join(root, 'outside', 'secret.txt'))).toBeNull();
  });

  it('refuses traversal escapes', async () => {
    expect(await confinePath([join(root, 'proj')], join(root, 'proj', '..', 'outside', 'secret.txt'))).toBeNull();
  });

  it('refuses non-absolute and junk targets', async () => {
    expect(await confinePath([join(root, 'proj')], 'src/a.ts')).toBeNull();
    expect(await confinePath([join(root, 'proj')], '')).toBeNull();
    expect(await confinePath([join(root, 'proj')], null)).toBeNull();
    expect(await confinePath([join(root, 'proj')], 42)).toBeNull();
  });

  it('allows a not-yet-existing file under an existing root dir', async () => {
    const p = await confinePath([join(root, 'proj')], join(root, 'proj', 'src', 'new-file.ts'));
    expect(p).toBe(join(root, 'proj', 'src', 'new-file.ts'));
  });

  it('refuses symlinks that point outside the roots', async () => {
    expect(await confinePath([join(root, 'proj')], join(root, 'proj', 'leak.txt'))).toBeNull();
  });

  it('confineOrThrow throws the scope error for escapes', async () => {
    await expect(confineOrThrow([join(root, 'proj')], join(root, 'other'))).rejects.toThrow('path is outside');
    await expect(confineOrThrow([join(root, 'proj')], join(root, 'proj', 'src', 'a.ts'))).resolves.toBe(
      join(root, 'proj', 'src', 'a.ts'),
    );
  });
});
