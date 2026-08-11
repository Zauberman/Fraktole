import React, { useEffect, useRef, useState } from 'react';
import { Workspace } from './Workspace.js';
import { Divider } from './Divider.js';
import { OrchestratorPanel } from './OrchestratorPanel.js';
import { ReviewerTab } from './ReviewerTab.js';
import type { JudgeStatus } from './OrchestratorPanel.js';
import { useSessionState, type SessionState } from '../session-state.js';
import { useMessages } from '../messages.js';
import { useSnapshots } from '../snapshots.js';
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
 * streaming — the keep-alive core. Shows the Node layout (workspace + right
 * panel) or the Reviewer layout depending on the active tab.
 */
export function SessionView(props: SessionViewProps): React.JSX.Element {
  const {
    sessionId,
    active,
    tab,
    sessions,
    sideRightPct,
    onDragRight,
    onActivate,
    onNewSession,
    onDeleteSession,
    onStopSession,
    onStartSession,
    registerState,
    onActiveInfo,
  } = props;
  const ws = useSessionState(sessionId);
  const { messages, send } = useMessages(sessionId);
  const snapshots = useSnapshots();
  const [judgeStatus, setJudgeStatus] = useState<JudgeStatus>('offline');

  // (re)activate when this view becomes the active session
  useEffect(() => {
    if (active) {
      void ws.reactivate();
      // main spawns the judge on activation
      setJudgeStatus('running');
    }
  }, [active, ws.reactivate]);

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
      focusedCwd: ws.focusedId ? (ws.tiles.get(ws.focusedId)?.cwd ?? null) : null,
      sessionName: ws.session?.name ?? null,
      state: ws.state,
      projectPath: ws.session?.projectPath ?? null,
    });
  }, [active, ws.tiles, ws.focusedId, ws.session, ws.state, onActiveInfo]);

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

  useEffect(() => {
    const unsubJudge = bridge.onJudgeExit(sessionId, () => setJudgeStatus('exited'));
    return () => unsubJudge();
  }, [sessionId]);

  const nodeContent = (
    <>
      <section className="pane pane-workspace">
        <Workspace
          sessionId={sessionId}
          tree={ws.tree}
          zoomedId={ws.zoomedId}
          focusedId={ws.focusedId}
          tiles={ws.tiles}
          onFocus={ws.setFocusedId}
          onClose={ws.closeTile}
          onZoom={ws.toggleZoom}
          onSwap={ws.onSwap}
          onSpawned={ws.registerAgent}
        />
      </section>
      <Divider onDrag={onDragRight} />
      <section className="pane pane-side pane-side-right pane-orch" style={{ width: `${sideRightPct}%` }}>
        <OrchestratorPanel
          session={ws.session}
          sessions={sessions}
          agents={[...ws.tiles.values()].map((m) => ({ tileId: m.id, agentId: m.agentId, cwd: m.cwd }))}
          messages={messages}
          onSend={send}
          onSnapshot={(agentId, text) => snapshots.create(sessionId, agentId, text)}
          onGetSnapshot={(id) => snapshots.get(sessionId, id)}
          onFocusAgent={(agentId) => {
            const tileId = ws.tileOf(agentId);
            if (tileId) ws.setFocusedId(tileId);
          }}
          onCloseAgent={(agentId) => {
            const tileId = ws.tileOf(agentId);
            if (tileId) ws.closeTile(tileId);
          }}
          onNewSession={onNewSession}
          onOpenSession={onActivate}
          onRenameSession={(name) => void ws.renameSession(name)}
          onDeleteSession={onDeleteSession}
          onStopSession={onStopSession}
          onStartSession={onStartSession}
        />
      </section>
    </>
  );

  const reviewerContent = (
    <section className="pane pane-workspace pane-reviewer">
      <ReviewerTab
        sessionId={sessionId}
        messages={messages}
        judgeStatus={judgeStatus}
        onRetryJudge={() => {
          void bridge.judgeRestart(sessionId).then((ok) => setJudgeStatus(ok ? 'running' : 'exited'));
        }}
      />
    </section>
  );

  const showNode = tab === 'node';
  const showReviewer = tab === 'reviewer';
  return (
    <div className={`session-view${active ? '' : ' session-view-hidden'}`}>
      <div className={`session-view-tab${showNode ? '' : ' session-view-hidden'}`}>{nodeContent}</div>
      <div className={`session-view-tab${showReviewer ? '' : ' session-view-hidden'}`}>{reviewerContent}</div>
    </div>
  );
}
