export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** the dwindle split tree: 'row' = side-by-side (vertical split), 'col' = stacked */
export type LayoutNode =
  | { kind: 'leaf'; index: number; rect: Rect }
  | { kind: 'split'; dir: 'row' | 'col'; a: LayoutNode; b: LayoutNode };

export interface DwindleResult {
  tiles: Rect[];
  tree: LayoutNode;
}

function largestIndex(tiles: Rect[]): number {
  let best = 0;
  let bestArea = -1;
  tiles.forEach((t, i) => {
    const area = t.width * t.height;
    if (area > bestArea) {
      bestArea = area;
      best = i;
    }
  });
  return best;
}

function splitHorizontal(t: Rect): [Rect, Rect] {
  const aH = Math.max(1, Math.floor(t.height / 2));
  return [
    { ...t, height: aH },
    { ...t, y: t.y + aH, height: t.height - aH },
  ];
}

function splitVertical(t: Rect): [Rect, Rect] {
  const aW = Math.max(1, Math.floor(t.width / 2));
  return [
    { ...t, width: aW },
    { ...t, x: t.x + aW, width: t.width - aW },
  ];
}

/**
 * Hyprland-style dwindle: each new window splits the largest tile, alternating
 * horizontal/vertical. Returns both the flat rects (for tests/analysis) and
 * the split tree (which maps directly to nested row/column flex layouts).
 */
export function dwindle(n: number, area: Rect): DwindleResult {
  const tiles: Rect[] = [{ ...area }];
  const pos: number[] = [0]; // flat position -> window number
  let tree: LayoutNode = { kind: 'leaf', index: 0, rect: { ...area } };
  let vertical = false;
  for (let i = 1; i < n; i++) {
    const idx = largestIndex(tiles);
    const t = tiles[idx]!;
    const window = pos[idx]!;
    if (t.height < 2 || t.width < 4) {
      const degenerate: Rect = { x: t.x, y: t.y, width: 0, height: 0 };
      tiles.push(degenerate);
      pos.push(i);
      tree = replaceLeaf(tree, window, {
        kind: 'split',
        dir: 'col',
        a: { kind: 'leaf', index: window, rect: { ...t } },
        b: { kind: 'leaf', index: i, rect: degenerate },
      });
      continue;
    }
    const [a, b] = vertical ? splitVertical(t) : splitHorizontal(t);
    tiles.splice(idx, 1, a, b);
    pos.splice(idx, 1, window, i);
    const split: LayoutNode = {
      kind: 'split',
      dir: vertical ? 'row' : 'col',
      a: { kind: 'leaf', index: window, rect: a },
      b: { kind: 'leaf', index: i, rect: b },
    };
    tree = replaceLeaf(tree, window, split);
    vertical = !vertical;
  }
  return { tiles, tree };
}

/** walks the tree and swaps the leaf with `index` for `replacement` */
function replaceLeaf(node: LayoutNode, index: number, replacement: LayoutNode): LayoutNode {
  if (node.kind === 'leaf') {
    return node.index === index ? replacement : node;
  }
  return {
    ...node,
    a: replaceLeaf(node.a, index, replacement),
    b: replaceLeaf(node.b, index, replacement),
  };
}

export function tileWindows(n: number, area: Rect): Rect[] {
  return dwindle(n, area).tiles;
}

/** order tiles for display: largest first (the focused window reads first) */
export function displayOrder(tiles: Rect[]): number[] {
  return tiles
    .map((t, i) => ({ t, i }))
    .sort((a, b) => b.t.width * b.t.height - a.t.width * a.t.height)
    .map((x) => x.i);
}
