import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Rect, TileId, TileNode } from '../window-tree.js';
import { listIds, rects } from '../window-tree.js';
import { Tile, TILE_DRAG_TYPE } from './Tile.js';

export interface WorkspaceTileMeta {
  id: TileId;
  cwd: string;
  agentId: string | null;
  command?: string;
}

interface WorkspaceProps {
  sessionId: string;
  tree: TileNode | null;
  zoomedId: TileId | null;
  focusedId: TileId | null;
  tiles: Map<TileId, WorkspaceTileMeta>;
  onFocus(id: TileId): void;
  onClose(id: TileId): void;
  onZoom(id: TileId): void;
  onSwap(a: TileId, b: TileId): void;
  onSpawned(tileId: TileId, agentId: string): void;
}

const GAP = 8;

function useReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * FLIP: on reflow, existing tiles translate from their previous rect to the
 * new one (translate only — never scale, so terminal text never smears).
 * New tiles fade in; reduced motion skips all transitions.
 */
function useFlip(rectMap: Map<TileId, Rect>, elRefs: React.MutableRefObject<Map<TileId, HTMLDivElement | null>>): void {
  const prev = useRef<Map<TileId, Rect> | null>(null);
  const reduced = useReducedMotion();

  useLayoutEffect(() => {
    const before = prev.current;
    if (before !== null && !reduced) {
      for (const [id, rect] of rectMap) {
        const old = before.get(id);
        const el = elRefs.current.get(id);
        if (!old || !el) continue;
        const dx = old.x - rect.x;
        const dy = old.y - rect.y;
        if (dx === 0 && dy === 0) continue;
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        void el.offsetHeight; // force reflow
        el.style.transition = 'transform 240ms cubic-bezier(0.22, 1, 0.36, 1)';
        el.style.transform = '';
      }
    }
    prev.current = new Map(rectMap);
  }, [rectMap, reduced, elRefs]);
}

export function Workspace(props: WorkspaceProps): React.JSX.Element {
  const { sessionId, tree, zoomedId, focusedId, tiles, onFocus, onClose, onZoom, onSwap, onSpawned } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const elRefs = useRef<Map<TileId, HTMLDivElement | null>>(new Map());
  const [size, setSize] = useState({ w: 0, h: 0 });

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const box = { x: 0, y: 0, w: size.w, h: size.h, gap: GAP };
  const allRects = useMemo(() => {
    if (tree === null) return new Map<TileId, Rect>();
    return rects(tree, box);
  }, [tree, size]);

  // Zoom never unmounts tiles: the zoomed tile gets the full box, the others
  // stay mounted and are hidden with CSS — their PTYs keep running.
  const zoomed = zoomedId !== null && listIds(tree).includes(zoomedId);
  const rectMap = useMemo(() => {
    if (tree === null) return new Map<TileId, Rect>();
    if (!zoomed) return allRects;
    const full: Rect = { x: 0, y: 0, w: size.w, h: size.h };
    return new Map([...allRects].map(([id, r]) => [id, id === zoomedId ? full : r]));
  }, [tree, zoomed, zoomedId, allRects, size]);

  useFlip(rectMap, elRefs);

  const setRef = (id: TileId, el: HTMLDivElement | null): void => {
    if (el === null) elRefs.current.delete(id);
    else elRefs.current.set(id, el);
  };

  if (tree === null || rectMap.size === 0) {
    return (
      <div ref={hostRef} className="workspace-host">
        <div className="workspace-empty">
          <div className="workspace-empty-mark">FRAKTOLE<span className="boot-dot">.</span></div>
          <div className="workspace-empty-hint">ctrl+shift T — open a terminal tile</div>
        </div>
      </div>
    );
  }

  return (
    <div ref={hostRef} className="workspace-host">
      {[...rectMap.entries()].map(([id, rect]) => {
        const meta = tiles.get(id);
        const focused = focusedId === id;
        const isZoomed = zoomedId === id;
        return (
          <div
            key={id}
            ref={(el) => setRef(id, el)}
            className={`tile${focused ? ' tile-focused' : ''}${isZoomed ? ' tile-zoomed' : ''}${zoomed && !isZoomed ? ' tile-hidden' : ''}`}
            style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            onMouseDown={() => onFocus(id)}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(TILE_DRAG_TYPE)) e.preventDefault();
            }}
            onDrop={(e) => {
              const from = e.dataTransfer.getData(TILE_DRAG_TYPE);
              if (from && from !== id) onSwap(from, id);
            }}
          >
            <Tile
              sessionId={sessionId}
              id={id}
              cwd={meta?.cwd ?? id}
              zoomed={zoomed}
              agentId={meta?.agentId ?? null}
              command={meta?.command}
              onSpawned={(agentId) => onSpawned(id, agentId)}
              onClose={onClose}
              onZoom={onZoom}
              onDragStart={(dragged) => {
                if (dragged !== id) return;
                const el = elRefs.current.get(id);
                if (el) el.classList.add('tile-dragging');
              }}
              onDragEnd={(dragged) => {
                const el = elRefs.current.get(dragged);
                if (el) el.classList.remove('tile-dragging');
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
