import type { SamplerKnobs } from '../../shared/ipc.js';

export interface KnobDraft {
  contextTokens: string;
  maxOutputTokens: string;
  temperature: string;
  topP: string;
  topK: string;
  minP: string;
  seed: string;
  repeatPenalty: string;
  presencePenalty: string;
  frequencyPenalty: string;
  keepAlive: string;
  thinkingMode: string;
  thinkingBudgetTokens: string;
}

export function numStr(v: number | undefined): string {
  return v === undefined ? '' : String(v);
}

/** input string → number ('' and junk → undefined; the settings whitelist
 *  drops out-of-range values at load, never coerces). */
function numOf(s: string): number | undefined {
  const t = s.trim();
  if (t.length === 0) return undefined;
  const v = Number(t);
  return Number.isFinite(v) ? v : undefined;
}

/** Draft → effective SamplerKnobs (unset fields omitted entirely). */
export function knobsFromDraft(d: KnobDraft): SamplerKnobs | undefined {
  const k: SamplerKnobs = {};
  const nums: Array<[NumKnobKey, string]> = [
    ['contextTokens', d.contextTokens],
    ['maxOutputTokens', d.maxOutputTokens],
    ['temperature', d.temperature],
    ['topP', d.topP],
    ['topK', d.topK],
    ['minP', d.minP],
    ['seed', d.seed],
    ['repeatPenalty', d.repeatPenalty],
    ['presencePenalty', d.presencePenalty],
    ['frequencyPenalty', d.frequencyPenalty],
  ];
  for (const [field, raw] of nums) {
    const v = numOf(raw);
    if (v !== undefined) k[field] = v;
  }
  const ka = d.keepAlive.trim();
  if (ka.length > 0) k.keepAlive = ka;
  // thinking policy: 'auto' is stored as unset (omitted = provider default)
  if (d.thinkingMode === 'on' || d.thinkingMode === 'off') k.thinkingMode = d.thinkingMode;
  const tb = numOf(d.thinkingBudgetTokens);
  if (tb !== undefined) k.thinkingBudgetTokens = tb;
  return Object.keys(k).length > 0 ? k : undefined;
}

/** Persisted SamplerKnobs → string drafts (the inverse of knobsFromDraft). */
export function draftFromKnobs(k: SamplerKnobs | undefined): KnobDraft {
  return {
    contextTokens: numStr(k?.contextTokens),
    maxOutputTokens: numStr(k?.maxOutputTokens),
    temperature: numStr(k?.temperature),
    topP: numStr(k?.topP),
    topK: numStr(k?.topK),
    minP: numStr(k?.minP),
    seed: numStr(k?.seed),
    repeatPenalty: numStr(k?.repeatPenalty),
    presencePenalty: numStr(k?.presencePenalty),
    frequencyPenalty: numStr(k?.frequencyPenalty),
    keepAlive: k?.keepAlive ?? '',
    thinkingMode: k?.thinkingMode ?? 'auto',
    thinkingBudgetTokens: numStr(k?.thinkingBudgetTokens),
  };
}

export type NumKnobKey =
  | 'contextTokens'
  | 'maxOutputTokens'
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'minP'
  | 'seed'
  | 'repeatPenalty'
  | 'presencePenalty'
  | 'frequencyPenalty'
  | 'thinkingBudgetTokens';

export type KnobAdapter = 'ollama' | 'openai' | 'anthropic';

/** Card grouping for the Sampling section — one SectionCard per id, in
 *  order; cards whose knobs are all hidden for the adapter don't render. */
export type KnobCard = 'context' | 'sampler' | 'ollama' | 'thinking';

export const KNOB_CARDS: Array<{ id: KnobCard; title: string }> = [
  { id: 'context', title: 'Context & output' },
  { id: 'sampler', title: 'Sampler' },
  { id: 'ollama', title: 'Ollama-only' },
  { id: 'thinking', title: 'Thinking' },
];

/** Inline-validation message for a knob value: undefined = acceptable
 *  (empty = unset). Mirrors the electron/settings.ts whitelist ranges —
 *  the UI must never let the user type a value the store would drop. */
export function knobRangeError(meta: KnobMeta, raw: string): string | undefined {
  if (meta.kind === 'select') return undefined;
  if (meta.key === 'keepAlive') {
    const t = raw.trim();
    if (t.length === 0) return undefined;
    return /^(\d+(ms|s|m|h))$/.test(t) || t === '0' ? undefined : 'use e.g. 5m, 30s, 1h — or 0 to unload';
  }
  if (meta.kind !== 'number' || meta.min === undefined || meta.max === undefined) return undefined;
  const t = raw.trim();
  if (t.length === 0) return undefined;
  const v = Number(t);
  if (!Number.isFinite(v) || v < meta.min || v > meta.max) {
    return meta.int ? `must be an integer between ${meta.min} and ${meta.max}` : `must be ${meta.min}–${meta.max}`;
  }
  if (meta.int && !Number.isInteger(v)) return `must be an integer between ${meta.min} and ${meta.max}`;
  return undefined;
}

