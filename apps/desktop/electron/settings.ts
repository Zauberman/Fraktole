import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  EditorSettings,
  ExplorerSettings,
  NotificationSettings,
  SamplerKnobs,
  Settings,
} from '../src/shared/ipc.js';
import { sanitizeAllowedLaunchers } from '../src/shared/launchers.js';

const DEFAULT_EDITOR: EditorSettings = { wrap: true, autoSave: false };
const DEFAULT_NOTIFICATIONS: NotificationSettings = { enabled: true };
const DEFAULT_EXPLORER: ExplorerSettings = { hideHidden: true };

/** Boolean settings flag: a real boolean wins, anything else falls back. */
function boolFlag(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Numeric range validator for the sampler knobs: any non-finite or
 *  out-of-range value is dropped (never coerced) — a bad bump in a
 *  settings file must not 400 the provider. */
function knobNumber(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  return v >= min && v <= max ? v : undefined;
}

function knobInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isInteger(v)) return undefined;
  return knobNumber(v, min, max);
}

/** Parses the model-tuning knobs with per-field ranges. Invalid values
 *  drop individually; missing/absent knobs yield undefined. */
function parseKnobs(raw: Record<string, unknown> | undefined): SamplerKnobs | undefined {
  if (!raw) return undefined;
  const k: SamplerKnobs = {};
  const c = knobInt(raw.contextTokens, 1024, 1_048_576);
  if (c !== undefined) k.contextTokens = c;
  const m = knobInt(raw.maxOutputTokens, 256, 131_072);
  if (m !== undefined) k.maxOutputTokens = m;
  const t = knobNumber(raw.temperature, 0, 2);
  if (t !== undefined) k.temperature = t;
  const p = knobNumber(raw.topP, 0, 1);
  if (p !== undefined) k.topP = p;
  const tk = knobInt(raw.topK, 0, 1000);
  if (tk !== undefined) k.topK = tk;
  const mp = knobNumber(raw.minP, 0, 1);
  if (mp !== undefined) k.minP = mp;
  const s = knobInt(raw.seed, -1, 2_147_483_647);
  if (s !== undefined) k.seed = s;
  const rp = knobNumber(raw.repeatPenalty, 0, 2);
  if (rp !== undefined) k.repeatPenalty = rp;
  const pr = knobNumber(raw.presencePenalty, -2, 2);
  if (pr !== undefined) k.presencePenalty = pr;
  const fr = knobNumber(raw.frequencyPenalty, -2, 2);
  if (fr !== undefined) k.frequencyPenalty = fr;
  if (typeof raw.keepAlive === 'string' && (/^(\d+(ms|s|m|h))$/.test(raw.keepAlive) || raw.keepAlive === '0')) {
    k.keepAlive = raw.keepAlive;
  }
  if (typeof raw.think === 'boolean') k.think = raw.think;
  return Object.keys(k).length > 0 ? k : undefined;
}

/** Parses the file-editor preferences; defaults fill absent flags, an
 *  out-of-range font size is dropped (never coerced). */
function parseEditor(raw: Record<string, unknown> | undefined): EditorSettings {
  const out: EditorSettings = {
    wrap: boolFlag(raw?.wrap, DEFAULT_EDITOR.wrap),
    autoSave: boolFlag(raw?.autoSave, DEFAULT_EDITOR.autoSave),
  };
  const fontSize = knobInt(raw?.fontSize, 10, 20);
  if (fontSize !== undefined) out.fontSize = fontSize;
  return out;
}

function parseNotifications(raw: Record<string, unknown> | undefined): NotificationSettings {
  return { enabled: boolFlag(raw?.enabled, DEFAULT_NOTIFICATIONS.enabled) };
}

function parseExplorer(raw: Record<string, unknown> | undefined): ExplorerSettings {
  return { hideHidden: boolFlag(raw?.hideHidden, DEFAULT_EXPLORER.hideHidden) };
}

/**
 * App preferences, persisted as JSON under userData: the color theme and the
 * reviewer harness config. The reviewer derives provider/endpoint from the
 * pasted API key (src/shared/reviewer-detect.ts); explicit overrides are
 * optional and only used for ambiguous sk- keys.
 */
const KNOWN_TOP_KEYS = new Set(['theme', 'editor', 'notifications', 'explorer', 'reviewer']);
const KNOWN_REVIEWER_KEYS = new Set([
  'apiKey',
  'apiKeyEnv',
  'providerId',
  'provider',
  'model',
  'baseUrl',
  'agentCommand',
  'allowedLaunchers',
  'reasoningEffort',
  'knobs',
  'customAutonomy',
]);

/** Strips unknown keys from an incoming settings patch (prototype-safe:
 *  spread only copies known fields). */
