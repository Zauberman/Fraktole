/** Live model listing per provider adapter, fetched straight from the API
 *  so the config form never shows a stale hardcoded list. Any failure
 *  (network, auth, proxy, unknown shape) resolves to [] — the caller falls
 *  back to the offline suggestions. */

const LIST_TIMEOUT_MS = 8_000;
const LIST_CAP = 100;

export type ModelListOpts = {
  adapter: 'openai' | 'anthropic' | 'ollama';
  apiKey: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
};

export async function listModels(opts: ModelListOpts): Promise<string[]> {
  try {
    const fetcher = opts.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
    let ids: string[];
    try {
      ids = await fetchByAdapter(fetcher, opts, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    return [...new Set(ids)].slice(0, LIST_CAP);
  } catch {
    return [];
  }
}

async function fetchByAdapter(
  fetcher: typeof globalThis.fetch,
  opts: ModelListOpts,
  signal: AbortSignal,
): Promise<string[]> {
  const { adapter, apiKey, baseUrl } = opts;
  if (adapter === 'anthropic') {
    const res = await fetcher('https://api.anthropic.com/v1/models', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal,
    });
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? []).map((m) => m.id ?? '').filter((id) => id.length > 0);
  }
  if (adapter === 'ollama') {
    const res = await fetcher(`${baseUrl}/api/tags`, { signal });
    const json = (await res.json()) as { models?: Array<{ name?: string }> };
    return (json.models ?? []).map((m) => m.name ?? '').filter((name) => name.length > 0);
  }
  const res = await fetcher(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  const json = (await res.json()) as { data?: Array<{ id?: string }> };
  return (json.data ?? []).map((m) => m.id ?? '').filter((id) => id.length > 0);
}
