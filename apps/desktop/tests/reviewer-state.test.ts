import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, isGoalMet, loadState, persistState } from '../electron/reviewer-state.js';

describe('reviewer state', () => {
  it('emptyState has no goal and no tasks', () => {
    expect(emptyState()).toEqual({ goal: null, tasks: [] });
  });

  it('persist + load roundtrips a full state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-state-'));
    const file = join(dir, 'state.json');
    const state = {
      goal: { text: 'ship it', setAt: 123, state: 'met' as const },
      tasks: [{ id: 't-1', agentId: 'agent-1', title: 'build', status: 'done' as const, updatedAt: 456 }],
    };
    await persistState(file, state);
    expect(await loadState(file)).toEqual(state);
  });

  it('a missing file loads as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-state-'));
    expect(await loadState(join(dir, 'nope.json'))).toEqual({ goal: null, tasks: [] });
  });

  it('a corrupt file loads as empty, never throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-state-'));
    const file = join(dir, 'state.json');
    await writeFile(file, '{not json!!', 'utf8');
    expect(await loadState(file)).toEqual({ goal: null, tasks: [] });
  });

  it('a malformed goal (bad state value) loads as empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fraktole-state-'));
    const file = join(dir, 'state.json');
    await writeFile(file, JSON.stringify({ goal: { text: 'x', setAt: 1, state: 'weird' }, tasks: [] }), 'utf8');
    expect(await loadState(file)).toEqual({ goal: null, tasks: [] });
  });

  it('isGoalMet matches only the sentinel prefix', () => {
    expect(isGoalMet('GOAL-MET: all green')).toBe(true);
    expect(isGoalMet('  GOAL-MET: done  ')).toBe(true);
    expect(isGoalMet('GOAL-MET done without colon')).toBe(false);
    expect(isGoalMet('not met yet')).toBe(false);
    expect(isGoalMet('')).toBe(false);
  });
});
