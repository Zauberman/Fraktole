import React, { useEffect, useRef, useState } from 'react';
import type { ReviewerEntry, ReviewerStatus, ReviewerToolCallEvent } from '../ipc.js';
import { bridge, type Settings } from '../ipc.js';
import {
  DEFAULT_MODELS,
  REVIEWER_MODEL_SUGGESTIONS,
  resolveProvider,
  type DetectedProvider,
} from '../shared/reviewer-detect.js';
import { sanitizeChatText } from '../shared/sanitize.js';

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

function roleLabel(role?: string): string {
  if (role === 'user') return 'you';
  if (role === 'assistant') return 'reviewer';
  return role ?? 'system';
}

interface ReviewerTabProps {
  sessionId: string;
}

/**
 * The Reviewer tab: the harness's full space — one unified transcript
 * timeline (model text, tool calls, agent-result notes), the status, the
 * /compact command, and the prompt box.
 */
export function ReviewerTab(props: ReviewerTabProps): React.JSX.Element {
  const { sessionId } = props;
  const [status, setStatus] = useState<ReviewerStatus>('offline');
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState({ apiKey: '', provider: '', model: '', baseUrl: '' });
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);

  const nextSeq = (): number => {
    seqRef.current += 1;
    return seqRef.current;
  };

  // mount: load the persisted transcript, current config
  useEffect(() => {
    void bridge.reviewerTranscript(sessionId).then((rows) => {
      if (rows.length > 0) {
        setItems(rows.map((entry) => ({ seq: nextSeq(), at: entry.at, kind: 'message', role: entry.role, content: entry.content, finalized: true })));
      }
    });
    void bridge.getSettings().then((s) => {
      setSettings(s);
      setDraft({
        apiKey: s.reviewer.apiKey ?? '',
        provider: s.reviewer.provider ?? '',
        model: s.reviewer.model ?? '',
        baseUrl: s.reviewer.baseUrl ?? '',
      });
    });
  }, [sessionId]);

  useEffect(() => {
    const unsubs = [
      bridge.onReviewerStatus(sessionId, (s) => {
        setStatus(s.status as ReviewerStatus);
        setStatusError(s.error);
      }),
      bridge.onReviewerStream(sessionId, (delta) => {
        setItems((its) => {
          const last = its[its.length - 1];
          if (last && last.kind === 'message' && last.role === 'assistant' && !last.finalized) {
            const next = [...its];
            next[next.length - 1] = { ...last, content: `${last.content ?? ''}${delta}` };
            return next;
          }
          return [...its, { seq: nextSeq(), at: Date.now(), kind: 'message', role: 'assistant', content: delta, finalized: false }];
        });
      }),
      bridge.onReviewerToolCall(sessionId, (ev: ReviewerToolCallEvent) => {
        if (ev.state === 'start') {
          setItems((its) => [
            ...its,
            { seq: nextSeq(), at: ev.at, kind: 'tool', callId: ev.callId, name: ev.name, args: JSON.stringify(ev.args), state: 'start' },
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
        setItems((its) => {
          if (entry.role === 'assistant') {
            const last = its[its.length - 1];
            if (last && last.kind === 'message' && last.role === 'assistant' && !last.finalized) {
              const next = [...its];
              next[next.length - 1] = { ...last, content: entry.content, finalized: true };
              return next;
            }
          }
          return [...its, { seq: nextSeq(), at: entry.at, kind: 'message', role: entry.role, content: entry.content, finalized: true }];
        });
      }),
    ];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [sessionId]);

  // keep the transcript pinned to the newest content — but never yank a
  // reader who scrolled up; pinning resumes once they return to the bottom
  const pinnedRef = useRef(true);
  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const submit = (): void => {
    const text = input.trim();
    if (text.length === 0) return;
    setInput('');
    if (text === '/compact') {
      void bridge.compactReviewer(sessionId);
      return;
    }
    void bridge.promptReviewer(sessionId, text);
  };

  const retry = (): void => {
    void bridge.restartReviewer(sessionId).then((ok) => {
      setStatus(ok ? 'running' : 'unconfigured');
      setItems([]);
    });
  };

  const stop = (): void => {
    void bridge.stopReviewer(sessionId);
  };

  // live provider resolution from the pasted key (same logic the harness uses)
  const det = resolveProvider(draft.apiKey, {
    baseUrl: draft.baseUrl.trim() || undefined,
    providerHint: draft.provider || undefined,
    modelHint: draft.model.trim() || undefined,
  });
  const derived: DetectedProvider =
    det.adapter === 'openai' && (det.baseUrl.includes('deepseek') || draft.provider === 'deepseek')
      ? 'deepseek'
      : det.adapter;

  const saveConfig = (): void => {
    if (!settings) return;
    const next = {
      ...settings,
      reviewer: {
        apiKey: draft.apiKey.trim() || undefined,
        provider: (draft.provider || undefined) as Settings['reviewer']['provider'],
        model: draft.model.trim() || undefined,
        baseUrl: draft.baseUrl.trim() || undefined,
      },
    };
    void bridge.setSettings(next).then(() => {
      setSettings(next);
      setConfigOpen(false);
      void retry();
    });
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
        </div>
        <div className="reviewer-actions">
          {status === 'running' ? (
            <button type="button" className="orch-btn" onClick={stop}>
              stop
            </button>
          ) : (
            <button type="button" className="orch-btn orch-btn-primary" onClick={() => void retry()}>
              start
            </button>
          )}
          <button type="button" className="orch-btn" onClick={() => setConfigOpen((o) => !o)}>
            config
          </button>
        </div>
      </header>

      {configOpen && (
        <section className="reviewer-config">
          <label>
            api key
            <input
              type="password"
              value={draft.apiKey}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              placeholder="sk-…  (provider detected from the key)"
              autoComplete="off"
            />
          </label>
          <label>
            model
            <input
              list="reviewer-models"
              value={draft.model}
              onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))}
              placeholder={DEFAULT_MODELS[derived]}
            />
            <datalist id="reviewer-models">
              {REVIEWER_MODEL_SUGGESTIONS[derived].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label>
            baseUrl (optional)
            <input value={draft.baseUrl} onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))} placeholder="(provider default)" />
          </label>
          <div className="reviewer-config-provider">
            <span className="orch-judge-status orch-judge-running">{derived}</span>
            {det.ambiguous && (
              <select value={draft.provider} onChange={(e) => setDraft((d) => ({ ...d, provider: e.target.value }))}>
                <option value="">openai (default)</option>
                <option value="deepseek">deepseek</option>
              </select>
            )}
          </div>
          <div className="reviewer-config-actions">
            <button type="button" className="orch-btn" onClick={saveConfig}>
              save &amp; restart
            </button>
            <button type="button" className="orch-btn" onClick={() => setConfigOpen(false)}>
              cancel
            </button>
          </div>
        </section>
      )}

      <div className="reviewer-transcript" ref={scrollRef} onScroll={onScroll}>
        {status === 'unconfigured' && (
          <div className="reviewer-note reviewer-note-error">{statusError ?? 'reviewer not configured — open config'}</div>
        )}
        {status === 'error' && statusError && <div className="reviewer-note reviewer-note-error">{statusError}</div>}
        {items.length === 0 && status !== 'unconfigured' && status !== 'error' && (
          <div className="reviewer-empty">
            <div className="reviewer-empty-mark">reviewer</div>
            <div className="reviewer-empty-hint">prompt the reviewer — it observes every agent tile</div>
            <div className="reviewer-empty-sub">/compact collapses old turns · config sets the model key</div>
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
                  <span className="reviewer-item-time">{timeOf(it.at)}</span>
                </div>
                <div className="reviewer-item-body">
                  {sanitizeChatText(it.content ?? '')}
                  {!it.finalized && <span className="reviewer-caret" aria-hidden="true" />}
                </div>
              </div>
            </div>
          ) : (
            (() => {
              const key = it.callId ?? String(it.seq);
              const open = expanded[key] || it.state === 'error';
              return (
                <div key={it.seq} className={`reviewer-item reviewer-item-tool reviewer-item-tool-${it.state ?? 'start'}`}>
                  <div className="reviewer-tool-header">
                    <button type="button" className="reviewer-tool-toggle" onClick={() => setExpanded((e) => ({ ...e, [key]: !e[key] }))}>
                      <svg
                        className={`reviewer-tool-chevron${open ? ' reviewer-tool-chevron-open' : ''}`}
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path d="M3 1 L8 5 L3 9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="square" />
                      </svg>
                      <span className="reviewer-tool-name">{it.name}</span>
                    </button>
                    <span className="reviewer-tool-args">{sanitizeChatText(it.args ?? '')}</span>
                    <span className={`reviewer-tool-state reviewer-tool-state-${it.state ?? 'start'}`}>
                      {it.state === 'start' ? 'running' : it.state}
                    </span>
                    {it.state !== 'start' && it.durationMs !== undefined && (
                      <span className="reviewer-item-time">{it.durationMs}ms</span>
                    )}
                    {it.state !== 'start' && it.detail !== undefined && (
                      <button
                        type="button"
                        className="reviewer-icon-btn"
                        title="copy result"
                        onClick={() => void bridge.clipboardWrite(it.detail ?? '')}
                      >
                        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
                          <rect x="3.5" y="3.5" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.2" />
                          <path
                            d="M7.5 3.5 V2.5 C7.5 1.95 7.05 1.5 6.5 1.5 H2.5 C1.95 1.5 1.5 1.95 1.5 2.5 V6.5 C1.5 7.05 1.95 7.5 2.5 7.5 H3.5"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinecap="square"
                          />
                        </svg>
                      </button>
                    )}
                  </div>
                  {open && it.detail !== undefined && (
                    <pre className="reviewer-tool-detail">{sanitizeChatText(it.detail)}</pre>
                  )}
                </div>
              );
            })()
          ),
        )}
      </div>

      <footer className="reviewer-input">
        <div className="reviewer-composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
            placeholder={status === 'running' ? 'prompt the reviewer…' : 'reviewer not running'}
            disabled={status !== 'running'}
          />
          <button type="button" className="orch-btn orch-btn-primary" onClick={submit} disabled={status !== 'running'}>
            send
          </button>
        </div>
        <div className="reviewer-hint-line">/compact collapses old turns — never sent to the model</div>
      </footer>
    </div>
  );
}
