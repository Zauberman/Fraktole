import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewerEntry, ReviewerGoal, ReviewerQuestion, ReviewerStatus, ReviewerToolCallEvent, SettingsSection, SubGoal } from '../ipc.js';
import { bridge } from '../ipc.js';
import { AUTONOMY_NAMES, AUTONOMY_VARIANTS, type AutonomyVariant } from '../shared/autonomy.js';
import { sanitizeChatText } from '../shared/sanitize.js';
import { Dialog } from './Dialog.js';
import { ReviewerToolCard } from './ReviewerToolCard.js';

/** One row of the unified transcript timeline: a message or a tool call.
 *  Events arrive over IPC in order, so the renderer's monotonic `seq` is
 *  the chronological order; tool cards merge in by callId. */
interface TranscriptItem {
  seq: number;
  at: number;
  kind: 'message' | 'tool';
  role?: ReviewerEntry['role'];
  content?: string;
  /** streaming: the last assistant message is finalized by its message event */
  finalized?: boolean;
  /** the model's reasoning output (hidden behind a chip by default) */
  thinking?: string;
  /** streaming: thinking deltas still arriving */
  thinkingLive?: boolean;
  callId?: string;
  name?: string;
  args?: string;
  state?: 'start' | 'done' | 'error';
  detail?: string;
  durationMs?: number;
}

function timeOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Compact token formatting: 12500 → '12.5k'. */
function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function roleLabel(role?: string): string {
  if (role === 'user') return 'you';
  if (role === 'assistant') return 'reviewer';
  return role ?? 'system';
}

interface ReviewerTabProps {
  sessionId: string;
  /** Opens the app Settings Center at a section (replaces the old inline config modal). */
  onOpenSettings(section: SettingsSection): void;
}

/**
 * The Reviewer tab: the harness's full space — one unified transcript
 * timeline (model text, tool calls, agent-result notes), the status, the
 * /compact command, and the prompt box.
 */
