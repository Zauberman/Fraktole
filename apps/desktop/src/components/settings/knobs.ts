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
  think: string;
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
  if (d.think === 'on') k.think = true;
  else if (d.think === 'off') k.think = false;
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
    think: k?.think === undefined ? 'auto' : k.think ? 'on' : 'off',
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
  | 'frequencyPenalty';

export type KnobAdapter = 'ollama' | 'openai' | 'anthropic';

/** The advanced knob registry: which fields render for which adapter, and
 *  each field's input metadata. ollama maps onto engine options; openai
 *  (incl. deepseek) and anthropic only accept their standard fields. */
export const ADVANCED_KNOBS: Array<{
  key: keyof KnobDraft;
  label: string;
  kind: 'number' | 'text' | 'select';
  adapters: KnobAdapter[];
  placeholder?: string;
  hint?: string;
  options?: Array<{ v: string; label: string }>;
}> = [
  {
    key: 'contextTokens',
    label: 'context window (tokens)',
    kind: 'number',
    adapters: ['ollama', 'openai', 'anthropic'],
    hint: 'ollama: options.num_ctx (grows KV cache memory) · remote: compaction budget only',
  },
  {
    key: 'maxOutputTokens',
    label: 'max output tokens',
    kind: 'number',
    adapters: ['ollama', 'openai', 'anthropic'],
    hint: 'ollama num_predict ≥512 · anthropic clamped ≥8192 (thinking budget)',
  },
  { key: 'temperature', label: 'temperature', kind: 'number', adapters: ['ollama', 'openai', 'anthropic'], placeholder: 'model default' },
  { key: 'topP', label: 'top_p', kind: 'number', adapters: ['ollama', 'openai', 'anthropic'], placeholder: 'model default' },
  { key: 'topK', label: 'top_k', kind: 'number', adapters: ['ollama'], placeholder: 'model default' },
  { key: 'minP', label: 'min_p', kind: 'number', adapters: ['ollama'], placeholder: 'model default' },
  { key: 'seed', label: 'seed', kind: 'number', adapters: ['ollama', 'openai'], placeholder: '-1 = random' },
  { key: 'repeatPenalty', label: 'repeat_penalty', kind: 'number', adapters: ['ollama'], placeholder: 'model default' },
  { key: 'presencePenalty', label: 'presence_penalty', kind: 'number', adapters: ['ollama', 'openai'], placeholder: 'model default' },
  { key: 'frequencyPenalty', label: 'frequency_penalty', kind: 'number', adapters: ['ollama', 'openai'], placeholder: 'model default' },
  {
    key: 'keepAlive',
    label: 'keep_alive',
    kind: 'text',
    adapters: ['ollama'],
    placeholder: 'e.g. 5m · 0 = unload after the turn',
  },
  {
    key: 'think',
    label: 'thinking (ollama)',
    kind: 'select',
    adapters: ['ollama'],
    hint: 'true only on thinking-capable models (qwen3, llama4…); non-thinking models 400 on it',
    options: [
      { v: 'auto', label: 'auto (model default)' },
      { v: 'on', label: 'on' },
      { v: 'off', label: 'off' },
    ],
  },
];