/** The advanced knob registry: which fields render for which adapter and
 *  card, and each field's input metadata (min/max/step mirror the settings
 *  whitelist in electron/settings.ts). ollama maps onto engine options;
 *  openai (incl. deepseek) and anthropic only accept their standard fields. */
export const ADVANCED_KNOBS: Array<KnobMeta> = [
  {
    key: 'contextTokens',
    label: 'context window (tokens)',
    kind: 'number',
    adapters: ['ollama', 'openai', 'anthropic'],
    card: 'context',
    placeholder: 'e.g. 32768 · probed server caps this',
    hint: 'ollama: options.num_ctx (grows KV cache memory) · remote: compaction budget only',
    min: 1024,
    max: 1_048_576,
    step: 1,
    int: true,
  },
  {
    key: 'maxOutputTokens',
    label: 'max output tokens',
    kind: 'number',
    adapters: ['ollama', 'openai', 'anthropic'],
    card: 'context',
    placeholder: 'default 4096',
    hint: 'ollama num_predict ≥512 · anthropic clamped ≥8192 (thinking budget)',
    min: 256,
    max: 131_072,
    step: 1,
    int: true,
  },
  {
    key: 'temperature',
    label: 'temperature',
    kind: 'number',
    adapters: ['ollama', 'openai', 'anthropic'],
    card: 'sampler',
    placeholder: 'model default',
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
    key: 'topP',
    label: 'top_p',
    kind: 'number',
    adapters: ['ollama', 'openai', 'anthropic'],
    card: 'sampler',
    placeholder: 'model default',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'topK',
    label: 'top_k',
    kind: 'number',
    adapters: ['ollama'],
    card: 'ollama',
    placeholder: 'model default',
    min: 0,
    max: 1000,
    step: 1,
    int: true,
  },
  {
    key: 'minP',
    label: 'min_p',
    kind: 'number',
    adapters: ['ollama'],
    card: 'ollama',
    placeholder: 'model default',
    min: 0,
    max: 1,
    step: 0.01,
  },
  {
    key: 'seed',
    label: 'seed',
    kind: 'number',
    adapters: ['ollama', 'openai'],
    card: 'sampler',
    placeholder: '-1 = random',
    min: -1,
    max: 2_147_483_647,
    step: 1,
    int: true,
  },
  {
    key: 'repeatPenalty',
    label: 'repeat_penalty',
    kind: 'number',
    adapters: ['ollama'],
    card: 'ollama',
    placeholder: 'model default',
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
    key: 'presencePenalty',
    label: 'presence_penalty',
    kind: 'number',
    adapters: ['ollama', 'openai'],
    card: 'sampler',
    placeholder: 'model default',
    min: -2,
    max: 2,
    step: 0.05,
  },
  {
    key: 'frequencyPenalty',
    label: 'frequency_penalty',
    kind: 'number',
    adapters: ['ollama', 'openai'],
    card: 'sampler',
    placeholder: 'model default',
    min: -2,
    max: 2,
    step: 0.05,
  },
  {
    key: 'keepAlive',
    label: 'keep_alive',
    kind: 'text',
    adapters: ['ollama'],
    card: 'ollama',
    placeholder: 'default 1h',
    hint: 'e.g. 5m · 0 = unload after the turn',
  },
  {
    key: 'thinkingMode',
    label: 'thinking',
    kind: 'select',
    adapters: ['anthropic', 'ollama'],
    card: 'thinking',
    hint: 'auto = provider default (anthropic: extended thinking on · ollama: the server decides)',
    options: [
      { v: 'auto', label: 'auto (provider default)' },
      { v: 'on', label: 'on' },
      { v: 'off', label: 'off' },
    ],
  },
  {
    key: 'thinkingBudgetTokens',
    label: 'thinking budget',
    kind: 'number',
    adapters: ['anthropic'],
    card: 'thinking',
    placeholder: 'default 4096 · min 1024',
    hint: 'extended-thinking tokens — the output cap is clamped to budget + 4096 while thinking is on',
    min: 1024,
    max: 32768,
    step: 1,
    int: true,
  },
];

export interface KnobMeta {
  key: keyof KnobDraft;
  label: string;
  kind: 'number' | 'text' | 'select';
  adapters: KnobAdapter[];
  card: KnobCard;
  placeholder?: string;
  hint?: string;
  options?: Array<{ v: string; label: string }>;
  /** Inclusive validation range (mirrors electron/settings.ts). */
  min?: number;
  max?: number;
  /** Native number-input step (1 for integer knobs). */
  step?: number;
  /** Integer-only values (int drops from the whitelist otherwise). */
  int?: boolean;
}
