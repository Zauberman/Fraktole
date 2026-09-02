import { describe, expect, it } from 'vitest';
import { classifyFile, nameClassFor } from '../src/file-kinds.js';

describe('classifyFile', () => {
  it('dirs are always folder', () => {
    expect(classifyFile('src', true)).toBe('folder');
    expect(classifyFile('node_modules', true)).toBe('folder');
    expect(classifyFile('.github', true)).toBe('folder');
  });

  it('code extensions', () => {
    for (const n of ['main.ts', 'App.tsx', 'util.js', 'run.py', 'lib.rs', 'go.mod.go', 'x.sh', 'c.vue']) {
      expect(classifyFile(n, false), n).toBe('code');
    }
  });

  it('doc extensions', () => {
    for (const n of ['README.md', 'notes.txt', 'guide.mdx', 'spec.pdf']) {
      expect(classifyFile(n, false), n).toBe('doc');
    }
  });

  it('config extensions', () => {
    for (const n of ['package.json', 'pnpm-lock.yaml', 'config.toml', '.env', 'settings.ini']) {
      expect(classifyFile(n, false), n).toBe('config');
    }
  });

  it('style extensions', () => {
    for (const n of ['theme.css', 'app.scss', 'index.html']) {
      expect(classifyFile(n, false), n).toBe('style');
    }
  });

  it('data extensions', () => {
    for (const n of ['schema.sql', 'export.csv', 'model.graphql', 'snap.db']) {
      expect(classifyFile(n, false), n).toBe('data');
    }
  });

  it('unknown extensions are neutral', () => {
    expect(classifyFile('blob.xyz', false)).toBe('other');
    expect(classifyFile('binary', false)).toBe('other');
  });

  it('dotfiles resolve by their real extension; bare rc dotfiles are config', () => {
    expect(classifyFile('.eslintrc.json', false)).toBe('config');
    expect(classifyFile('.gitignore', false)).toBe('config');
    expect(classifyFile('.npmrc', false)).toBe('config');
    expect(classifyFile('.bashrc', false)).toBe('config');
    expect(classifyFile('.prettierrc.toml', false)).toBe('config');
  });

  it('well-known extension-less names resolve by name', () => {
    expect(classifyFile('Makefile', false)).toBe('config');
    expect(classifyFile('justfile', false)).toBe('config');
    expect(classifyFile('Dockerfile', false)).toBe('config');
    expect(classifyFile('LICENSE', false)).toBe('doc');
    expect(classifyFile('README', false)).toBe('doc');
    expect(classifyFile('CHANGELOG', false)).toBe('doc');
  });

  it('case-insensitive', () => {
    expect(classifyFile('README.MD', false)).toBe('doc');
    expect(classifyFile('THEME.CSS', false)).toBe('style');
    expect(classifyFile('MAKEFILE', false)).toBe('config');
  });

  it('name class maps 1:1 to kinds', () => {
    expect(nameClassFor('folder')).toBe('tree-name-folder');
    expect(nameClassFor('other')).toBe('tree-name-other');
  });
});
