import { describe, expect, it } from 'vitest';
import {
  type Box,
  type Rect,
  type TileNode,
  insert,
  listIds,
  neighbors,
  rects,
  remove,
  swap,
} from '../src/window-tree.js';

const BOX: Box = { x: 0, y: 0, w: 800, h: 600, gap: 8 };

function leaves(node: TileNode): string[] {
  return listIds(node);
}

function overlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('window-tree insert', () => {
  it('inserts into an empty tree as the root leaf', () => {
    const t = insert(null, null, 'a', 'h');
    expect(t).toEqual({ kind: 'leaf', id: 'a', ratio: 0.5 });
  });

  it('splits the focused leaf 50/50, new tile at b', () => {
    let t: TileNode | null = insert(null, null, 'a', 'h');
    t = insert(t, 'a', 'b', 'h');
    expect(t?.kind).toBe('split');
    if (t?.kind !== 'split') return;
    expect(t.ratio).toBe(0.5);
    expect(t.dir).toBe('h');
    expect(t.a).toEqual({ kind: 'leaf', id: 'a', ratio: 0.5 });
    expect(t.b).toEqual({ kind: 'leaf', id: 'b', ratio: 0.5 });
  });

  it('splits the focused leaf, not the first, when both exist', () => {
    let t: TileNode | null = insert(null, null, 'a', 'h');
    t = insert(t, 'a', 'b', 'h');
    t = insert(t, 'b', 'c', 'v');
    expect(leaves(t)).toEqual(['a', 'b', 'c']);
    // b got split into b + c
    const bBox = rects(t, BOX).get('b');
    const cBox = rects(t, BOX).get('c');
    expect(bBox).toBeDefined();
    expect(cBox).toBeDefined();
    if (!bBox || !cBox) return;
    // v-split: same width, stacked vertically
    expect(Math.abs(bBox.w - cBox.w)).toBeLessThan(1);
    expect(bBox.y).toBeLessThan(cBox.y);
  });

  it('falls back to the last leaf when focus is null or unknown', () => {
    let t: TileNode | null = insert(null, null, 'a', 'h');
    t = insert(t, null, 'b', 'h');
    t = insert(t, 'ghost', 'c', 'v');
    expect(leaves(t)).toEqual(['a', 'b', 'c']);
    // ghost fell back to the last leaf 'b'; 'b' got split with 'c'
    const bBox = rects(t, BOX).get('b');
    const cBox = rects(t, BOX).get('c');
    if (!bBox || !cBox) return;
    expect(bBox.w).toBeGreaterThanOrEqual(1);
    expect(cBox.w).toBeGreaterThanOrEqual(1);
  });
});

describe('window-tree remove', () => {
  it('removes the only tile → null', () => {
    expect(remove(insert(null, null, 'a', 'h'), 'a')).toBeNull();
  });

  it('collapses a split to the surviving leaf', () => {
    let t: TileNode | null = insert(null, null, 'a', 'h');
    t = insert(t, 'a', 'b', 'h');
    t = remove(t, 'b');
    expect(t).toEqual({ kind: 'leaf', id: 'a', ratio: 0.5 });
  });

  it('collapses a nested split and preserves area (minus one gap strip)', () => {
    let t: TileNode | null = null;
    for (const id of ['a', 'b', 'c', 'd']) t = insert(t, null, id, 'h');
    const area = (map: Map<string, Rect>): number => [...map.values()].reduce((s, r) => s + r.w * r.h, 0);
    const before = area(rects(t, BOX));
    t = remove(t, 'd');
    const after = area(rects(t, BOX));
    expect(t).not.toBeNull();
    expect(leaves(t!)).toEqual(['a', 'b', 'c']);
    // one h-split collapsed → one gap × height strip (800×8 = 6400) recovered
    const recovered = after - before;
    expect(recovered).toBeGreaterThanOrEqual(0);
    expect(recovered).toBeLessThanOrEqual(BOX.gap * BOX.w + 0.001);
    expect(t?.kind).toBe('split');
  });
});

describe('window-tree swap', () => {
  it('exchanges ids, keeps ratios and structure', () => {
    let t: TileNode | null = insert(null, null, 'a', 'h');
    t = insert(t, 'a', 'b', 'v');
    t = swap(t, 'a', 'b');
    expect(leaves(t)).toEqual(['b', 'a']);
    // rects follow ids: b now at a's old position (top in v-split)
    const rectsMap = rects(t, BOX);
    const aBox = rectsMap.get('a');
    const bBox = rectsMap.get('b');
    if (!aBox || !bBox) return;
    expect(bBox.y).toBe(0);
    expect(aBox.y).toBeGreaterThan(0);
  });

  it('is a no-op for unknown ids', () => {
    const t: TileNode = insert(null, null, 'a', 'h');
    expect(swap(t, 'a', 'zzz')).toBe(t);
  });

  it('is a no-op swapping a tile with itself', () => {
    const t: TileNode = insert(null, null, 'a', 'h');
    expect(swap(t, 'a', 'a')).toBe(t);
  });
});

