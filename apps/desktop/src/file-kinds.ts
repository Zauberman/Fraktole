/**
 * File-kind classification for the explorer's color codes (icons were
 * removed in the vibrant-chrome rebase — a leading tick + name tint per
 * kind replaces them). Pure functions, no I/O.
 */

export type FileKind = 'folder' | 'code' | 'doc' | 'config' | 'style' | 'data' | 'other';

const CODE = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'hpp',
  'java', 'kt', 'swift', 'rb', 'php', 'sh', 'bash', 'zsh', 'fish', 'lua', 'dart',
  'vue', 'svelte', 'zig', 'ex', 'exs', 'erl', 'hs', 'ml', 'scala', 'pl', 'r', 'jl',
]);
const DOC = new Set(['md', 'mdx', 'txt', 'rst', 'adoc', 'pdf', 'org', 'tex']);
const CONFIG = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'lock', 'conf', 'cfg', 'xml', 'properties']);
const STYLE = new Set(['css', 'scss', 'sass', 'less', 'html', 'htm', 'pug', 'styl']);
const DATA = new Set(['sql', 'db', 'sqlite', 'csv', 'tsv', 'parquet', 'proto', 'graphql', 'prisma']);

/** Extension-less names that carry a well-known kind. */
const NAME_KINDS: ReadonlyMap<string, FileKind> = new Map([
  ['makefile', 'config'],
  ['justfile', 'config'],
  ['dockerfile', 'config'],
  ['containerfile', 'config'],
  ['license', 'doc'],
  ['copying', 'doc'],
  ['readme', 'doc'],
  ['changelog', 'doc'],
  ['authors', 'doc'],
  ['notice', 'doc'],
]);

function kindOfExt(ext: string): FileKind {
  if (CODE.has(ext)) return 'code';
  if (DOC.has(ext)) return 'doc';
  if (CONFIG.has(ext)) return 'config';
  if (STYLE.has(ext)) return 'style';
  if (DATA.has(ext)) return 'data';
  return 'other';
}

/**
 * Classifies a tree entry for color coding. Dotfiles keep the kind of
 * their real extension (`.eslintrc.json` → config); bare rc-style
 * dotfiles (`.gitignore`, `.npmrc`) are config; well-known extension-less
 * names (Makefile, LICENSE, README…) resolve by name.
 */
export function classifyFile(name: string, isDir: boolean): FileKind {
  if (isDir) return 'folder';
  const lower = name.toLowerCase();
  const named = NAME_KINDS.get(lower);
  if (named) return named;
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) {
    // no extension at all, or a bare dotfile (.gitignore) → config family
    return dot === 0 ? 'config' : 'other';
  }
  return kindOfExt(lower.slice(dot + 1));
}

/** The tree-name class for a kind (`tree-name-folder`, `tree-name-code`, …). */
export function nameClassFor(kind: FileKind): string {
  return `tree-name-${kind}`;
}
