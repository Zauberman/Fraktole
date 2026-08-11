import React, { useEffect, useMemo, useState } from 'react';
import { bridge, type SessionSummary } from '../ipc.js';
import type { FraktoleMessage, SendMessageArgs, SessionSnapshot } from '../ipc.js';
import type { TileId } from '../window-tree.js';

export type JudgeStatus = 'offline' | 'running' | 'exited';

export interface FleetAgent {
  tileId: TileId;
  agentId: string | null;
  cwd: string;
}

interface OrchestratorPanelProps {
  session: SessionSummary | null;
  sessions: SessionSummary[];
  agents: FleetAgent[];
  messages: FraktoleMessage[];
  onSend(args: SendMessageArgs): Promise<boolean>;
  onSnapshot(agentId: string, text: string): Promise<SessionSnapshot>;
  onGetSnapshot(id: string): Promise<SessionSnapshot | null>;
  onFocusAgent(agentId: string): void;
  onCloseAgent(agentId: string): void;
  onNewSession(name: string): void;
  onOpenSession(id: string): void;
  onRenameSession(name: string): void;
  onDeleteSession(id: string): void;
  onStopSession(id: string): void;
  onStartSession(id: string): void;
}

type KindFilter = 'all' | FraktoleMessage['kind'];

function timeOf(at: number): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * The orchestrator panel: the judge's cockpit. Fleet of agent tiles, the
 * message log, the composer (tasks in, results out) and the judge CLI's own
 * terminal below.
 */
