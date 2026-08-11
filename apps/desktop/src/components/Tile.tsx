import React from 'react';
import type { TileId } from '../window-tree.js';
import { Terminal } from './Terminal.js';

interface TileProps {
  id: TileId;
  cwd: string;
  zoomed: boolean;
  agentId?: string | null;
  onSpawned?(agentId: string): void;
  onClose(id: TileId): void;
  onZoom(id: TileId): void;
  onDragStart(id: TileId): void;
  onDragEnd(id: TileId): void;
}

export const TILE_DRAG_TYPE = 'text/fraktole-tile';

const ICONS = {
  zoom: (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
      <path
        d="M1 4 V1 H4 M10 7 V10 H7 M1 7 V10 H4 M10 4 V1 H7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="square"
      />
    </svg>
  ),
  close: (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
    </svg>
  ),
};

export function Tile(props: TileProps): React.JSX.Element {
  const { id, cwd, zoomed, agentId, onSpawned, onClose, onZoom, onDragStart, onDragEnd } = props;
  return (
    <>
      <header
        className="tile-title"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(TILE_DRAG_TYPE, id);
          e.dataTransfer.effectAllowed = 'move';
          onDragStart(id);
        }}
        onDragEnd={() => onDragEnd(id)}
      >
        <span className="tile-title-id" title={cwd}>
          {cwd}
        </span>
        <span className="tile-title-actions">
          <button
            type="button"
            className="tile-btn"
            title={zoomed ? 'unzoom' : 'zoom'}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onZoom(id)}
          >
            {ICONS.zoom}
          </button>
          <button
            type="button"
            className="tile-btn"
            title="close"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => onClose(id)}
          >
            {ICONS.close}
          </button>
        </span>
      </header>
      <div className="tile-body">
        <Terminal tileId={id} cwd={cwd} agentId={agentId} onSpawned={onSpawned} />
      </div>
    </>
  );
}
