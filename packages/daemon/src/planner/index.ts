import type { PlannerConfig, TaskPlan } from '@fraktole/core';
import { PlanRejectedError } from '../task-engine.js';
import { anthropicPlanner } from './anthropic.js';
import { ollamaPlanner } from './ollama.js';
import { openaiPlanner } from './openai.js';
import { parsePlan } from './parse.js';

export { PlanRejectedError, PlanParseError } from '../task-engine.js';

export interface PlanContext {
  repoPath: string;
  defaultBranch: string;
  cwd: string;
}

export interface Planner {
  readonly name: string;
  planTask(goal: string, ctx: PlanContext): Promise<TaskPlan>;
}

export function createPlanner(cfg: PlannerConfig): Planner {
  switch (cfg.provider) {
    case 'anthropic':
      return anthropicPlanner(cfg);
    case 'openai':
      return openaiPlanner(cfg);
    case 'ollama':
      return ollamaPlanner(cfg);
    default:
      throw new Error(`unknown planner provider: ${String(cfg.provider)}`);
  }
}

export function apiKeyFromEnv(envName: string | undefined, provider: string): string {
  const name = envName ?? (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  const key = process.env[name];
  if (!key) {
    throw new PlanRejectedError(`missing API key: set ${name} or planner.apiKeyEnv`);
  }
  return key;
}

async function providerRequest(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  provider: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new PlanRejectedError(`${provider} request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new PlanRejectedError(`${provider} API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return JSON.stringify(await res.json());
}

export async function chatCompletion(
  provider: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  extract: (body: unknown) => string,
): Promise<TaskPlan> {
  const raw = await providerRequest(url, headers, body, provider);
  return parsePlan(extract(JSON.parse(raw)));
}
