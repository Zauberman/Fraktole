import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TaskPlan } from '@fraktole/core';
import { createPlanner } from '../src/planner/index.js';
import { parsePlan } from '../src/planner/parse.js';
import { PlanParseError } from '../src/task-engine.js';

const fetchMock = vi.hoisted(() => vi.fn());

vi.stubGlobal('fetch', fetchMock);

const CTX = { repoPath: '/repo', defaultBranch: 'main', cwd: '/repo' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  fetchMock.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

describe('parsePlan', () => {
  it('parses a valid plan', () => {
    const plan = parsePlan(
      '{"rationale":"split work","tasks":[{"title":"docs","repo":"/r","baseBranch":"main","driver":"opencode","goal":"write docs","needsGate":false}]}',
    );
    expect(plan.tasks[0]!.goal).toBe('write docs');
    expect(plan.rationale).toBe('split work');
  });

  it('parses JSON embedded in markdown fences', () => {
    const plan = parsePlan('```json\n{"rationale":"r","tasks":[]}\n```');
    expect(plan.tasks).toEqual([]);
  });

  it('rejects malformed and invalid shapes with PlanParseError', () => {
    expect(() => parsePlan('not json at all')).toThrow(PlanParseError);
    expect(() => parsePlan('{"rationale":42,"tasks":[]}')).toThrow(PlanParseError);
    expect(() =>
      parsePlan('{"rationale":"r","tasks":[{"title":"x"}]}'),
    ).toThrow(/plan\.tasks\[0\]\.repo/);
  });
});

describe('createPlanner adapters', () => {
  it('anthropic: extracts the plan from a messages response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        content: [{ text: '{"rationale":"r","tasks":[]}' }],
      }),
    );
    process.env.ANTHROPIC_API_KEY = 'k';
    const planner = createPlanner({ provider: 'anthropic', model: 'm', apiKeyEnv: 'ANTHROPIC_API_KEY' });
    const plan = await planner.planTask('goal', CTX);
    expect(plan.rationale).toBe('r');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('api.anthropic.com/v1/messages');
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'k' });
  });

  it('openai: extracts the plan from a chat completion response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        choices: [{ message: { content: '{"rationale":"r","tasks":[]}' } }],
      }),
    );
    process.env.OPENAI_API_KEY = 'k';
    const planner = createPlanner({ provider: 'openai', model: 'm', apiKeyEnv: 'OPENAI_API_KEY' });
    await expect(planner.planTask('goal', CTX)).resolves.toMatchObject({ rationale: 'r' });
  });

  it('ollama: extracts the plan from a chat response', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        message: { content: '{"rationale":"r","tasks":[]}' },
      }),
    );
    const planner = createPlanner({ provider: 'ollama', model: 'gemma3' });
    const plan: TaskPlan = await planner.planTask('goal', CTX);
    expect(plan.rationale).toBe('r');
  });

  it('rejects on provider errors and on malformed model output', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));
    process.env.ANTHROPIC_API_KEY = 'k';
    const planner = createPlanner({ provider: 'anthropic', model: 'm', apiKeyEnv: 'ANTHROPIC_API_KEY' });
    await expect(planner.planTask('goal', CTX)).rejects.toThrow(/anthropic API error 500/);

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: [{ text: 'oops no json' }] }));
    await expect(planner.planTask('goal', CTX)).rejects.toBeInstanceOf(PlanParseError);
  });

  it('rejects when the API key is missing', async () => {
    const planner = createPlanner({ provider: 'anthropic', model: 'm', apiKeyEnv: 'ANTHROPIC_API_KEY' });
    await expect(planner.planTask('goal', CTX)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
