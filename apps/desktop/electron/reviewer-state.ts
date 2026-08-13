import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ReviewerState } from '../src/shared/ipc.js';

/** The reviewer's goal/task ledger: pure load/persist helpers over
 *  sessionDir/reviewer/state.json. Corrupt or missing files start fresh —
 *  same policy as the conversation loader. */

export const GOAL_MET_SENTINEL = 'GOAL-MET:';

export function emptyState(): ReviewerState {
  return { goal: null, tasks: [], lastAgentKind: null };
}

export async function loadState(file: string): Promise<ReviewerState> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReviewerState>;
    if (typeof parsed !== 'object' || parsed === null) return emptyState();
    const goal = parsed.goal;
    if (
      goal !== null &&
      goal !== undefined &&
      (typeof goal.text !== 'string' || (goal.state !== 'active' && goal.state !== 'met'))
    ) {
      return emptyState();
    }
    return {
      goal: (goal as ReviewerState['goal']) ?? null,
      tasks: Array.isArray(parsed.tasks) ? (parsed.tasks as ReviewerState['tasks']) : [],
      lastAgentKind: typeof parsed.lastAgentKind === 'string' ? parsed.lastAgentKind : null,
    };
  } catch {
    return emptyState();
  }
}

/** Writes the full state file. Errors go to the optional logger — the model
 *  loop must never throw because the ledger file could not be written. */
export async function persistState(file: string, state: ReviewerState, logger?: (line: string) => void): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (err) {
    logger?.(`reviewer: state persist failed (${(err as Error).message})`);
  }
}

export function isGoalMet(text: string): boolean {
  return text.trim().startsWith(GOAL_MET_SENTINEL);
}
