import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { shell } from 'electron';

/** Atomic file write: tmp file + rename, so a crash mid-save can never
 *  leave a half-written editor file on disk. */
export async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.fraktole-tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

export async function mkdirForUser(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function createFileForUser(path: string): Promise<void> {
  // wx: refuse to clobber an existing file — the UI validates duplicates,
  // this is the backstop
  await writeFile(path, '', { encoding: 'utf8', flag: 'wx' });
}

export async function renameForUser(from: string, to: string): Promise<void> {
  await rename(from, to);
}

export async function trashForUser(path: string): Promise<void> {
  // never a hard delete — the OS trash is the undo path
  await shell.trashItem(path);
}
