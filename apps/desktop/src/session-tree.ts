import type { SerNode } from './shared/ipc.js';
import type { TileId, TileNode } from './window-tree.js';

/** Live tree (ephemeral tile ids) → persisted tree (durable agent ids).
 *  Pure and renderer-safe: the renderer builds the save payload, main
 *  persists it. */
export function treeToSer(tree: TileNode | null, agentOf: (tileId: TileId) => string | null): SerNode | null {
  if (tree === null) return null;
  if (tree.kind === 'leaf') {
    const agentId = agentOf(tree.id);
    if (agentId === null) throw new Error(`tile ${tree.id} has no agent id yet`);
    return { k: 'leaf', agentId };
  }
  return {
    k: 'split',
    dir: tree.dir,
    ratio: tree.ratio,
    a: treeToSer(tree.a, agentOf)!,
    b: treeToSer(tree.b, agentOf)!,
  };
}

/** Persisted tree (agent ids) → live tree (fresh tile ids). Throws when the
 *  tree references an agent the session does not know — a loud failure beats
 *  spawning a ghost tile. */
export function treeFromSer(ser: SerNode | null, tileOf: (agentId: string) => TileId | null): TileNode | null {
  if (ser === null) return null;
  if (ser.k === 'leaf') {
    const id = tileOf(ser.agentId);
    if (id === null) throw new Error(`unknown agent in tree: ${ser.agentId}`);
    return { kind: 'leaf', id };
  }
  return {
    kind: 'split',
    dir: ser.dir,
    ratio: ser.ratio,
    a: treeFromSer(ser.a, tileOf)!,
    b: treeFromSer(ser.b, tileOf)!,
  };
}
