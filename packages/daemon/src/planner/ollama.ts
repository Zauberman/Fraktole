import type { PlannerConfig } from '@fraktole/core';
import { chatCompletion, type Planner } from './index.js';
import { PLANNER_SYSTEM_PROMPT } from './parse.js';

export function ollamaPlanner(cfg: PlannerConfig): Planner {
  return {
    name: 'ollama',
    async planTask(goal, ctx) {
      return chatCompletion(
        'ollama',
        'http://localhost:11434/api/chat',
        {},
        {
          model: cfg.model,
          stream: false,
          messages: [
            { role: 'system', content: PLANNER_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify({ goal, context: ctx }) },
          ],
        },
        (body) => {
          const b = body as { message?: { content?: string } };
          return b.message?.content ?? '';
        },
      );
    },
  };
}