export function ReviewerTab(props: ReviewerTabProps): React.JSX.Element {
  const { sessionId, onOpenSettings } = props;
  const [status, setStatus] = useState<ReviewerStatus>('offline');
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const [runningModel, setRunningModel] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [thinkingOpen, setThinkingOpen] = useState<Record<number, boolean>>({});
  const [thinkingGlobal, setThinkingGlobal] = useState(false);
  const [goal, setGoal] = useState<ReviewerGoal | null>(null);
  const [subGoals, setSubGoals] = useState<SubGoal[]>([]);
  /** Active autonomous-mode variant (null = normal mode). */
  const [variant, setVariant] = useState<string | null>(null);
  const [autonomyOpen, setAutonomyOpen] = useState(false);
  /** Fork/planning phase of an auto-compose start (cleared on first reply). */
  const [starting, setStarting] = useState<'forking' | 'planning' | null>(null);
  const startingRef = useRef<'forking' | 'planning' | null>(null);
  /** A prior run exists (active goal + non-empty fork): offer resume/fresh. */
  const [resumeOffer, setResumeOffer] = useState<{ variant: AutonomyVariant; goalText: string } | null>(null);
  /** The last manual summarize-session recap (persisted server-side). */
  const [recap, setRecap] = useState<{ text: string; at: number } | null>(null);
  const [recapOpen, setRecapOpen] = useState(false);
  /** The resolved context budget (server-probed ≤ knob ≤ guess) — shown next
   *  to the status so a mismatch with the launch flags is at least visible. */
  const [budgetInfo, setBudgetInfo] = useState<{ contextTokens: number; probed?: number } | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [question, setQuestion] = useState<ReviewerQuestion | null>(null);
  const [input, setInput] = useState('');
  /** Transient inline note when a prompt could not be accepted — the text
   *  stays in the box, never silently dropped. */
  const [composeError, setComposeError] = useState<string | null>(null);
  /** Cumulative model token usage (input / cache-hit / output). */
  const [usage, setUsage] = useState({ inputTokens: 0, cachedTokens: 0, outputTokens: 0 });
  /** Streamed output chars since the last usage event — a live output-token
   *  estimate while a turn is still streaming. */
  const [streamChars, setStreamChars] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!composeError) return;
    const t = window.setTimeout(() => setComposeError(null), 5000);
    return () => window.clearTimeout(t);
  }, [composeError]);

  // the autonomy popover closes on Escape like every other transient menu
  useEffect(() => {
    if (!autonomyOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAutonomyOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [autonomyOpen]);

  const nextSeq = (): number => {
    seqRef.current += 1;
    return seqRef.current;
  };

  // reload the persisted transcript (mount and after a restart, which
  // clears the live items)
  const loadTranscript = useCallback((): void => {
    void bridge.reviewerTranscript(sessionId).then((rows) => {
      if (rows.length > 0) {
        setItems(rows.map((entry) => ({ seq: nextSeq(), at: entry.at, kind: 'message', role: entry.role, content: entry.content, thinking: entry.thinking, finalized: true })));
      }
    });
  }, [sessionId]);

  // mount: load the persisted transcript
  useEffect(() => {
    loadTranscript();
  }, [sessionId, loadTranscript]);

  useEffect(() => {
    const unsubs = [
      bridge.onReviewerStatus(sessionId, (s) => {
        setStatus(s.status as ReviewerStatus);
        setStatusError(s.error);
        setRunningModel(s.model);
        setVariant(s.variant ?? null);
      }),
      bridge.onReviewerStream(sessionId, (ev) => {
        const { delta, thinking } = ev;
        if (delta) {
          setStreamChars((n) => n + delta.length);
          // the first model output marks the start phase over
          if (startingRef.current) {
            startingRef.current = null;
            setStarting(null);
          }
        }
        // seq is allocated here, outside the updater: an updater may be
        // re-invoked by React, and an impure increment inside it would mint
        // duplicate keys
        const seq = nextSeq();
        setItems((its) => {
          const last = its[its.length - 1];
          const live =
            last && last.kind === 'message' && last.role === 'assistant' && !last.finalized ? last : null;
          if (live) {
            const next = [...its];
            next[next.length - 1] = {
              ...live,
              content: delta ? `${live.content ?? ''}${delta}` : live.content,
              thinking: thinking ? `${live.thinking ?? ''}${thinking}` : live.thinking,
              thinkingLive: thinking ? true : live.thinkingLive,
            };
            return next;
          }
          if (delta || thinking) {
            return [
              ...its,
              {
                seq,
                at: Date.now(),
                kind: 'message',
                role: 'assistant',
                content: delta ?? '',
                thinking,
                thinkingLive: thinking ? true : undefined,
                finalized: false,
              },
            ];
          }
          return its;
        });
      }),
      bridge.onReviewerToolCall(sessionId, (ev: ReviewerToolCallEvent) => {
        if (ev.state === 'start') {
          const seq = nextSeq();
          setItems((its) => [
            ...its,
            { seq, at: ev.at, kind: 'tool', callId: ev.callId, name: ev.name, args: JSON.stringify(ev.args), state: 'start' },
          ]);
        } else {
          setItems((its) =>
            its.map((it) =>
              it.kind === 'tool' && it.callId === ev.callId
                ? { ...it, state: ev.state, detail: ev.error ?? ev.result, durationMs: ev.durationMs }
                : it,
            ),
          );
          if (ev.state === 'error' && ev.callId) {
            setExpanded((e) => ({ ...e, [ev.callId]: true }));
          }
        }
      }),
      bridge.onReviewerMessage(sessionId, (entry) => {
        const seq = nextSeq();
        setItems((its) => {
          if (entry.role === 'assistant') {
            const last = its[its.length - 1];
            if (last && last.kind === 'message' && last.role === 'assistant' && !last.finalized) {
              const next = [...its];
              next[next.length - 1] = {
                ...last,
                content: entry.content,
                thinking: entry.thinking ?? last.thinking,
                thinkingLive: false,
                finalized: true,
              };
              return next;
            }
          }
          return [...its, { seq, at: entry.at, kind: 'message', role: entry.role, content: entry.content, thinking: entry.thinking, finalized: true }];
        });
      }),
      bridge.onReviewerGoal(sessionId, (ev) => {
        setGoal(ev.goal);
        setSubGoals(ev.subGoals ?? []);
      }),
      bridge.onReviewerQuestion(sessionId, (ev) => setQuestion(ev)),
      bridge.onReviewerUsage(sessionId, (ev) => {
        setUsage({ inputTokens: ev.inputTokens, cachedTokens: ev.cachedTokens, outputTokens: ev.outputTokens });
        setStreamChars(0);
      }),
      bridge.onReviewerRecap(sessionId, (r) => {
        setRecap(r);
        setRecapOpen(true);
      }),
      bridge.onReviewerBudget(sessionId, (info) => setBudgetInfo(info)),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [sessionId]);

  // keep the transcript pinned to the newest content — but never yank a
  // reader who scrolled up; pinning resumes once they return to the bottom.
  // Programmatic pin-scrolls must not un-pin via their own scroll event.
  const pinnedRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el || programmaticScrollRef.current) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const pinToBottom = (): void => {
    const el = scrollRef.current;
    if (!el || !pinnedRef.current) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  };
  useEffect(() => {
    // let the new content lay out first (a single frame can still race a
    // second layout — tool cards growing when their results land), then pin
    requestAnimationFrame(() => requestAnimationFrame(pinToBottom));
  }, [items]);
  // re-pin on container size changes while the user is still at the bottom
  // (scrollbar appearance, column resize)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => pinToBottom());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const submit = (): void => {
    const text = input.trim();
    if (text.length === 0) return;
    if (text === '/compact') {
      setInput('');
      void bridge.compactReviewer(sessionId);
      return;
    }
    if (text === '/summarize') {
      setInput('');
      summarize();
      return;
    }
    if (text.startsWith('/goal')) {
      const rest = text.slice(5).trim();
      setInput('');
      void bridge.setReviewerGoal(sessionId, rest.length > 0 ? rest : null);
      return;
    }
    if (text.startsWith('/kill')) {
      const rest = text.slice(5).trim();
      setInput('');
      if (rest.length > 0) void bridge.killReviewerAgent(sessionId, rest);
      return;
    }
    // a prompt is only consumed when the harness accepted it — otherwise
    // the text stays in the box and the user sees why
    void bridge.promptReviewer(sessionId, text).then((accepted) => {
      if (accepted) setInput('');
      else setComposeError('reviewer is stopped or unconfigured — open the settings');
    });
  };

  const revive = (): void => {
    void bridge.ensureReviewer(sessionId);
  };

  const stop = (): void => {
    void bridge.stopReviewer(sessionId);
  };

  /** Ask the model for a session recap and compact the context around it.
   *  Busy-guarded so a double-click can't queue two passes. */
  const summarize = (): void => {
    if (summarizing) return;
    setSummarizing(true);
    void bridge.summarizeReviewer(sessionId).then((res) => {
      setSummarizing(false);
      if (!res.ok) setComposeError(res.error ?? 'could not summarize the session');
    });
  };

  /** Pick an auto-compose variant. When a prior run exists (active goal +
   *  non-empty fork) offer a resume dialog instead of silently wiping it. */
  const pickVariant = async (id: AutonomyVariant): Promise<void> => {
    setAutonomyOpen(false);
    setStarting('forking');
    startingRef.current = 'forking';
    try {
      const r = await bridge.resumableRun(sessionId, id);
      if (r.resumable) {
        startingRef.current = null;
        setStarting(null);
        setResumeOffer({ variant: id, goalText: r.goalText ?? '' });
        return;
      }
      startingRef.current = 'planning';
      setStarting('planning');
      const res = await bridge.setReviewerAutonomy(sessionId, id, 'auto');
      if (!res.ok) {
        startingRef.current = null;
        setStarting(null);
        setComposeError(res.error ?? 'autonomous mode failed to start');
      }
    } catch {
      startingRef.current = null;
      setStarting(null);
    }
  };

  const answerQuestion = (answer: string): void => {
    if (!question) return;
    void bridge.answerReviewerQuestion(sessionId, question.askId, answer);
    setQuestion(null);
  };

  return (
    <div className="reviewer">
      <header className="reviewer-header">
        <div className="reviewer-title">
          <span className="pane-title">Reviewer</span>
          <span className={`orch-judge-status orch-judge-${status}`}>
            <span className="reviewer-status-dot" aria-hidden="true" />
            {status}
          </span>
          {runningModel && <span className="reviewer-model-label">{runningModel}</span>}
          {budgetInfo && (
            <span
              className="reviewer-model-label"
              title={
                budgetInfo.probed
                  ? `server context ${budgetInfo.probed.toLocaleString()} tokens · budget ${budgetInfo.contextTokens.toLocaleString()}`
                  : `context budget ${budgetInfo.contextTokens.toLocaleString()} tokens (server does not report its window)`
              }
            >
              ctx {budgetInfo.contextTokens.toLocaleString()}
            </span>
          )}
        </div>
        <div className="reviewer-actions">
          <div className="autonomy-wrap">
            <button
              type="button"
              className={`btn btn-sm${variant ? ' btn-active' : ''}`}
              title="autonomous mode — plugin system for the reviewer"
              onClick={() => setAutonomyOpen((o) => !o)}
            >
              auto compose{variant ? ` · ${variant === 'custom' ? AUTONOMY_NAMES.custom : variant}` : ''}
            </button>
            {autonomyOpen && (
              <>
                <div className="autonomy-menu-backdrop" onMouseDown={() => setAutonomyOpen(false)} />
                <div className="autonomy-menu" onMouseDown={(e) => e.stopPropagation()}>
                  <div className="autonomy-menu-label">Autonomous mode</div>
                  <button
                    type="button"
                    className={`autonomy-item${variant === null ? ' autonomy-item-current' : ''}`}
                    onClick={() => {
                      setAutonomyOpen(false);
                      void bridge.setReviewerAutonomy(sessionId, null).then((res) => {
                        if (!res.ok) setComposeError(res.error ?? 'could not clear autonomous mode');
                      });
                    }}
                  >
                    off
                  </button>
                  {AUTONOMY_VARIANTS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={`autonomy-item${variant === id ? ' autonomy-item-current' : ''}`}
                      onClick={() => void pickVariant(id)}
                    >
                      {AUTONOMY_NAMES[id]}
                    </button>
                  ))}
                  <div className="autonomy-menu-sep" />
                  <button
                    type="button"
                    className="autonomy-item"
                    onClick={() => {
                      setAutonomyOpen(false);
                      onOpenSettings('compose');
                    }}
                  >
                    edit custom…
                  </button>
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            className={`btn btn-sm${thinkingGlobal ? ' btn-active' : ''}`}
            title="show or hide the model's thinking output"
            onClick={() => setThinkingGlobal((v) => !v)}
          >
            think
          </button>
          {status === 'running' ? (
            <button type="button" className="btn btn-sm" onClick={stop}>
              stop
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" onClick={revive}>
              start
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            title="provider, model and sampling — opens the Settings Center"
            onClick={() => onOpenSettings('model')}
          >
            model
          </button>
        </div>
      </header>

      <div className="reviewer-transcript" ref={scrollRef} onScroll={onScroll}>
        {status === 'unconfigured' && (
          <div className="reviewer-note reviewer-note-error">{statusError ?? 'reviewer not configured — open config'}</div>
        )}
        {status === 'error' && statusError && <div className="reviewer-note reviewer-note-error">{statusError}</div>}
        {items.length === 0 && status !== 'unconfigured' && status !== 'error' && (
          <div className="reviewer-empty">
            <div className="reviewer-empty-mark">reviewer</div>
            <div className="reviewer-empty-hint">prompt the reviewer — it observes every agent tile</div>
            <div className="reviewer-empty-sub">/goal &lt;text&gt; arms the loop carrier · config sets the model key</div>
          </div>
        )}
        {items.map((it) =>
          it.kind === 'message' ? (
            <div
              key={it.seq}
              className={`reviewer-item reviewer-item-${it.role ?? 'system'}${it.finalized ? '' : ' reviewer-live'}`}
            >
              <span className="reviewer-rail" aria-hidden="true" />
              <div className="reviewer-item-main">
                <div className="reviewer-item-meta">
                  <span className="reviewer-item-role">{roleLabel(it.role)}</span>
                  {it.thinking !== undefined && (
                    <button
                      type="button"
                      className={`reviewer-thinking-chip${thinkingGlobal || thinkingOpen[it.seq] ? ' reviewer-thinking-chip-on' : ''}${it.thinkingLive ? ' reviewer-thinking-live' : ''}`}
                      title={it.thinkingLive ? 'thinking…' : 'toggle thinking output'}
                      onClick={() => setThinkingOpen((o) => ({ ...o, [it.seq]: !o[it.seq] }))}
                    >
                      thinking{it.thinkingLive ? '…' : ''}
                    </button>
                  )}
                  <span className="reviewer-item-time">{timeOf(it.at)}</span>
                </div>
                {(thinkingGlobal || thinkingOpen[it.seq]) && it.thinking !== undefined && (
                  <div className="reviewer-thinking">
                    <span className="reviewer-thinking-caption">thinking</span>
                    {sanitizeChatText(it.thinking)}
                  </div>
                )}
                <div className="reviewer-item-body">
                  {sanitizeChatText(it.content ?? '')}
                  {!it.finalized && <span className="reviewer-caret" aria-hidden="true" />}
                </div>
              </div>
            </div>
          ) : (
            <ReviewerToolCard
              it={it}
              expanded={expanded[it.callId ?? String(it.seq)] || it.state === 'error'}
              onToggle={() => setExpanded((e) => ({ ...e, [it.callId ?? String(it.seq)]: !e[it.callId ?? String(it.seq)] }))}
            />          ),
        )}
        {question && (
          <div className="reviewer-question-card">
            <div className="reviewer-question-meta">
              <span className="reviewer-question-mark" aria-hidden="true">
                ?
              </span>
              <span className="reviewer-item-role">question</span>
              <span className="reviewer-item-time">{timeOf(question.at ?? Date.now())}</span>
            </div>
            <div className="reviewer-question-text">{sanitizeChatText(question.question)}</div>
            <div className="reviewer-question-actions">
              {question.kind === 'confirm-kill' && (
                <>
                  <button type="button" className="btn btn-sm btn-primary" onClick={() => answerQuestion('yes')}>
                    yes, kill
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => answerQuestion('no')}>
                    no
                  </button>
                </>
              )}
              {question.kind === 'agent-kind' && (
                <>
                  <button type="button" className="btn btn-sm" onClick={() => answerQuestion('opencode')}>
                    opencode
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => answerQuestion('shell')}>
                    shell
                  </button>
                </>
              )}
              <button type="button" className="btn btn-sm" onClick={() => answerQuestion('skipped')}>
                skip
              </button>
            </div>
            <div className="reviewer-question-row">
              <input
                className="reviewer-question-input"
                placeholder="type your answer…"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.currentTarget.value.trim().length > 0) {
                    answerQuestion(e.currentTarget.value.trim());
                  }
                }}
              />
            </div>
          </div>
        )}
      </div>

      {goal && (
        <div className="reviewer-goal-banner">
          <span className={`reviewer-goal-state reviewer-goal-state-${goal.state}`}>{goal.state}</span>
          <span className="reviewer-goal-text">{sanitizeChatText(goal.text)}</span>
          <button type="button" className="btn btn-sm" title="clear the goal" onClick={() => void bridge.setReviewerGoal(sessionId, null)}>
            clear
          </button>
          {subGoals.length > 0 && (
            <ul className="reviewer-subgoals">
              {subGoals.map((s) => (
                <li key={s.id} className={`reviewer-subgoal${s.state === 'done' ? ' reviewer-subgoal-done' : ''}`}>
                  <span className="reviewer-subgoal-mark" aria-hidden="true">
                    {s.state === 'done' ? '✓' : '·'}
                  </span>
                  {sanitizeChatText(s.text)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {starting && <div className="reviewer-activity">{starting === 'forking' ? 'forking…' : 'planning…'}</div>}

      {recap && recapOpen && (
        <div className="reviewer-recap">
          <div className="reviewer-recap-head">
            <span className="reviewer-recap-title">session recap</span>
            <span className="reviewer-recap-time">{timeOf(recap.at)}</span>
            <span className="reviewer-recap-actions">
              <button type="button" className="btn btn-sm" onClick={() => setRecapOpen(false)}>
                hide
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setRecap(null)}>
                dismiss
              </button>
            </span>
          </div>
          <div className="reviewer-recap-body">{sanitizeChatText(recap.text)}</div>
        </div>
      )}

      {resumeOffer && (
        <Dialog title="resume previous run?" onClose={() => setResumeOffer(null)} accent="reviewer" size="md" footer={
          <button type="button" className="btn btn-sm" onClick={() => setResumeOffer(null)}>
            cancel
          </button>
        }>
          <div className="reviewer-resume-text">
            A previous autonomous run for this variant has an active goal and an existing fork.
          </div>
          <div className="reviewer-resume-goal">{sanitizeChatText(resumeOffer.goalText)}</div>
          <div className="fork-cards">
            <button
              type="button"
              className="fork-card fork-card-resume"
              onClick={() => {
                const v = resumeOffer.variant;
                setResumeOffer(null);
                startingRef.current = 'planning';
                setStarting('planning');
                void bridge.setReviewerAutonomy(sessionId, v, 'auto').then((res) => {
                  if (!res.ok) {
                    startingRef.current = null;
                    setStarting(null);
                    setComposeError(res.error ?? 'could not resume the run');
                  }
                });
              }}
            >
              <span className="fork-card-title">resume in place</span>
              <span className="fork-card-desc">continue the existing fork from its last state</span>
            </button>
            <button
              type="button"
              className="fork-card fork-card-fresh"
              onClick={() => {
                const v = resumeOffer.variant;
                setResumeOffer(null);
                startingRef.current = 'planning';
                setStarting('planning');
                void bridge.setReviewerAutonomy(sessionId, v, 'fresh').then((res) => {
                  if (!res.ok) {
                    startingRef.current = null;
                    setStarting(null);
                    setComposeError(res.error ?? 'could not start fresh');
                  }
                });
              }}
            >
              <span className="fork-card-title">start fresh</span>
              <span className="fork-card-desc">discard the fork and begin a new run</span>
            </button>
          </div>
        </Dialog>
      )}

      <footer className="reviewer-input">
        <div className="reviewer-composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder={
              status === 'running'
                ? 'prompt the reviewer…  (/goal <text> · /compact · /summarize · /kill <id>)'
                : status === 'unconfigured'
                  ? 'paste an api key in config — save & restart'
                  : status === 'stopped'
                    ? 'reviewer stopped — start revives it'
                    : 'reviewer reconnecting — send to revive it'
            }
            disabled={status === 'stopped'}
          />
          <button type="button" className="btn btn-sm btn-primary" onClick={submit} disabled={status === 'stopped'}>
            send
          </button>
        </div>
        <div className={`reviewer-hint-line${composeError ? ' reviewer-hint-error' : ''}`}>
          {composeError ?? (
            <span className="reviewer-usage-line">
              in {fmtTokens(usage.inputTokens)} · cache {fmtTokens(usage.cachedTokens)} · out{' '}
              {fmtTokens(usage.outputTokens + Math.round(streamChars / 4))}
            </span>
          )}
        </div>
      </footer>
    </div>
  );
}
