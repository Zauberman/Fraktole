import React, { useCallback, useEffect, useState } from 'react';
import { Select } from '../Select.js';
import { bridge } from '../../ipc.js';
import type { SessionSummary, UsageSample } from '../../shared/ipc.js';
import { SectionCard } from './fields.js';
import { fmtTokens } from './tokens.js';
import '../../styles/usage.css';

/** Settings > Usage: per-session token history for the reviewer harness.
 *  Pure tokens only — no cost or pricing anywhere. Two SVG graphs: stacked
 *  per-turn bars (last 60) and a cumulative area over the whole log. */

const BAR_WINDOW = 60;
const CHART_W = 600;
const CHART_H = 170;

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function totalOf(s: UsageSample): number {
  return s.inputTokens + s.cachedTokens + s.outputTokens;
}

export function UsageSection(): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [history, setHistory] = useState<UsageSample[] | null>(null);

  const loadHistory = useCallback(async (id: string): Promise<void> => {
    setHistory(await bridge.usageHistory(id).catch(() => [] as UsageSample[]));
  }, []);

  const loadSessions = useCallback(
    async (keep: string): Promise<void> => {
      const list = (await bridge.listSessions().catch(() => [] as SessionSummary[]))
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt);
      setSessions(list);
      const next = list.some((s) => s.id === keep) ? keep : (list[0]?.id ?? '');
      setSessionId(next);
      if (next.length === 0) setHistory(null);
      else if (next !== keep) void loadHistory(next);
    },
    [loadHistory],
  );

  useEffect(() => {
    void loadSessions('');
  }, [loadSessions]);

  const pick = useCallback(
    (id: string): void => {
      setSessionId(id);
      setHistory(null);
      if (id.length > 0) void loadHistory(id);
    },
    [loadHistory],
  );

  const refresh = useCallback((): void => {
    void loadSessions(sessionId);
    if (sessionId.length > 0) void loadHistory(sessionId);
  }, [loadSessions, loadHistory, sessionId]);

  const samples = history ?? [];
  const totals = samples.reduce(
    (acc, s) => ({ in: acc.in + s.inputTokens, cached: acc.cached + s.cachedTokens, out: acc.out + s.outputTokens }),
    { in: 0, cached: 0, out: 0 },
  );

  return (
    <div className="settings-section">
      <SectionCard title="Token usage" hint="per-session token history for the reviewer harness — pure tokens, no cost">
        <div className="usage-section">
          <div className="usage-picker">
            <Select
              ariaLabel="session"
              value={sessionId}
              placeholder="no sessions yet"
              onChange={pick}
              options={(sessions ?? []).map((sess) => ({ value: sess.id, label: sess.name }))}
            />
            <button type="button" className="btn btn-sm" onClick={refresh}>
              refresh
            </button>
          </div>

          {sessions === null || history === null ? (
            <div className="usage-dim">loading…</div>
          ) : sessions.length === 0 ? (
            <div className="usage-faint">no sessions yet</div>
          ) : samples.length === 0 ? (
            <div className="usage-faint">no turns recorded for this session</div>
          ) : (
            <>
              <div className="usage-totals">
                <span>
                  in {fmtTokens(totals.in)} · cached {fmtTokens(totals.cached)} · out {fmtTokens(totals.out)}
                </span>
                <span className="usage-faint">
                  {samples.length} turns · {fmtDate(samples[0]!.at)} – {fmtDate(samples[samples.length - 1]!.at)}
                </span>
              </div>
              <div className="usage-grid">
                <div>
                  <div className="usage-chart-title">per turn</div>
                  <TurnBars samples={samples} />
                </div>
                <div>
                  <div className="usage-chart-title">cumulative</div>
                  <CumulativeArea samples={samples} />
                </div>
              </div>
            </>
          )}
        </div>
      </SectionCard>
    </div>
  );
}

/** Stacked per-turn bars over the last 60 samples: input base, cached
 *  overlay, output accent; each bar carries a native hover title. */
function TurnBars({ samples }: { samples: UsageSample[] }): React.JSX.Element {
  const shown = samples.slice(-BAR_WINDOW);
  const max = Math.max(1, ...shown.map(totalOf));
  const step = CHART_W / shown.length;
  const barW = Math.max(1, step * 0.6);
  return (
    <svg className="usage-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" role="img" aria-label="per-turn token usage">
      {shown.map((s, i) => {
        const x = i * step + (step - barW) / 2;
        const hIn = (s.inputTokens / max) * CHART_H;
        const hCached = (s.cachedTokens / max) * CHART_H;
        const hOut = (s.outputTokens / max) * CHART_H;
        const yIn = CHART_H - hIn;
        const yCached = yIn - hCached;
        const yOut = yCached - hOut;
        return (
          <g key={`${i}-${s.at}`}>
            <title>
              {`${fmtDate(s.at)} · in ${fmtTokens(s.inputTokens)} · cached ${fmtTokens(s.cachedTokens)} · out ${fmtTokens(
                s.outputTokens,
              )}`}
            </title>
            {s.inputTokens > 0 && <rect x={x} y={yIn} width={barW} height={hIn} fill="var(--text-faint)" />}
            {s.cachedTokens > 0 && <rect x={x} y={yCached} width={barW} height={hCached} fill="var(--accent-tint)" />}
            {s.outputTokens > 0 && <rect x={x} y={yOut} width={barW} height={hOut} fill="var(--accent)" />}
          </g>
        );
      })}
    </svg>
  );
}

/** Running total of in+cached+output as one smooth line over a faint fill. */
function CumulativeArea({ samples }: { samples: UsageSample[] }): React.JSX.Element {
  const totals: number[] = [];
  let run = 0;
  for (const s of samples) {
    run += totalOf(s);
    totals.push(run);
  }
  const max = Math.max(1, totals[totals.length - 1] ?? 1);
  const x = (i: number): number => (totals.length <= 1 ? CHART_W / 2 : (i / (totals.length - 1)) * CHART_W);
  const y = (t: number): number => CHART_H - (t / max) * CHART_H;
  const line = smoothPath(totals.map((t, i) => [x(i), y(t)] as const));
  const area = line.length > 0 ? `${line} L ${CHART_W} ${CHART_H} L 0 ${CHART_H} Z` : '';
  return (
    <svg className="usage-chart" viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" role="img" aria-label="cumulative token usage">
      {area.length > 0 && <path d={area} fill="var(--accent-tint)" stroke="none" />}
      {line.length > 0 && <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  );
}

/** Catmull-Rom through every point, emitted as cubic beziers. */
function smoothPath(pts: ReadonlyArray<readonly [number, number]>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0]![0]} ${pts[0]![1]}`;
  let d = `M ${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}
