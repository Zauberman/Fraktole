import React from 'react';
import type { FraktoleMessage } from '../ipc.js';
import { JudgeTerminal } from './JudgeTerminal.js';
import type { JudgeStatus } from './OrchestratorPanel.js';

interface ReviewerTabProps {
  sessionId: string;
  messages: FraktoleMessage[];
  judgeStatus: JudgeStatus;
  /** Bumped whenever the judge (re)spawns; refits the terminal so the PTY
   *  matches the tab while the fresh CLI still tolerates resizes. */
  spawnTick: number;
  onRetryJudge(): void;
}

function timeOf(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * The Reviewer tab: the judge's full space — its terminal, its status, and
 * the messages exchanged with the agents (its side of the conversation).
 */
export function ReviewerTab(props: ReviewerTabProps): React.JSX.Element {
  const { sessionId, messages, judgeStatus, spawnTick, onRetryJudge } = props;
  const judgeThread = messages.filter((m) => m.from === 'orchestrator' || m.to === 'orchestrator');

  return (
    <div className="reviewer">
      <header className="reviewer-header">
        <div className="pane-title">Reviewer — judge</div>
        <div className="reviewer-actions">
          <span className={`orch-judge-status orch-judge-${judgeStatus}`}>{judgeStatus}</span>
          {judgeStatus !== 'running' && (
            <button type="button" className="orch-btn" onClick={onRetryJudge}>
              retry
            </button>
          )}
        </div>
      </header>
      <div className="reviewer-term">
        <JudgeTerminal sessionId={sessionId} spawnTick={spawnTick} />
      </div>
      <section className="reviewer-log">
        <div className="orch-section-title">judge messages</div>
        {judgeThread.length === 0 ? (
          <div className="orch-hint">no messages yet — results from agents land here</div>
        ) : (
          <ul className="orch-log">
            {judgeThread.map((m) => (
              <li key={m.id} className="orch-msg">
                <div className="orch-msg-meta">
                  <span className={`orch-badge orch-badge-${m.kind}`}>{m.kind}</span>
                  <span className="orch-msg-from">
                    {m.from} → {m.to}
                  </span>
                  <span className="orch-msg-time">{timeOf(m.at)}</span>
                </div>
                <div className="orch-msg-body">{m.body}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
