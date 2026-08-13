import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, isGoalMet, loadState, persistState } from '../electron/reviewer-state.js';

describe('reviewer state', () => {
  it('emptyState has no goal and no tasks', () => {
    expect(emptyState()).toEqual({ goal: null, tasks: [], lastAgentKind: null, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 } });
  });

  it('persist + load roundtrips a full state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-state-'));
    const file = join(dir, 'state.json');
    const state = {
      goal: { text: 'ship it', setAt: 123, state: 'met' as const },
      tasks: [{ id: 't-1', agentId: 'agent-1', title: 'build', status: 'done' as const, updatedAt: 456 }],
      lastAgentKind: 'opencode',
      usage: { inputTokens: 10, cachedTokens: 2, outputTokens: 3 },
    };
    await persistState(file, state);
    expect(await loadState(file)).toEqual(state);
  });

  it('a missing file loads as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-state-'));
    expect(await loadState(join(dir, 'nope.json'))).toEqual({ goal: null, tasks: [], lastAgentKind: null, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 } });
  });

  it('a corrupt file loads as empty, never throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-state-'));
    const file = join(dir, 'state.json');
    await writeFile(file, '{not json!!', 'utf8');
    expect(await loadState(file)).toEqual({ goal: null, tasks: [], lastAgentKind: null, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 } });
  });

  it('a malformed goal (bad state value) loads as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-state-'));
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ goal: { text: 'x', setAt: 1, state: 'weird' }, tasks: [] }), 'utf8');
    expect(await loadState(file)).toEqual({ goal: null, tasks: [], lastAgentKind: null, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 } });
  });

  it('loadState keeps a persisted lastAgentKind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-state-'));
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ goal: null, tasks: [], lastAgentKind: 'opencode' }), 'utf8');
    expect((await loadState(file)).lastAgentKind).toBe('opencode');
  });

  it('isGoalMet matches only the sentinel prefix', () => {
    expect(isGoalMet('GOAL-MET: all green')).toBe(true);
    expect(isGoalMet('  GOAL-MET: done  ')).toBe(true);
    expect(isGoalMet('GOAL-MET done without colon')).toBe(false);
    expect(isGoalMet('not met yet')).toBe(false);
    expect(isGoalMet('')).toBe(false);
  });
});
