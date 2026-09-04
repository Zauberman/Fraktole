import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../../ipc.js';
import type { ReviewerProbeArgs, ReviewerProbeResult } from '../../shared/ipc.js';

const POLL_MS = 5_000;

/** Continuous local-provider health: polls the reviewer:probe IPC every 5s
 *  while enabled (the model section open) and once immediately whenever the
 *  probe target changes. A seq counter guards responses so a slow reply for
 *  an earlier target can never overwrite a newer one. */
export function useReviewerHealth(args: ReviewerProbeArgs, enabled: boolean): { result: ReviewerProbeResult | null; refresh: () => void } {
  const [result, setResult] = useState<ReviewerProbeResult | null>(null);
  const seq = useRef(0);
  const argsRef = useRef(args);
  argsRef.current = args;

  const probe = useCallback(async (): Promise<void> => {
    const my = ++seq.current;
    try {
      const r = await bridge.probeReviewer(argsRef.current);
      if (seq.current === my) setResult(r ?? null);
    } catch {
      if (seq.current === my) setResult({ state: 'unreachable', models: [], detail: 'probe failed' });
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    void probe();
    const timer = setInterval(() => void probe(), POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, probe, args.adapter, args.baseUrl, args.model, args.apiKey]);

  return { result, refresh: probe };
}
