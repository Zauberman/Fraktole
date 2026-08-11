import type { PlannerConfig } from '@fraktole/core';
import { apiKeyFromEnv, chatCompletion, type Planner } from './index.js';

export function anthropicPlanner(cfg: PlannerConfig): Planner {
  return {
    name: 'anthropic',
    async planTask(goal, ctx) {
      const apiKey = apiKeyFromEnv(cfg.apiKeyEnv, 'anthropic');
      return chatCompletion(
        'anthropic',
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        {
          model: cfg.model,
          max_tokens: 4096,
          system: PLANNER_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: JSON.stringify({ goal, context: ctx }) }],
        },
        (body) => {
          const b = body as { content?: Array<{ text?: string }> };
          return b.content?.[0]?.text ?? '';
        },
      );
    },
  };
}

import { PLANNER_SYSTEM_PROMPT } from './parse.js';