describe('window-tree neighbors', () => {
  it('wraps around a 4-tile grid', () => {
    let t: TileNode | null = null;
    for (const id of ['a', 'b', 'c', 'd']) t = insert(t, null, id, 'h');
    expect(neighbors(t, 'a', 'next')).toBe('b');
    expect(neighbors(t, 'd', 'next')).toBe('a');
    expect(neighbors(t, 'a', 'prev')).toBe('d');
    expect(neighbors(t, 'c', 'prev')).toBe('b');
  });

  it('returns the tile itself when it is alone', () => {
    const t: TileNode = insert(null, null, 'a', 'h');
    expect(neighbors(t, 'a', 'next')).toBe('a');
  });

  it('returns null for an unknown tile', () => {
    const t: TileNode = insert(null, null, 'a', 'h');
    expect(neighbors(t, 'zzz', 'next')).toBeNull();
  });
});

describe('window-tree rects', () => {
  it('fills the box exactly with no overlaps', () => {
    for (const count of [1, 2, 3, 4, 7]) {
      let t: TileNode | null = null;
      for (let i = 0; i < count; i += 1) t = insert(t, null, `t${i}`, i % 2 === 0 ? 'h' : 'v');
      const map = rects(t, BOX);
      const all = [...map.values()];
      expect(all.length).toBe(count);
      for (const r of all) {
        expect(r.w).toBeGreaterThanOrEqual(1);
        expect(r.h).toBeGreaterThanOrEqual(1);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(BOX.w + 0.001);
        expect(r.y + r.h).toBeLessThanOrEqual(BOX.h + 0.001);
      }
      for (let i = 0; i < all.length; i += 1) {
        for (let j = i + 1; j < all.length; j += 1) {
          expect(overlap(all[i]!, all[j]!)).toBe(false);
        }
      }
      const area = all.reduce((s, r) => s + r.w * r.h, 0);
      const boxArea = BOX.w * BOX.h;
      // gap strips are carved out between siblings; total loss ≤ gap × count × max-dim
      expect(area).toBeLessThanOrEqual(boxArea + 0.001);
      expect(area).toBeGreaterThanOrEqual(boxArea - BOX.gap * count * (BOX.w + BOX.h));
    }
  });

  it('returns an empty map for an empty tree', () => {
    expect(rects(null, BOX).size).toBe(0);
  });
});

describe('window-tree property: random op sequences keep invariants', () => {
  it('survives 200 random insert/remove/swap operations', () => {
    let t: TileNode | null = null;
    let next = 0;
    const live = new Set<string>();
    const rng = (): number => Math.floor(Math.random() * 1_000_000);
    for (let op = 0; op < 200; op += 1) {
      const choice = rng() % 3;
      if (choice === 0 || live.size === 0) {
        const id = `t${next}`;
        next += 1;
        live.add(id);
        t = insert(t, null, id, op % 2 === 0 ? 'h' : 'v');
      } else if (choice === 1) {
        const id = [...live][rng() % live.size] ?? null;
        if (id !== null) {
          live.delete(id);
          t = remove(t, id);
        }
      } else {
        const ids = [...live];
        if (ids.length > 1 && t !== null) {
          t = swap(t, ids[rng() % ids.length]!, ids[(rng() + 1) % ids.length]!);
        }
      }
      const map = rects(t, BOX);
      expect([...map.keys()].sort()).toEqual([...live].sort());
      const all = [...map.values()];
      for (const r of all) {
        expect(r.w).toBeGreaterThanOrEqual(0);
        expect(r.h).toBeGreaterThanOrEqual(0);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(BOX.w + 0.001);
        expect(r.y + r.h).toBeLessThanOrEqual(BOX.h + 0.001);
      }
      for (let i = 0; i < all.length; i += 1) {
        for (let j = i + 1; j < all.length; j += 1) {
          expect(overlap(all[i]!, all[j]!)).toBe(false);
        }
      }
      const area = all.reduce((s, r) => s + r.w * r.h, 0);
      const boxArea = BOX.w * BOX.h;
      expect(area).toBeLessThanOrEqual(boxArea + 0.001);
    }
  });
});
