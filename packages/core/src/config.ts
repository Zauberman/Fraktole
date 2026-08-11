import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface RepoConfig {
  path: string;
  defaultBranch: string;
  allowPush: boolean;
}

export interface PlannerConfig {
  provider: 'anthropic' | 'openai' | 'ollama';
  model: string;
  apiKeyEnv?: string;
  /** decompose goals into parallel subtasks (false = always run directly) */
  decompose?: boolean;
}

export interface PluginConfig {
  id: string;
  command: string;
  args: string[];
}

export interface AgentCliConfig {
  enabled: boolean;
  model?: string;
}

export interface AgentsConfig {
  opencode?: AgentCliConfig;
  claude?: AgentCliConfig;
  plugins: PluginConfig[];
}

export interface GatesConfig {
  mergeToMain: boolean;
  destructiveCommands: boolean;
  externalNetwork: boolean;
  heavyActions: boolean;
}

export interface TlsConfig {
  cert: string;
  key: string;
}

export interface ServerConfig {
  host: string;
  port: number;
  tls?: TlsConfig;
  tokens: string[];
}

export interface LimitsConfig {
  maxConcurrent: number;
  defaultTimeoutMs: number;
  gateTimeoutMs: number;
}

export interface FraktoleConfig {
  dataDir: string;
  repos: RepoConfig[];
  planner: PlannerConfig;
  agents: AgentsConfig;
  gates: GatesConfig;
  server: ServerConfig;
  limits: LimitsConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Config error: ${message}`);
    this.name = 'ConfigError';
  }
}

const PLANNER_PROVIDERS = ['anthropic', 'openai', 'ollama'] as const;
export type PlannerProvider = (typeof PLANNER_PROVIDERS)[number];

export function defaultConfigPath(): string {
  return process.env.FRAKTOLE_CONFIG ?? join(homedir(), '.config', 'fraktole', 'config.json');
}

export function defaults(): FraktoleConfig {
  return {
    dataDir: join(homedir(), '.local', 'share', 'fraktole'),
    repos: [],
    planner: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      decompose: true,
    },
    agents: {
      opencode: { enabled: true },
      claude: { enabled: false },
      plugins: [],
    },
    gates: {
      mergeToMain: true,
      destructiveCommands: true,
      externalNetwork: false,
      heavyActions: false,
    },
    server: {
      host: '127.0.0.1',
      port: 8756,
      tokens: [],
    },
    limits: {
      maxConcurrent: 2,
      defaultTimeoutMs: 1_800_000,
      gateTimeoutMs: 600_000,
    },
  };
}

interface Ctx {
  errors: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function expectRecord(obj: unknown, path: string, ctx: Ctx): Record<string, unknown> | undefined {
  if (obj === undefined) return undefined;
  if (!isRecord(obj)) {
    ctx.errors.push(`${path} must be an object`);
    return undefined;
  }
  return obj;
}

function strField(
  obj: Record<string, unknown>,
  key: string,
  def: string,
  ctx: Ctx,
  path?: string,
  required = false,
): string {
  const v = obj[key];
  if (v === undefined) return def;
  if (typeof v !== 'string' || (required && v.trim() === '')) {
    ctx.errors.push(`${path ?? key} must be a ${required ? 'non-empty ' : ''}string`);
    return def;
  }
  return v;
}

function optStrField(
  obj: Record<string, unknown>,
  key: string,
  ctx: Ctx,
  path?: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') {
    ctx.errors.push(`${path ?? key} must be a string`);
    return undefined;
  }
  return v;
}

function boolField(
  obj: Record<string, unknown>,
  key: string,
  def: boolean,
  ctx: Ctx,
  path?: string,
): boolean {
  const v = obj[key];
  if (v === undefined) return def;
  if (typeof v !== 'boolean') {
    ctx.errors.push(`${path ?? key} must be a boolean`);
    return def;
  }
  return v;
}

function numField(
  obj: Record<string, unknown>,
  key: string,
  def: number,
  ctx: Ctx,
  path?: string,
): number {
  const v = obj[key];
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    ctx.errors.push(`${path ?? key} must be a number`);
    return def;
  }
  return v;
}

function strArrayField(
  obj: Record<string, unknown>,
  key: string,
  def: string[],
  ctx: Ctx,
  path?: string,
  required = false,
): string[] {
  const v = obj[key];
  if (v === undefined) {
    if (required) ctx.errors.push(`${path ?? key} is required`);
    return def;
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    ctx.errors.push(`${path ?? key} must be an array of strings`);
    return def;
  }
  return v as string[];
}

function mergeRepos(raw: unknown, ctx: Ctx): RepoConfig[] {
  if (raw === undefined) return defaults().repos;
  if (!Array.isArray(raw)) {
    ctx.errors.push('repos must be an array');
    return defaults().repos;
  }
  const out: RepoConfig[] = [];
  raw.forEach((item, i) => {
    const r = expectRecord(item, `repos[${i}]`, ctx);
    if (!r) return;
    out.push({
      path: strField(r, 'path', '', ctx, `repos[${i}].path`, true),
      defaultBranch: strField(r, 'defaultBranch', 'main', ctx, `repos[${i}].defaultBranch`),
      allowPush: boolField(r, 'allowPush', false, ctx, `repos[${i}].allowPush`),
    });
  });
  return out;
}

function mergeAgentCli(
  raw: unknown,
  path: string,
  def: AgentCliConfig,
  ctx: Ctx,
): AgentCliConfig | undefined {
  const r = expectRecord(raw, path, ctx);
  if (!r) return def;
  return {
    enabled: boolField(r, 'enabled', def.enabled, ctx, `${path}.enabled`),
    model: optStrField(r, 'model', ctx, `${path}.model`),
  };
}

function mergeAgents(raw: unknown, ctx: Ctx): AgentsConfig {
  const def = defaults().agents;
  const r = expectRecord(raw, 'agents', ctx);
  if (!r) return def;
  const opencode = mergeAgentCli(r.opencode, 'agents.opencode', def.opencode!, ctx);
  const claude = mergeAgentCli(r.claude, 'agents.claude', def.claude!, ctx);

  let plugins: PluginConfig[] = def.plugins;
  if (r.plugins !== undefined) {
    if (!Array.isArray(r.plugins)) {
      ctx.errors.push('agents.plugins must be an array');
    } else {
      plugins = [];
      r.plugins.forEach((item, i) => {
        const p = expectRecord(item, `agents.plugins[${i}]`, ctx);
        if (!p) return;
        plugins.push({
          id: strField(p, 'id', '', ctx, `agents.plugins[${i}].id`, true),
          command: strField(p, 'command', '', ctx, `agents.plugins[${i}].command`, true),
          args: strArrayField(p, 'args', [], ctx, `agents.plugins[${i}].args`, true),
        });
      });
    }
  }
  return { opencode, claude, plugins };
}

function mergeGates(raw: unknown, ctx: Ctx): GatesConfig {
  const def = defaults().gates;
  const r = expectRecord(raw, 'gates', ctx);
  if (!r) return def;
  return {
    mergeToMain: boolField(r, 'mergeToMain', def.mergeToMain, ctx, 'gates.mergeToMain'),
    destructiveCommands: boolField(
      r,
      'destructiveCommands',
      def.destructiveCommands,
      ctx,
      'gates.destructiveCommands',
    ),
    externalNetwork: boolField(r, 'externalNetwork', def.externalNetwork, ctx, 'gates.externalNetwork'),
    heavyActions: boolField(r, 'heavyActions', def.heavyActions, ctx, 'gates.heavyActions'),
  };
}

function mergeServer(raw: unknown, ctx: Ctx): ServerConfig {
  const def = defaults().server;
  const r = expectRecord(raw, 'server', ctx);
  if (!r) return def;
  let tls: TlsConfig | undefined;
  if (r.tls !== undefined) {
    const t = expectRecord(r.tls, 'server.tls', ctx);
    if (t) {
      tls = {
        cert: strField(t, 'cert', '', ctx, 'server.tls.cert', true),
        key: strField(t, 'key', '', ctx, 'server.tls.key', true),
      };
    }
  }
  return {
    host: strField(r, 'host', def.host, ctx, 'server.host'),
    port: numField(r, 'port', def.port, ctx, 'server.port'),
    tls,
    tokens: strArrayField(r, 'tokens', def.tokens, ctx, 'server.tokens'),
  };
}

function mergeLimits(raw: unknown, ctx: Ctx): LimitsConfig {
  const def = defaults().limits;
  const r = expectRecord(raw, 'limits', ctx);
  if (!r) return def;
  return {
    maxConcurrent: numField(r, 'maxConcurrent', def.maxConcurrent, ctx, 'limits.maxConcurrent'),
    defaultTimeoutMs: numField(r, 'defaultTimeoutMs', def.defaultTimeoutMs, ctx, 'limits.defaultTimeoutMs'),
    gateTimeoutMs: numField(r, 'gateTimeoutMs', def.gateTimeoutMs, ctx, 'limits.gateTimeoutMs'),
  };
}

/**
 * First-run helper: writes a default config (with a random auth token) when
 * the config file does not exist yet, then loads it. Never touches an existing
 * file. This is what makes `fraktole` work with zero setup.
 */
export async function ensureConfig(path: string = defaultConfigPath()): Promise<FraktoleConfig> {
  try {
    return await loadConfig(path);
  } catch (err) {
    if (!(err instanceof ConfigError) || !err.message.includes('file not found')) throw err;
    const config = defaults();
    config.server.tokens = [randomBytes(16).toString('hex')];
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(config, null, 2), 'utf8');
    return config;
  }
}

export async function loadConfig(path: string = defaultConfigPath()): Promise<FraktoleConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(`file not found: ${path}`);
    }
    if (err instanceof SyntaxError) {
      throw new ConfigError(`invalid JSON in ${path}: ${err.message}`);
    }
    throw err;
  }
  if (!isRecord(raw)) {
    throw new ConfigError(`config root must be a JSON object: ${path}`);
  }

  const ctx: Ctx = { errors: [] };
  const cfg: FraktoleConfig = {
    dataDir: strField(raw, 'dataDir', defaults().dataDir, ctx),
    repos: mergeRepos(raw.repos, ctx),
    planner: mergePlanner(raw.planner, ctx),
    agents: mergeAgents(raw.agents, ctx),
    gates: mergeGates(raw.gates, ctx),
    server: mergeServer(raw.server, ctx),
    limits: mergeLimits(raw.limits, ctx),
  };
  if (ctx.errors.length > 0) {
    throw new ConfigError(ctx.errors.join('; '));
  }
  return cfg;
}

function mergePlanner(raw: unknown, ctx: Ctx): PlannerConfig {
  const def = defaults().planner;
  const r = expectRecord(raw, 'planner', ctx);
  if (!r) return def;
  const provider = strField(r, 'provider', def.provider, ctx, 'planner.provider');
  if (!(PLANNER_PROVIDERS as readonly string[]).includes(provider)) {
    ctx.errors.push(`planner.provider must be one of ${PLANNER_PROVIDERS.join(', ')}`);
  }
  return {
    provider: (PLANNER_PROVIDERS.includes(provider as PlannerProvider)
      ? provider
      : def.provider) as PlannerProvider,
    model: strField(r, 'model', def.model, ctx, 'planner.model'),
    apiKeyEnv: optStrField(r, 'apiKeyEnv', ctx, 'planner.apiKeyEnv'),
    decompose: boolField(r, 'decompose', def.decompose!, ctx, 'planner.decompose'),
  };
}
