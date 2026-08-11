import type { TaskPlan } from '@fraktole/core';
import { PlanParseError } from '../task-engine.js';

export const PLANNER_SYSTEM_PROMPT = `You are the planning module of a coding agent orchestrator.
Decompose the user's goal into parallelizable coding-agent subtasks.
Respond with STRICT JSON only - no markdown fences, no commentary:
{"rationale": "...", "tasks": [{"title": "...", "repo": "<repo>", "baseBranch": "<branch>", "driver": "opencode", "goal": "<self-contained agent instructions>", "needsGate": false, "gateReason": ""}]}
Rules:
- 1 to 8 tasks; each task goal must be fully self-contained instructions for a coding agent.
- repo and baseBranch must be taken from the provided context.
- driver must be "opencode" or "claude".
- needsGate must be true when the subtask could damage data or requires human judgement (destructive operations, merging, secrets, external effects); provide a gateReason in that case.`;

export function parsePlan(text: string): TaskPlan {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new PlanParseError('planner response contained no JSON object');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    throw new PlanParseError(`planner returned malformed JSON: ${(err as Error).message}`);
  }
  return validatePlan(raw);
}

export function validatePlan(raw: unknown): TaskPlan {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PlanParseError('planner response root must be an object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.rationale !== 'string') {
    throw new PlanParseError('plan.rationale must be a string');
  }
  if (!Array.isArray(obj.tasks)) {
    throw new PlanParseError('plan.tasks must be an array');
  }
  const tasks = obj.tasks.map((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new PlanParseError(`plan.tasks[${i}] must be an object`);
    }
    const t = item as Record<string, unknown>;
    for (const field of ['title', 'repo', 'baseBranch', 'driver', 'goal'] as const) {
      if (typeof t[field] !== 'string' || (t[field] as string).trim() === '') {
        throw new PlanParseError(`plan.tasks[${i}].${field} must be a non-empty string`);
      }
    }
    if (t.needsGate !== undefined && typeof t.needsGate !== 'boolean') {
      throw new PlanParseError(`plan.tasks[${i}].needsGate must be a boolean`);
    }
    if (t.gateReason !== undefined && typeof t.gateReason !== 'string') {
      throw new PlanParseError(`plan.tasks[${i}].gateReason must be a string`);
    }
    return {
      title: t.title as string,
      repo: t.repo as string,
      baseBranch: t.baseBranch as string,
      driver: t.driver as string,
      goal: t.goal as string,
      needsGate: (t.needsGate as boolean | undefined) ?? false,
      gateReason: t.gateReason as string | undefined,
    };
  });
  return { tasks, rationale: obj.rationale };
}
