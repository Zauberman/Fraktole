import type { PlannerConfig } from '@fraktole/core';
import { apiKeyFromEnv, chatCompletion, type Planner } from './index.js';
import { PLANNER_SYSTEM_PROMPT } from './parse.js';

export function openaiPlanner(cfg: PlannerConfig): Planner {
  return {
    name: 'openai',
    async planTask(goal, ctx) {
      const apiKey = apiKeyFromEnv(cfg.apiKeyEnv, 'openai');
      return chatCompletion(
        'openai',
        'https://api.openai.com/v1/chat/completions',
        { authorization: `Bearer ${apiKey}` },
        {
          model: cfg.model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: PLANNER_SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify({ goal, context: ctx }) },
          ],
        },
        (body) => {
          const b = body as { choices?: Array<{ message?: { content?: string } }> };
          return b.choices?.[0]?.message?.content ?? '';
        },
      );
    },
  };
}
