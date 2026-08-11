import { describe, expect, it } from 'vitest';
import { displayOrder, dwindle, tileWindows, type LayoutNode, type Rect } from '../src/layout.js';

const AREA: Rect = { x: 0, y: 0, width: 100, height: 40 };

function total(tiles: Rect[]): number {
  return tiles.reduce((n, t) => n + t.width * t.height, 0);
}

describe('tileWindows (dwindle)', () => {
  it('gives a single window the full area', () => {
    const tiles = tileWindows(1, AREA);
    expect(tiles).toEqual([{ x: 0, y: 0, width: 100, height: 40 }]);
  });

  it('splits two windows horizontally', () => {
    const tiles = tileWindows(2, AREA);
    expect(tiles[0]).toEqual({ x: 0, y: 0, width: 100, height: 20 });
    expect(tiles[1]).toEqual({ x: 0, y: 20, width: 100, height: 20 });
  });

  it('gives three windows an asymmetric dwindle layout', () => {
    const tiles = tileWindows(3, AREA);
    // first-largest tie-break: the left half splits vertically, the right
    // half keeps the full height — asymmetric by design
    expect(tiles[0]).toEqual({ x: 0, y: 0, width: 50, height: 20 });
    expect(tiles[1]).toEqual({ x: 50, y: 0, width: 50, height: 20 });
    expect(tiles[2]).toEqual({ x: 0, y: 20, width: 100, height: 20 });
  });

  it('keeps splitting the largest tile for four', () => {
    const tiles = tileWindows(4, AREA);
    expect(tiles[0]).toEqual({ x: 0, y: 0, width: 50, height: 20 });
    expect(tiles[1]).toEqual({ x: 50, y: 0, width: 50, height: 20 });
    expect(tiles[2]).toEqual({ x: 0, y: 20, width: 100, height: 10 });
    expect(tiles[3]).toEqual({ x: 0, y: 30, width: 100, height: 10 });
  });

  it('never leaves gaps: total area is preserved', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 8]) {
      const tiles = tileWindows(n, AREA);
      expect(total(tiles)).toBe(AREA.width * AREA.height);
      for (const t of tiles) {
        expect(t.width).toBeGreaterThanOrEqual(0);
        expect(t.height).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('degrades gracefully on tiny areas (no zero-size beyond the guard)', () => {
    const tiny: Rect = { x: 0, y: 0, width: 10, height: 3 };
    const tiles = tileWindows(6, tiny);
    // every tile fits within the area bounds
    for (const t of tiles) {
      expect(t.x + t.width).toBeLessThanOrEqual(tiny.width);
      expect(t.y + t.height).toBeLessThanOrEqual(tiny.height);
    }
  });

  it('displayOrder sorts largest first', () => {
    const tiles = tileWindows(3, AREA);
    const order = displayOrder(tiles);
    const sizes = order.map((i) => tiles[i]!.width * tiles[i]!.height);
    expect(sizes[0]!).toBeGreaterThanOrEqual(sizes[1]!);
    expect(sizes[1]!).toBeGreaterThanOrEqual(sizes[2]!);
  });

  it('builds a split tree whose leaves match the tiles', () => {
    const { tiles, tree } = dwindle(6, AREA);
    const leaves: Rect[] = [];
    const collect = (node: LayoutNode): void => {
      if (node.kind === 'leaf') leaves.push(node.rect);
      else {
        collect(node.a);
        collect(node.b);
      }
    };
    collect(tree);
    expect(leaves).toHaveLength(6);
    // every leaf rect exists in the flat tile list
    for (const r of leaves) {
      expect(tiles).toContainEqual(r);
    }
  });
});
