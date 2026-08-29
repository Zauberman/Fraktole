/** Local-server probing: discovers what a local model server ACTUALLY runs
 *  with (context window, readiness) so the harness budget always matches the
 *  server the user launched — not a name-based guess. Best-effort by design:
 *  every probe failure is a benign `undefined`/unreachable, never a throw
 *  that would abort the reviewer start. */

const PROBE_TIMEOUT_MS = 4_000;

export interface LocalProbeResult {
  /** The server's real context window, when the server reports one. */
  contextTokens: number | undefined;
  /** 'ok' — answered (context may still be undefined); 'loading' — server is
   *  up but still loading the model (503 "Loading model"); 'unreachable' —
   *  no answer at all. */
  state: 'ok' | 'loading' | 'unreachable';
  kind: 'llamacpp' | 'ollama' | 'openai-compat' | 'unknown';
}

export interface ProbeTarget {
  adapter: 'openai' | 'ollama';
  baseUrl: string;
  model: string;
}

/** Injectable seam for tests: the host calls this with a ProbeTarget and
 *  never touches the network directly. */
export type ProbeFn = (target: ProbeTarget) => Promise<LocalProbeResult>;

/** llama.cpp: GET /props → default_generation_settings.n_ctx (per-slot).
 *  LM Studio/vLLM/others: GET /v1/models → data[0].meta.n_ctx /
 *  data[0].context_length / data[0].max_model_len (best-effort across
 *  versions). Ollama: POST /api/show → model_info.*context_length. */
export async function probeLocalServer(
  target: ProbeTarget,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<LocalProbeResult> {
  const base = target.baseUrl.trim().replace(/\/+$/, '');
  if (base.length === 0) return { contextTokens: undefined, state: 'unreachable', kind: 'unknown' };
  const ask = async (url: string, init?: RequestInit): Promise<Response> => {
    return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  };
  try {
    if (target.adapter === 'ollama') {
      const res = await ask(`${base}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: target.model }),
      });
      if (!res.ok) return { contextTokens: undefined, state: 'unreachable', kind: 'ollama' };
      const json = (await res.json()) as { model_info?: Record<string, unknown> };
      return { contextTokens: pickContext(json.model_info ?? {}), state: 'ok', kind: 'ollama' };
    }
    // openai-adapter locals: llama.cpp /props first (authoritative per-slot ctx),
    // then the OpenAI-compatible /v1/models metadata
    try {
      const props = await ask(`${base}/props`);
      if (props.status === 503) return { contextTokens: undefined, state: 'loading', kind: 'llamacpp' };
      if (props.ok) {
        const json = (await props.json()) as { default_generation_settings?: { n_ctx?: number } };
        const n = json.default_generation_settings?.n_ctx;
        if (typeof n === 'number' && n > 0) return { contextTokens: n, state: 'ok', kind: 'llamacpp' };
      }
    } catch {
      // no /props (LM Studio, vLLM, LocalAI…) — fall through to /v1/models
    }
    try {
      const models = await ask(`${base}/models`);
      if (models.ok) {
        const json = (await models.json()) as { data?: Array<Record<string, unknown>>; max_model_len?: number };
        const first = json.data?.[0] ?? {};
        const meta = (first.meta ?? {}) as Record<string, unknown>;
        // servers report the window under different keys (context_length for
        // LM Studio, max_model_len for vLLM, meta.n_ctx for llama.cpp) — take
        // the SMALLEST candidate so the budget never exceeds the real limit
        const candidates = [first.n_ctx, meta.n_ctx, meta.n_ctx_train, first.max_model_len, json.max_model_len, first.context_length];
        const seen = candidates.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
        if (seen.length > 0) return { contextTokens: Math.min(...seen), state: 'ok', kind: 'openai-compat' };
        return { contextTokens: undefined, state: 'ok', kind: 'openai-compat' };
      }
      if (models.status >= 500) return { contextTokens: undefined, state: 'loading', kind: 'openai-compat' };
    } catch {
      // unreachable
    }
    return { contextTokens: undefined, state: 'unreachable', kind: 'unknown' };
  } catch {
    return { contextTokens: undefined, state: 'unreachable', kind: 'unknown' };
  }
}

/** Ollama /api/show model_info keys are backend-prefixed
 *  ("llama.context_length", "qwen2.context_length", …) — any key ending in
 *  "context_length" is a context signal; prefer the shortest (smallest
 *  window) so the budget never exceeds the real limit on a weird server. */
function pickContext(modelInfo: Record<string, unknown>): number | undefined {
  let best: number | undefined;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (!key.toLowerCase().endsWith('context_length')) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    if (best === undefined || value < best) best = value;
  }
  return best;
}
