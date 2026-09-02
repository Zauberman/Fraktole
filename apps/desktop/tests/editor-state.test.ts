import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // file-state imports ipc.js which reads window.fraktole at module scope;
  // provide a stub before that import executes
  (globalThis as unknown as { window: { fraktole: Record<string, never> } }).window = { fraktole: {} };
});

import {
  loadPersistedTabs,
  markSaved,
  markStale,
  neighborAfterClose,
  parsePersistedTabs,
  savePersistedTabs,
  serializeTabs,
  tabsStorageKey,
  type OpenFile,
} from '../src/file-state.js';

function file(path: string, extra: Partial<OpenFile> = {}): OpenFile {
  const name = path.split('/').pop() ?? path;
  return { path, name, content: '', lang: 'plaintext', dirty: false, readOnly: false, stale: false, ...extra };
}

function makeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear(): void {
      map.clear();
    },
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    key(index: number): string | null {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    setItem(key: string, value: string): void {
      map.set(key, value);
    },
  };
}

describe('neighborAfterClose', () => {
  it('closing the active tab activates the right neighbor, else the left, else null', () => {
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((p) => file(p));
    expect(neighborAfterClose(files, 'a.ts')).toBe('b.ts');
    expect(neighborAfterClose(files, 'c.ts')).toBe('d.ts');
    expect(neighborAfterClose(files, 'd.ts')).toBe('c.ts');
  });

  it('repeated closes walk to the left once the right edge is gone', () => {
    let files = ['a.ts', 'b.ts', 'c.ts'].map((p) => file(p));
    expect(neighborAfterClose(files, 'c.ts')).toBe('b.ts');
    files = files.filter((f) => f.path !== 'c.ts');
    expect(neighborAfterClose(files, 'b.ts')).toBe('a.ts');
    files = files.filter((f) => f.path !== 'b.ts');
    expect(neighborAfterClose(files, 'a.ts')).toBeNull();
  });

  it('a path that is not in the list yields null', () => {
    const files = ['a.ts'].map((p) => file(p));
    expect(neighborAfterClose(files, 'missing.ts')).toBeNull();
    expect(neighborAfterClose([], 'a.ts')).toBeNull();
  });
});

describe('tab persistence', () => {
  it('round-trips through localStorage, namespaced per project', () => {
    const storage = makeStorage();
    const files = ['/p/x.ts', '/p/y.md', '/p/z.json'].map((p) => file(p));
    const tabs = serializeTabs(files, '/p/y.md');
    savePersistedTabs('/p', tabs, storage);
    expect(storage.getItem(tabsStorageKey('/p'))).toBe(JSON.stringify(tabs));
    expect(loadPersistedTabs('/p', storage)).toEqual(tabs);
    expect(loadPersistedTabs('/other', storage)).toEqual([]);
  });

  it('caps the persisted list at 20 entries and keeps the active tab', () => {
    const files = Array.from({ length: 25 }, (_, i) => file(`/p/f${i}.ts`));
    const tabs = serializeTabs(files, '/p/f24.ts');
    expect(tabs.length).toBe(20);
    expect(tabs.filter((t) => t.active)).toEqual([{ path: '/p/f24.ts', active: true }]);
  });

  it('serializes exactly one active flag matching activePath', () => {
    const files = ['/p/x.ts', '/p/y.md'].map((p) => file(p));
    expect(serializeTabs(files, null)).toEqual([
      { path: '/p/x.ts', active: false },
      { path: '/p/y.md', active: false },
    ]);
    expect(serializeTabs(files, '/p/x.ts')).toEqual([
      { path: '/p/x.ts', active: true },
      { path: '/p/y.md', active: false },
    ]);
  });

  it('parses tolerantly: junk, wrong shapes and duplicates are dropped', () => {
    expect(parsePersistedTabs(null)).toEqual([]);
    expect(parsePersistedTabs('not json')).toEqual([]);
    expect(parsePersistedTabs('{"path": "/p/x.ts"}')).toEqual([]);
    expect(parsePersistedTabs('[{"nope": true}, {"path": ""}, {"path": "/p/x.ts"}, {"path": "/p/x.ts"}]')).toEqual([
      { path: '/p/x.ts', active: false },
    ]);
    expect(parsePersistedTabs('[{"path": "/p/x.ts", "active": true}]')).toEqual([{ path: '/p/x.ts', active: true }]);
  });

  it('builds the documented storage key', () => {
    expect(tabsStorageKey('/home/me/proj')).toBe('fraktole.openTabs./home/me/proj');
  });
});

describe('stale tracking', () => {
  it('marks the changed file stale and leaves its other flags alone', () => {
    const files = [file('/p/a.ts'), file('/p/b.ts', { dirty: true })];
    const next = markStale(files, '/p/b.ts');
    expect(next.find((f) => f.path === '/p/b.ts')?.stale).toBe(true);
    expect(next.find((f) => f.path === '/p/b.ts')?.dirty).toBe(true);
    expect(next.find((f) => f.path === '/p/a.ts')?.stale).toBe(false);
  });

  it('markStale is identity-stable when nothing changes', () => {
    const files = [file('/p/a.ts')];
    expect(markStale(files, '/p/missing.ts')).toBe(files);
    const once = markStale(files, '/p/a.ts');
    expect(markStale(once, '/p/a.ts')).toBe(once);
  });

  it('saving clears both dirty and stale for that file only', () => {
    const mixed = [file('/p/a.ts', { dirty: true, stale: true }), file('/p/b.ts', { dirty: true })];
    const after = markSaved(mixed, '/p/a.ts');
    expect(after.find((f) => f.path === '/p/a.ts')?.dirty).toBe(false);
    expect(after.find((f) => f.path === '/p/a.ts')?.stale).toBe(false);
    expect(after[1]).toBe(mixed[1]);
  });

  it('markSaved is identity-stable for an already clean list', () => {
    const files = [file('/p/a.ts')];
    expect(markSaved(files, '/p/a.ts')).toBe(files);
  });
});
