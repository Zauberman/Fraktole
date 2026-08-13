import type { TileId } from './window-tree.js';

/** Focus targets in the node view: an agent tile, or the reviewer column
 *  (the right-hand pane). The reviewer joins the tile cycle — prev from the
 *  leftmost tile lands on it, next from it lands on the first tile. */

export type FocusTarget = { kind: 'tile'; id: TileId } | { kind: 'reviewer' };

export function nextFocusTarget(
  ids: TileId[],
  focusedId: TileId | null,
  reviewerFocused: boolean,
  dir: 'prev' | 'next',
): FocusTarget {
  if (reviewerFocused) {
    if (ids.length === 0) return { kind: 'reviewer' };
    return dir === 'next' ? { kind: 'tile', id: ids[0]! } : { kind: 'tile', id: ids[ids.length - 1]! };
  }
  const idx = focusedId === null ? -1 : ids.indexOf(focusedId);
  if (idx === -1) {
    // no focus yet: next lands on the first tile, prev on the reviewer
    return dir === 'next' && ids.length > 0 ? { kind: 'tile', id: ids[0]! } : { kind: 'reviewer' };
  }
  if (dir === 'prev' && idx === 0) return { kind: 'reviewer' };
  if (ids.length === 1) return { kind: 'tile', id: ids[0]! };
  if (dir === 'next') return { kind: 'tile', id: ids[(idx + 1) % ids.length]! };
  return { kind: 'tile', id: ids[(idx - 1 + ids.length) % ids.length]! };
}
