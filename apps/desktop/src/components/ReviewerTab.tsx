import React, { useEffect, useRef, useState } from 'react';
import type { FraktoleMessage, ReviewerEntry, ReviewerStatus, ReviewerToolCallEvent } from '../ipc.js';
import { bridge, type Settings } from '../ipc.js';
import {
  DEFAULT_MODELS,
  REVIEWER_MODEL_SUGGESTIONS,
  resolveProvider,
  type DetectedProvider,
} from '../shared/reviewer-detect.js';

interface ReviewerTabProps {
  sessionId: string;
  messages: FraktoleMessage[];
}

function timeOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface ToolRowState {
  name: string;
  args: string;
  state: 'start' | 'done' | 'error';
  detail?: string;
  durationMs?: number;
}

/**
 * The Reviewer tab: the harness's space — its streaming transcript (model
 * text, tool calls, agent-result notes), its status, and the prompt box.
 */
export function ReviewerTab(props: ReviewerTabProps): React.JSX.Element {
  const { sessionId, messages } = props;
  const [status, setStatus] = useState<ReviewerStatus>('offline');
  const [statusError, setStatusError] = useState<string | undefined>(undefined);
  const [entries, setEntries] = useState<ReviewerEntry[]>([]);
  const [streamText, setStreamText] = useState('');
  const [tools, setTools] = useState<ToolRowState[]>([]);
  const [input, setInput] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState({ apiKey: '', provider: '', model: '', baseUrl: '' });
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // mount: load the persisted transcript, current config
  useEffect(() => {
    void bridge.reviewerTranscript(sessionId).then((rows) => {
      if (rows.length > 0) setEntries(rows);
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
      bridge.onReviewerStream(sessionId, (delta) => setStreamText((t) => t + delta)),
      bridge.onReviewerToolCall(sessionId, (ev: ReviewerToolCallEvent) => {
        if (ev.state === 'start') {
          setTools((ts) => [...ts, { name: ev.name, args: JSON.stringify(ev.args), state: 'start' }]);
        } else {
          setTools((ts) => {
            const next = [...ts];
            const last = next[next.length - 1];
            if (last && last.name === ev.name) {
              next[next.length - 1] = {
                ...last,
                state: ev.state,
                detail: ev.error ?? ev.result,
                durationMs: ev.durationMs,
              };
            } else {
              next.push({ name: ev.name, args: JSON.stringify(ev.args), state: ev.state, detail: ev.error ?? ev.result, durationMs: ev.durationMs });
            }
            return next;
          });
        }
      }),
      bridge.onReviewerMessage(sessionId, (entry) => {
        if (entry.role === 'assistant') setStreamText('');
        setEntries((es) => [...es, entry]);
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
  }, [entries, streamText, tools]);

  const submit = (): void => {
    const text = input.trim();
    if (text.length === 0) return;
    setInput('');
    void bridge.promptReviewer(sessionId, text);
  };

  const retry = (): void => {
    void bridge.restartReviewer(sessionId).then((ok) => {
      setStatus(ok ? 'running' : 'unconfigured');
      setStreamText('');
      setTools([]);
    });
  };

  const stop = (): void => {
    void bridge.stopReviewer(sessionId);
    setTools([]);
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

  const judgeThread = messages.filter((m) => m.from === 'orchestrator' || m.to === 'orchestrator');

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
        {entries.length === 0 && streamText === '' && tools.length === 0 && (
          <div className="orch-hint">no activity yet — prompt the reviewer below; it observes every agent tile</div>
        )}
        {entries.map((e, i) => (
          <div key={i} className={`reviewer-row reviewer-row-${e.role}`}>
            <div className="reviewer-row-meta">
              <span className="reviewer-row-role">{e.role}</span>
              <span className="orch-msg-time">{timeOf(e.at)}</span>
            </div>
            <div className="reviewer-row-body">{e.content}</div>
          </div>
        ))}
        {tools.map((t, i) => (
          <div key={`t${i}`} className={`reviewer-row reviewer-row-tool reviewer-row-tool-${t.state}`}>
            <div className="reviewer-row-meta">
              <span className="reviewer-row-role">tool</span>
              <span className="orch-msg-time">
                {t.state === 'start' ? 'running…' : `${t.state}${t.durationMs !== undefined ? ` · ${t.durationMs}ms` : ''}`}
              </span>
            </div>
            <div className="reviewer-row-body">
              <span className="reviewer-tool-name">{t.name}</span> <span className="reviewer-tool-args">{t.args}</span>
              {t.detail !== undefined && <pre className="reviewer-tool-detail">{t.detail}</pre>}
            </div>
          </div>
        ))}
        {streamText !== '' && (
          <div className="reviewer-row reviewer-row-assistant">
            <div className="reviewer-row-body reviewer-stream">{streamText}</div>
          </div>
        )}
      </div>

      <section className="reviewer-log">
        <div className="orch-section-title">orchestrator messages</div>
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

      <footer className="reviewer-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder={status === 'running' ? 'prompt the reviewer…' : 'reviewer not running — click retry'}
          disabled={status !== 'running'}
        />
        <button type="button" className="orch-btn" onClick={submit} disabled={status !== 'running'}>
          send
        </button>
      </footer>
    </div>
  );
}
