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

  // keep the transcript pinned to the newest content
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
        <div className="pane-title">Reviewer — harness</div>
        <div className="reviewer-actions">
          <span className={`orch-judge-status orch-judge-${status}`}>{status}</span>
          {status !== 'running' && (
            <button type="button" className="orch-btn" onClick={() => void retry()}>
              retry
            </button>
          )}
          <button type="button" className="orch-btn" onClick={stop}>
            stop
          </button>
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

      <div className="reviewer-transcript" ref={scrollRef}>
        {status === 'unconfigured' && (
          <div className="reviewer-note reviewer-note-error">{statusError ?? 'reviewer not configured — open config'}</div>
        )}
        {status === 'error' && statusError && <div className="reviewer-note reviewer-note-error">{statusError}</div>}
        {items.length === 0 && (
          <div className="orch-hint">no activity yet — prompt the reviewer below; it observes every agent tile</div>
        )}
        {items.map((it) =>
          it.kind === 'message' ? (
            <div key={it.seq} className={`reviewer-item reviewer-item-${it.role ?? 'system'}${it.finalized ? '' : ' reviewer-live'}`}>
              <div className="reviewer-item-meta">
                <span className="reviewer-item-role">{it.role ?? 'system'}</span>
                <span className="orch-msg-time">{timeOf(it.at)}</span>
              </div>
              <div className="reviewer-item-body">{sanitizeChatText(it.content ?? '')}</div>
            </div>
          ) : (
            <div key={it.seq} className={`reviewer-item reviewer-item-tool reviewer-item-tool-${it.state ?? 'start'}`}>
              <div className="reviewer-item-meta">
                <span className="reviewer-item-role">tool</span>
                <span className="reviewer-tool-name">{it.name}</span>
                <span className="reviewer-tool-args">{sanitizeChatText(it.args ?? '')}</span>
                <span className="orch-msg-time">
                  {it.state === 'start' ? 'running…' : `${it.state}${it.durationMs !== undefined ? ` · ${it.durationMs}ms` : ''}`}
                </span>
                {it.state !== 'start' && it.detail !== undefined && (
                  <button
                    type="button"
                    className="orch-btn"
                    onClick={() => setExpanded((e) => ({ ...e, [it.callId ?? String(it.seq)]: !e[it.callId ?? String(it.seq)] }))}
                  >
                    {expanded[it.callId ?? String(it.seq)] ? 'collapse' : 'expand'}
                  </button>
                )}
                {it.state !== 'start' && it.detail !== undefined && (
                  <button
                    type="button"
                    className="orch-btn"
                    onClick={() => void navigator.clipboard.writeText(it.detail ?? '')}
                  >
                    copy
                  </button>
                )}
              </div>
              {it.state !== 'start' && it.detail !== undefined && (expanded[it.callId ?? String(it.seq)] || it.state === 'error') && (
                <pre className="reviewer-tool-detail">{sanitizeChatText(it.detail)}</pre>
              )}
            </div>
          ),
        )}
      </div>

      <footer className="reviewer-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder={status === 'running' ? 'prompt the reviewer…  (/compact)' : 'reviewer not running — click retry'}
          disabled={status !== 'running'}
        />
        <button type="button" className="orch-btn" onClick={submit} disabled={status !== 'running'}>
          send
        </button>
      </footer>
    </div>
  );
}