function sanitizePatch(patch: Partial<Settings>): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!KNOWN_TOP_KEYS.has(k)) continue;
    if (k === 'reviewer' && typeof v === 'object' && v !== null) {
      const rv: Record<string, unknown> = {};
      for (const [rk, rvv] of Object.entries(v as Record<string, unknown>)) {
        if (KNOWN_REVIEWER_KEYS.has(rk)) rv[rk] = rvv;
      }
      out[k] = rv;
    } else {
      out[k] = v;
    }
  }
  return out as Partial<Settings>;
}

export class SettingsStore {
  constructor(private readonly file: string) {}

  /** Serializes read-modify-write sets so concurrent callers cannot clobber
   *  each other's patches. */
  private setQueue: Promise<unknown> = Promise.resolve();

  async get(): Promise<Settings> {
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      const provider = parsed.reviewer?.provider;
      return {
        theme: typeof parsed.theme === 'string' ? parsed.theme : 'midnight',
        editor: parseEditor(parsed.editor as Record<string, unknown> | undefined),
        notifications: parseNotifications(parsed.notifications as Record<string, unknown> | undefined),
        explorer: parseExplorer(parsed.explorer as Record<string, unknown> | undefined),
        reviewer: {
          apiKey: typeof parsed.reviewer?.apiKey === 'string' ? parsed.reviewer.apiKey : undefined,
          apiKeyEnv: typeof parsed.reviewer?.apiKeyEnv === 'string' ? parsed.reviewer.apiKeyEnv : undefined,
          providerId:
            typeof parsed.reviewer?.providerId === 'string' && parsed.reviewer.providerId.trim().length > 0
              ? parsed.reviewer.providerId
              : undefined,
          provider:
            provider === 'openai' || provider === 'anthropic' || provider === 'ollama' || provider === 'deepseek'
              ? provider
              : undefined,
          model: typeof parsed.reviewer?.model === 'string' ? parsed.reviewer.model : undefined,
          baseUrl: typeof parsed.reviewer?.baseUrl === 'string' ? parsed.reviewer.baseUrl : undefined,
          agentCommand: typeof parsed.reviewer?.agentCommand === 'string' ? parsed.reviewer.agentCommand : undefined,
          allowedLaunchers: sanitizeAllowedLaunchers(parsed.reviewer?.allowedLaunchers),
          reasoningEffort:
            parsed.reviewer?.reasoningEffort === 'low' ||
            parsed.reviewer?.reasoningEffort === 'medium' ||
            parsed.reviewer?.reasoningEffort === 'high'
              ? parsed.reviewer.reasoningEffort
              : undefined,
          knobs: parseKnobs(parsed.reviewer?.knobs as Record<string, unknown> | undefined),
          customAutonomy:
            typeof parsed.reviewer?.customAutonomy?.name === 'string' ||
            typeof parsed.reviewer?.customAutonomy?.prompt === 'string'
              ? {
                  name: typeof parsed.reviewer?.customAutonomy?.name === 'string' ? parsed.reviewer.customAutonomy.name : undefined,
                  prompt:
                    typeof parsed.reviewer?.customAutonomy?.prompt === 'string' ? parsed.reviewer.customAutonomy.prompt : undefined,
                }
              : undefined,
        },
      };
    } catch {
      return { theme: 'midnight', editor: DEFAULT_EDITOR, notifications: DEFAULT_NOTIFICATIONS, explorer: DEFAULT_EXPLORER, reviewer: {} };
    }
  }

  async set(rawPatch: Partial<Settings>): Promise<Settings> {
    const run = this.setQueue.then(async () => {
      const current = await this.get();
      // key whitelist: unknown top-level and reviewer keys are dropped — the
      // renderer is untrusted and must not persist arbitrary settings fields
      const patch = sanitizePatch(rawPatch);
      const next: Settings = {
        ...current,
        ...patch,
        reviewer: { ...current.reviewer, ...patch.reviewer },
        editor: patch.editor
          ? { ...DEFAULT_EDITOR, ...current.editor, ...patch.editor }
          : current.editor ?? { ...DEFAULT_EDITOR },
        notifications: patch.notifications
          ? { enabled: patch.notifications.enabled ?? current.notifications?.enabled ?? DEFAULT_NOTIFICATIONS.enabled }
          : current.notifications ?? { ...DEFAULT_NOTIFICATIONS },
        explorer: patch.explorer
          ? { hideHidden: patch.explorer.hideHidden ?? current.explorer?.hideHidden ?? DEFAULT_EXPLORER.hideHidden }
          : current.explorer ?? { ...DEFAULT_EXPLORER },
      };
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
      await rename(tmp, this.file);
      return next;
    });
    this.setQueue = run.catch(() => undefined);
    return run;
  }
}
