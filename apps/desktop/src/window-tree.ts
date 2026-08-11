export type TileId = string;
export type SplitDir = 'h' | 'v';

/**
 * Binary split tree. A split has exactly two children; a leaf carries the
 * ratio of its own share along the parent split's direction (meaningless at
 * the root, which is always a leaf or a split, never empty).
 */
export type TileNode =
  | { kind: 'leaf'; id: TileId; ratio: number }
  | { kind: 'split'; dir: SplitDir; ratio: number; a: TileNode; b: TileNode };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  gap: number;
}

function leaf(id: TileId): TileNode {
  return { kind: 'leaf', id, ratio: 0.5 };
}

function setLeafRatio(node: TileNode, ratio: number): TileNode {
  if (node.kind === 'leaf') return { ...node, ratio };
  return { ...node, ratio };
}

/** DFS pre-order: parent split visited, then a, then b. */
export function walk(node: TileNode | null, visit: (n: TileNode) => void): void {
  if (!node) return;
  visit(node);
  if (node.kind === 'split') {
    walk(node.a, visit);
    walk(node.b, visit);
  }
}

export function listIds(root: TileNode | null): TileId[] {
  const ids: TileId[] = [];
  walk(root, (n) => {
    if (n.kind === 'leaf') ids.push(n.id);
  });
  return ids;
}

type LeafNode = Extract<TileNode, { kind: 'leaf' }>;

function findLeaf(node: TileNode, id: TileId): LeafNode | null {
  let found: LeafNode | null = null;
  walk(node, (n) => {
    if (n.kind === 'leaf' && n.id === id) found = n;
  });
  return found;
}

/**
 * Splits the focused leaf into two halves, placing the new tile at `b`.
 * No focus (or unknown focus) appends after the last leaf in DFS order.
 */
export function insert(root: TileNode | null, focus: TileId | null, id: TileId, dir: SplitDir): TileNode {
  if (root === null) return leaf(id);
  const ids = listIds(root);
  const target = focus !== null && ids.includes(focus) ? focus : (ids[ids.length - 1] ?? null);
  if (target === null) return root;
  return insertAt(root, target, id, dir);
}

function insertAt(node: TileNode, targetId: TileId, newId: TileId, dir: SplitDir): TileNode {
  if (node.kind === 'leaf' && node.id === targetId) {
    return { kind: 'split', dir, ratio: 0.5, a: { ...node }, b: leaf(newId) };
  }
  if (node.kind === 'leaf') return node;
  if (node.a.kind === 'leaf' && node.a.id === targetId) {
    return { ...node, a: { kind: 'split', dir, ratio: 0.5, a: { ...node.a }, b: leaf(newId) } };
  }
  if (node.b.kind === 'leaf' && node.b.id === targetId) {
    return { ...node, b: { kind: 'split', dir, ratio: 0.5, a: { ...node.b }, b: leaf(newId) } };
  }
  return { ...node, a: insertAt(node.a, targetId, newId, dir), b: insertAt(node.b, targetId, newId, dir) };
}

/**
 * Removes a leaf, collapsing single-child splits. The surviving subtree keeps
 * the removed split's share: leaves inherit its ratio, splits re-wrap with it.
 */
export function remove(root: TileNode | null, id: TileId): TileNode | null {
  if (root === null) return null;
  if (root.kind === 'leaf') return root.id === id ? null : root;

  const a2 = removeFromSplitChild(root.a, id);
  const b2 = removeFromSplitChild(root.b, id);
  if (a2 !== null && b2 !== null) return { ...root, a: a2, b: b2 };
  if (a2 !== null) return promote(a2, root.ratio);
  if (b2 !== null) return promote(b2, 1 - root.ratio);
  return null;
}

function removeFromSplitChild(node: TileNode, id: TileId): TileNode | null {
  if (node.kind === 'leaf') return node.id === id ? null : node;
  return remove(node, id);
}

/** The surviving child inherits the removed split's share of its parent. */
function promote(child: TileNode, ratio: number): TileNode {
  if (child.kind === 'leaf') return setLeafRatio(child, ratio);
  return { ...child, a: setLeafRatio(child.a, ratio), b: setLeafRatio(child.b, ratio) };
}

/** Exchanges the ids of two leaves; structure and ratios untouched. */
export function swap(root: TileNode, a: TileId, b: TileId): TileNode {
  if (a === b) return root;
  const clone: TileNode = root.kind === 'leaf' ? { ...root } : { ...root, a: root.a, b: root.b };
  const aLeaf = findLeaf(clone, a);
  const bLeaf = findLeaf(clone, b);
  if (!aLeaf || !bLeaf) return root;
  const idA = aLeaf.id;
  aLeaf.id = bLeaf.id;
  bLeaf.id = idA;
  return clone;
}

/** DFS-order adjacency for keyboard focus moves; wraps around the list. */
export function neighbors(root: TileNode | null, id: TileId, dir: 'prev' | 'next'): TileId | null {
  const ids = listIds(root);
  const i = ids.indexOf(id);
  if (i === -1) return null;
  if (ids.length === 1) return id;
  if (dir === 'next') return ids[(i + 1) % ids.length] ?? null;
  return ids[(i - 1 + ids.length) % ids.length] ?? null;
}

/**
 * Absolute rects for every leaf. A split carves its box along `dir`
 * (`h` → x/w, `v` → y/h) by `ratio`, subtracting `gap` once between children.
 */
export function rects(root: TileNode | null, box: Box): Map<TileId, Rect> {
  const out = new Map<TileId, Rect>();
  if (root === null) return out;
  assign(root, box, out);
  return out;
}

function assign(node: TileNode, box: Box, out: Map<TileId, Rect>): void {
  if (node.kind === 'leaf') {
    out.set(node.id, { x: box.x, y: box.y, w: box.w, h: box.h });
    return;
  }
  const gap = box.gap;
  if (node.dir === 'h') {
    const wA = Math.max(0, box.w * node.ratio - gap / 2);
    const wB = Math.max(0, box.w - wA - gap);
    // when the box is smaller than the gap, the gap must not push b past the edge
    const xB = box.x + Math.min(wA + gap, box.w - wB);
    const aBox: Box = { ...box, w: wA };
    const bBox: Box = { ...box, x: xB, w: wB };
    assign(node.a, aBox, out);
    assign(node.b, bBox, out);
  } else {
    const hA = Math.max(0, box.h * node.ratio - gap / 2);
    const hB = Math.max(0, box.h - hA - gap);
    const yB = box.y + Math.min(hA + gap, box.h - hB);
    const aBox: Box = { ...box, h: hA };
    const bBox: Box = { ...box, y: yB, h: hB };
    assign(node.a, aBox, out);
    assign(node.b, bBox, out);
  }
}
