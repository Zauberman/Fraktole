import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ReviewerState, ReviewerTask } from '../src/shared/ipc.js';

/** The reviewer's goal/task ledger: pure load/persist helpers over
 *  sessionDir/reviewer/state.json. Corrupt or missing files start fresh —
 *  same policy as the conversation loader. */

export const GOAL_MET_SENTINEL = 'GOAL-MET:';

export function emptyState(): ReviewerState {
  return { goal: null, subGoals: [], tasks: [], lastAgentKind: null, variant: null, usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0 }, recap: null };
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
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyState();
    const goal = parsed.goal;
    if (
      goal !== null &&
      goal !== undefined &&
      (typeof goal.text !== 'string' ||
        (goal.state !== 'active' && goal.state !== 'met') ||
        typeof goal.setAt !== 'number' ||
        !Number.isFinite(goal.setAt))
    ) {
      return emptyState();
    }
    return {
      goal: (goal as ReviewerState['goal']) ?? null,
      subGoals: Array.isArray(parsed.subGoals) ? parsed.subGoals.filter(isValidSubGoal) : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(isValidTask) : [],
      lastAgentKind: typeof parsed.lastAgentKind === 'string' ? parsed.lastAgentKind : null,
      variant:
        parsed.variant === 'cyber' ||
        parsed.variant === 'frontend' ||
        parsed.variant === 'bugs' ||
        parsed.variant === 'feature' ||
        parsed.variant === 'tests' ||
        parsed.variant === 'readability' ||
        parsed.variant === 'custom'
          ? parsed.variant
          : null,
      usage: {
        inputTokens: typeof parsed.usage?.inputTokens === 'number' ? parsed.usage.inputTokens : 0,
        cachedTokens: typeof parsed.usage?.cachedTokens === 'number' ? parsed.usage.cachedTokens : 0,
        outputTokens: typeof parsed.usage?.outputTokens === 'number' ? parsed.usage.outputTokens : 0,
      },
      recap: isValidRecap(parsed.recap) ? parsed.recap : null,
    };
  } catch {
    return emptyState();
  }
}

/** A recap row is trusted only when it has both a text and a finite time. */
function isValidRecap(r: unknown): r is NonNullable<ReviewerState['recap']> {
  if (typeof r !== 'object' || r === null) return false;
  const recap = r as Partial<NonNullable<ReviewerState['recap']>>;
  return typeof recap.text === 'string' && recap.text.length > 0 && typeof recap.at === 'number' && Number.isFinite(recap.at);
}

/** A sub-goal row is trusted only when every field has the right shape. */
function isValidSubGoal(s: unknown): s is ReviewerState['subGoals'][number] {
  if (typeof s !== 'object' || s === null) return false;
  const sub = s as Partial<ReviewerState['subGoals'][number]>;
  return (
    typeof sub.id === 'string' &&
    typeof sub.text === 'string' &&
    (sub.state === 'pending' || sub.state === 'done')
  );
}

/** One ledger row is only trusted when every field has the right shape —
 *  junk rows (bad status, NaN timestamps) must not flow into the UI or the
 *  state block. */
function isValidTask(t: unknown): t is ReviewerTask {
  if (typeof t !== 'object' || t === null) return false;
  const task = t as Partial<ReviewerTask>;
  return (
    typeof task.id === 'string' &&
    typeof task.title === 'string' &&
    (task.status === 'pending' || task.status === 'active' || task.status === 'done' || task.status === 'failed') &&
    (task.agentId === null || typeof task.agentId === 'string') &&
    typeof task.updatedAt === 'number' &&
    Number.isFinite(task.updatedAt)
  );
}

let stateWriteSeq = 0;

/** Writes the full state file atomically (unique tmp + rename): the loop may
 *  persist from several call sites in flight (ledger upserts, turn end,
 *  error catch), and a non-atomic writeFile can leave a truncated/empty file
 *  for a concurrent reader (or the next reload). Errors go to the optional
 *  logger — the model loop must never throw because the ledger file could
 *  not be written. */
export async function persistState(file: string, state: ReviewerState, logger?: (line: string) => void): Promise<void> {
  let tmp = '';
  try {
    await mkdir(dirname(file), { recursive: true });
    tmp = `${file}.${process.pid}.${++stateWriteSeq}.tmp`;
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    // the rename may never have landed (target still missing) — fall back to
    // a direct write so the ledger is never empty on the next reload
    const exists = await readFile(file)
      .then(() => true)
      .catch(() => false);
    if (!exists) await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8').catch(() => undefined);
    logger?.(`reviewer: state persist failed (${(err as Error).message})`);
  }
}

export function isGoalMet(text: string): boolean {
  return text.trim().startsWith(GOAL_MET_SENTINEL);
}
