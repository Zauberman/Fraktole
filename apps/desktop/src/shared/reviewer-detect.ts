/** Provider resolution for the reviewer harness: derive the provider,
 *  endpoint and model from a single API key. Pure module — imported by both
 *  the main process (ReviewerHost) and the renderer (config form), so the
 *  badge shown while typing always matches what the harness will use.
 *
 *  Key prefixes:
 *    sk-ant-*            → Anthropic (unambiguous)
 *    sk-proj-* and sk-svcacct-* → OpenAI (unambiguous)
 *    sk-*                → ambiguous (OpenAI vs DeepSeek vs compatible
 *                          endpoints) — resolved by baseUrl hints or the
 *                          user's dropdown pick; defaults to OpenAI
 *    empty               → Ollama (local, keyless)
 *    anything else       → usable only with a custom baseUrl
 */
export type DetectedProvider = 'anthropic' | 'openai' | 'deepseek' | 'ollama';

export interface ProviderResolution {
  /** Which ProviderClient adapter to build. */
  adapter: 'anthropic' | 'openai' | 'ollama';
  model: string;
  baseUrl: string;
  /** True when the key alone cannot identify the provider and no hint
   *  resolves it — the config form must ask the user. */
  ambiguous: boolean;
}

export const DEFAULT_MODELS: Record<DetectedProvider, string> = {
  anthropic: 'claude-sonnet-4-5',
  openai: 'gpt-4o',
  deepseek: 'deepseek-v4-flash',
  ollama: 'qwen2.5',
};

export const BASE_URLS: Record<'anthropic' | 'openai' | 'deepseek', string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
};

/** Model suggestions per detected provider (the user picks; free text ok).
 *  The config form also fetches the live model list from the API
 *  (electron/model-list.ts) and prefers it — these are the offline fallback. */
export const REVIEWER_MODEL_SUGGESTIONS: Record<DetectedProvider, string[]> = {
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', 'claude-3-7-sonnet-latest'],
  openai: ['gpt-4o', 'gpt-5', 'gpt-5-mini', 'o4-mini'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
  ollama: ['qwen2.5', 'llama3.2', 'qwen3', 'mistral'],
};

export interface ResolveOpts {
  /** Custom OpenAI-compatible endpoint (also the DeepSeek hint). */
  baseUrl?: string;
  /** The user's explicit provider pick (dropdown, ambiguous keys only). */
  providerHint?: string;
  /** The user's model pick (overrides the per-provider default). */
  modelHint?: string;
}

export function resolveProvider(key: string, opts: ResolveOpts = {}): ProviderResolution {
  const k = key.trim();
  if (k.length === 0) {
    return {
      adapter: 'ollama',
      model: opts.modelHint ?? DEFAULT_MODELS.ollama,
      baseUrl: 'http://localhost:11434',
      ambiguous: false,
    };
  }
  if (k.startsWith('sk-ant-')) {
    return {
      adapter: 'anthropic',
      model: opts.modelHint ?? DEFAULT_MODELS.anthropic,
      baseUrl: opts.baseUrl ?? BASE_URLS.anthropic,
      ambiguous: false,
    };
  }
  if (k.startsWith('sk-proj-') || k.startsWith('sk-svcacct-')) {
    return {
      adapter: 'openai',
      model: opts.modelHint ?? DEFAULT_MODELS.openai,
      baseUrl: opts.baseUrl ?? BASE_URLS.openai,
      ambiguous: false,
    };
  }
  if (k.startsWith('sk-')) {
    if (opts.baseUrl?.toLowerCase().includes('deepseek') || opts.providerHint === 'deepseek') {
      return {
        adapter: 'openai',
        model: opts.modelHint ?? DEFAULT_MODELS.deepseek,
        baseUrl: opts.baseUrl ?? BASE_URLS.deepseek,
        ambiguous: false,
      };
    }
    if (opts.providerHint === 'openai' || (opts.baseUrl && opts.baseUrl.length > 0)) {
      return {
        adapter: 'openai',
        model: opts.modelHint ?? DEFAULT_MODELS.openai,
        baseUrl: opts.baseUrl ?? BASE_URLS.openai,
        ambiguous: false,
      };
    }
    return {
      adapter: 'openai',
      model: opts.modelHint ?? DEFAULT_MODELS.openai,
      baseUrl: BASE_URLS.openai,
      ambiguous: true,
    };
  }
  // unknown prefix: only usable with a custom baseUrl
  return {
    adapter: 'openai',
    model: opts.modelHint ?? DEFAULT_MODELS.openai,
    baseUrl: opts.baseUrl ?? BASE_URLS.openai,
    ambiguous: !opts.baseUrl,
  };
}