export function OrchestratorPanel(props: OrchestratorPanelProps): React.JSX.Element {
  const {
    session,
    sessions,
    agents,
    messages,
    onSend,
    onSnapshot,
    onGetSnapshot,
    onFocusAgent,
    onCloseAgent,
    onNewSession,
    onOpenSession,
    onRenameSession,
    onDeleteSession,
    onStopSession,
    onStartSession,
  } = props;

  const [to, setTo] = useState('');
  const [kind, setKind] = useState<FraktoleMessage['kind']>('task');
  const [body, setBody] = useState('');
  const [filter, setFilter] = useState<KindFilter>('all');
  const [attached, setAttached] = useState<SessionSnapshot | null>(null);
  const [review, setReview] = useState<SessionSnapshot | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [nameForm, setNameForm] = useState<{ mode: 'new' | 'rename'; value: string } | null>(null);

  // the File → Sessions menu forwards its actions here; they drive the same
  // flows as the panel controls
  useEffect(() => {
    return bridge.onMenuSession((action) => {
      if (action.action === 'new') {
        setSwitcherOpen(false);
        setNameForm({ mode: 'new', value: '' });
      } else if (action.action === 'save-as') {
        setSwitcherOpen(false);
        setNameForm({ mode: 'rename', value: session?.name ?? '' });
      } else if (action.action === 'open' && action.id && action.id !== session?.id) {
        setSwitcherOpen(false);
        onOpenSession(action.id);
      } else if (action.action === 'delete' && action.id) {
        const target = sessions.find((s) => s.id === action.id);
        if (target && window.confirm(`Delete session "${target.name}"?`)) {
          setSwitcherOpen(false);
          onDeleteSession(action.id);
        }
      } else if (action.action === 'stop' && action.id) {
        onStopSession(action.id);
      } else if (action.action === 'start' && action.id) {
        onStartSession(action.id);
      }
    });
  }, [session, sessions, onOpenSession, onDeleteSession, onStopSession, onStartSession]);

  const agentOptions = useMemo(
    () => agents.filter((a) => a.agentId !== null) as Array<FleetAgent & { agentId: string }>,
    [agents],
  );

  const visibleMessages = useMemo(
    () => (filter === 'all' ? messages : messages.filter((m) => m.kind === filter)),
    [messages, filter],
  );

  const captureTile = async (tileId: TileId, agentId: string): Promise<void> => {
    const terms = (window as unknown as { __fraktTerms?: Map<TileId, { buffer: unknown }> }).__fraktTerms;
    const term = terms?.get(tileId);
    if (!term) return;
    const lines: string[] = [];
    const b = (term as unknown as { buffer: { active: { length: number; getLine(i: number): { translateToString(): string } | undefined } } }).buffer.active;
    for (let i = 0; i < b.length; i += 1) lines.push(b.getLine(i)?.translateToString() ?? '');
    if (lines.length === 0) return;
    const snap = await onSnapshot(agentId, lines.join('\n'));
    setAttached(snap);
    setReview(snap);
  };

  const submit = async (): Promise<void> => {
    if (!to || body.trim().length === 0) return;
    const ok = await onSend({ to, kind, body: body.trim(), ref: attached?.id });
    if (ok) {
      setBody('');
      setAttached(null);
    }
  };

  return (
    <div className="orchestrator">
      <header className="pane-header">
        <div className="pane-title">Orchestrator</div>
        {session !== null && (
          <div className="orch-session">
            <button
              type="button"
              className="orch-session-name"
              onClick={() => setSwitcherOpen((v) => !v)}
            >
              {session.name}
            </button>
            {switcherOpen && (
              <div className="orch-switcher">
                <div className="orch-switcher-label">sessions</div>
                {sessions.map((s) => (
                  <div
                    key={s.id}
                    className={`orch-switcher-item${s.id === session.id ? ' orch-switcher-current' : ''}`}
                  >
                    <button
                      type="button"
                      className="orch-switcher-open"
                      onClick={() => {
                        setSwitcherOpen(false);
                        if (s.id !== session.id) onOpenSession(s.id);
                      }}
                    >
                      {s.name}
                      <span className="orch-switcher-meta">
                        {s.state ?? ''} · {s.agentCount} agents · {timeOf(s.updatedAt)}
                      </span>
                    </button>
                    {s.id !== session.id && (
                      <button
                        type="button"
                        className="orch-btn orch-btn-danger"
                        title={s.state === 'stopped' ? 'start session' : 'stop session'}
                        onClick={() => {
                          if (s.state === 'stopped') onStartSession(s.id);
                          else onStopSession(s.id);
                        }}
                      >
                        {s.state === 'stopped' ? 'start' : 'stop'}
                      </button>
                    )}
                  </div>
                ))}
                <div className="orch-switcher-actions">
                  <button type="button" className="orch-btn" onClick={() => setNameForm({ mode: 'new', value: '' })}>
                    New…
                  </button>
                  <button
                    type="button"
                    className="orch-btn"
                    onClick={() => setNameForm({ mode: 'rename', value: session.name })}
                  >
                    Rename…
                  </button>
                  <button
                    type="button"
                    className="orch-btn orch-btn-danger"
                    onClick={() => {
                      setSwitcherOpen(false);
                      if (sessions.length > 1 && window.confirm(`Delete session "${session.name}"?`)) {
                        onDeleteSession(session.id);
                      }
                    }}
                  >
                    Delete…
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </header>

      {nameForm !== null && (
        <div className="orch-name-form">
          <input
            className="orch-input"
            autoFocus
            placeholder={nameForm.mode === 'new' ? 'session name' : 'new name'}
            value={nameForm.value}
            onChange={(e) => setNameForm({ ...nameForm, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && nameForm.value.trim()) {
                if (nameForm.mode === 'new') onNewSession(nameForm.value.trim());
                else onRenameSession(nameForm.value.trim());
                setNameForm(null);
              }
              if (e.key === 'Escape') setNameForm(null);
            }}
          />
          <div className="orch-name-actions">
            <button type="button" className="orch-btn" onClick={() => setNameForm(null)}>
              cancel
            </button>
            <button
              type="button"
              className="orch-btn orch-btn-primary"
              disabled={nameForm.value.trim().length === 0}
              onClick={() => {
                if (nameForm.mode === 'new') onNewSession(nameForm.value.trim());
                else onRenameSession(nameForm.value.trim());
                setNameForm(null);
              }}
            >
              {nameForm.mode === 'new' ? 'create' : 'rename'}
            </button>
          </div>
        </div>
      )}

      <section className="orch-section orch-fleet-section">
        <div className="orch-section-title">fleet</div>
        {agents.length === 0 ? (
          <div className="orch-hint">open tiles with ctrl+shift T — each tile is an agent</div>
        ) : (
          <ul className="orch-fleet">
            {agents.map((a) => (
              <li key={a.tileId} className="orch-agent">
                <div className="orch-agent-id">
                  {a.agentId ?? 'spawning…'}
                  <span className="orch-agent-cwd" title={a.cwd}>
                    {a.cwd}
                  </span>
                </div>
                <div className="orch-agent-actions">
                  <button
                    type="button"
                    className="orch-btn"
                    disabled={a.agentId === null}
                    onClick={() => {
                      setTo(a.agentId ?? '');
                      setKind('task');
                    }}
                  >
                    task
                  </button>
                  <button
                    type="button"
                    className="orch-btn"
                    disabled={a.agentId === null}
                    onClick={() => {
                      if (a.agentId !== null) void captureTile(a.tileId, a.agentId);
                    }}
                  >
                    snapshot
                  </button>
                  <button
                    type="button"
                    className="orch-btn"
                    disabled={a.agentId === null}
                    onClick={() => {
                      if (a.agentId !== null) onFocusAgent(a.agentId);
                    }}
                  >
                    focus
                  </button>
                  <button
                    type="button"
                    className="orch-btn orch-btn-danger"
                    disabled={a.agentId === null}
                    onClick={() => {
                      if (a.agentId !== null) onCloseAgent(a.agentId);
                    }}
                  >
                    close
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="orch-section orch-log-section">
        <div className="orch-section-title">
          messages
          <span className="orch-filter">
            {(['all', 'task', 'result', 'note'] as KindFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`orch-filter-chip${filter === f ? ' orch-filter-active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f}
              </button>
            ))}
          </span>
        </div>
        {visibleMessages.length === 0 ? (
          <div className="orch-hint">no messages yet — the judge and the agents talk through mailboxes</div>
        ) : (
          <ul className="orch-log">
            {visibleMessages.map((m) => (
              <li key={m.id} className="orch-msg">
                <div className="orch-msg-meta">
                  <span className={`orch-badge orch-badge-${m.kind}`}>{m.kind}</span>
                  <span className="orch-msg-from">
                    {m.from} → {m.to}
                  </span>
                  <span className="orch-msg-time">{timeOf(m.at)}</span>
                  {m.ref !== undefined && (
                    <button
                      type="button"
                      className="orch-btn"
                      onClick={() => {
                        void onGetSnapshot(m.ref ?? '').then((s) => {
                          if (s) setReview(s);
                        });
                      }}
                    >
                      view snapshot
                    </button>
                  )}
                </div>
                <div className="orch-msg-body">{m.body}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {review !== null && (
        <section className="orch-section">
          <div className="orch-section-title">
            snapshot — {review.agentId} · {timeOf(review.at)}
            <span className="orch-filter">
              <button type="button" className="orch-btn" onClick={() => setReview(null)}>
                close
              </button>
              <button
                type="button"
                className="orch-btn"
                onClick={() => {
                  void navigator.clipboard?.writeText(review.text).catch(() => undefined);
                }}
              >
                copy
              </button>
            </span>
          </div>
          <pre className="orch-review">{review.text}</pre>
        </section>
      )}

      <section className="orch-section orch-composer-section">
        <div className="orch-section-title">composer</div>
        <div className="orch-composer">
          <div className="orch-composer-row">
            <select className="orch-select" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">to…</option>
              {agentOptions.map((a) => (
                <option key={a.agentId} value={a.agentId}>
                  {a.agentId}
                </option>
              ))}
            </select>
            <select className="orch-select" value={kind} onChange={(e) => setKind(e.target.value as FraktoleMessage['kind'])}>
              <option value="task">task</option>
              <option value="result">result</option>
              <option value="note">note</option>
            </select>
          </div>
          <textarea
            className="orch-textarea"
            placeholder="message body — injected into the agent's terminal and mailbox"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {attached !== null && (
            <div className="orch-attach">
              attached snapshot {attached.id}
              <button type="button" className="orch-btn" onClick={() => setAttached(null)}>
                detach
              </button>
            </div>
          )}
          <button
            type="button"
            className="orch-btn orch-btn-primary"
            disabled={!to || body.trim().length === 0}
            onClick={() => void submit()}
          >
            send
          </button>
        </div>
      </section>
    </div>
  );
}
