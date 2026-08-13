import React, { useEffect, useRef } from 'react';
import { Workspace } from './Workspace.js';
import { Divider } from './Divider.js';
import { ReviewerTab } from './ReviewerTab.js';
import { useSessionState, type SessionState } from '../session-state.js';
import { bridge, type SessionStatus } from '../ipc.js';
import type { SessionSummary } from '../ipc.js';
import type { AppTab } from './TopBar.js';

export interface ActiveInfo {
  tileCount: number;
  focusedCwd: string | null;
  sessionName: string | null;
  state: SessionStatus;
  projectPath: string | null;
}

interface SessionViewProps {
  sessionId: string;
  active: boolean;
  tab: AppTab;
  sessions: SessionSummary[];
  sideRightPct: number;
  onDragRight(clientX: number): void;
  onActivate(sessionId: string): void;
  onNewSession(name: string): void;
  onDeleteSession(sessionId: string): void;
  onStopSession(sessionId: string): void;
  onStartSession(sessionId: string): void;
  registerState(sessionId: string, state: SessionState): () => void;
  onActiveInfo(info: ActiveInfo): void;
}

/**
 * One session's live view. Stays mounted (hidden via CSS) while another
 * session is active, so its PTYs keep running and its terminal buffers keep
 * streaming — the keep-alive core. The Node tab shows the tiling workspace
 * plus the reviewer column on the right; the top-bar Reviewer tab is an
 * empty placeholder reserved for a future feature.
 */
export function SessionView(props: SessionViewProps): React.JSX.Element {
  const {
    sessionId,
    active,
    tab,
    sideRightPct,
    onDragRight,
    registerState,
    onActiveInfo,
  } = props;
  const ws = useSessionState(sessionId);
  // (re)activate when this view becomes the active session
  useEffect(() => {
    if (active) void ws.reactivate();
  }, [active, ws.reactivate]);

  // the reviewer starts lazily, when its column becomes visible (the Node
  // tab); its status events are consumed by the ReviewerTab itself
  useEffect(() => {
    if (active && tab === 'node') {
      void bridge.ensureReviewer(sessionId);
    }
  }, [active, tab, sessionId]);

  // expose this session's state for the global keydown handler + app mirrors
  const registerRef = useRef(registerState);
  registerRef.current = registerState;
  useEffect(() => {
    return registerRef.current(sessionId, ws);
  }, [sessionId, ws]);

  useEffect(() => {
    if (!active) return;
    onActiveInfo({
      tileCount: ws.tiles.size,
      focusedCwd: ws.reviewerFocused ? null : (ws.focusedId ? (ws.tiles.get(ws.focusedId)?.cwd ?? null) : null),
      sessionName: ws.session?.name ?? null,
      state: ws.state,
      projectPath: ws.session?.projectPath ?? null,
    });
  }, [active, ws.tiles, ws.focusedId, ws.reviewerFocused, ws.session, ws.state, onActiveInfo]);

  // tiles close when their PTY exits (per-session, tagged channel)
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    for (const [id] of ws.tiles) {
      unsubs.push(
        bridge.onTileExit(sessionId, id, () => {
          ws.closeTile(id, true);
        }),
      );
    }
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [sessionId, ws.tiles, ws.closeTile]);

  const nodeContent = (
    <>
      <section className="pane pane-workspace">
        <Workspace
          sessionId={sessionId}
          tree={ws.tree}
          zoomedId={ws.zoomedId}
          focusedId={ws.focusedId}
          tiles={ws.tiles}
          onFocus={(id) => {
            ws.setFocusedId(id);
            ws.setReviewerFocused(false);
          }}
          onClose={ws.closeTile}
          onZoom={ws.toggleZoom}
          onSwap={ws.onSwap}
          onSpawned={ws.registerAgent}
        />
      </section>
      <Divider onDrag={onDragRight} />
      <section
        className={`pane pane-side pane-side-right pane-reviewer-column${ws.reviewerFocused ? ' reviewer-column-focused' : ''}`}
        style={{ width: `${sideRightPct}%` }}
        onMouseDown={() => ws.setReviewerFocused(true)}
      >
        <ReviewerTab sessionId={sessionId} />
      </section>
    </>
  );

  // the top-bar Reviewer tab: an empty placeholder reserved for the next
  // feature — the live reviewer lives in the Node tab's right column
  const reviewerContent = (
    <section className="pane pane-workspace pane-reviewer">
      <div className="reviewer-placeholder">
        <div className="reviewer-placeholder-mark">reviewer</div>
        <div className="reviewer-placeholder-hint">the reviewer lives in the Node tab's right column</div>
      </div>
    </section>
  );

  const showNode = tab === 'node';
  const showReviewer = tab === 'reviewer';
  // the outer view must be fully hidden on the editor tab too: it stays
  // mounted (keep-alive), but must not occupy flex space next to the editor
  const viewVisible = active && tab !== 'editor';
  return (
    <div className={`session-view${viewVisible ? '' : ' session-view-hidden'}`}>
      <div className={`session-view-tab${showNode ? '' : ' session-view-hidden'}`}>{nodeContent}</div>
      <div className={`session-view-tab${showReviewer ? '' : ' session-view-hidden'}`}>{reviewerContent}</div>
    </div>
  );
}
