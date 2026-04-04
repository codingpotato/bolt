import { join } from 'node:path';
import type { Tool, ToolContext } from './tool';
import type { SuggestionStore } from '../suggestions/suggestion-store';

export interface AgentSuggestInput {
  target: 'AGENT.md';
  content: string;
  reason: string;
}

export interface AgentSuggestResult {
  suggestionId: string;
  path: string;
}

export function createAgentSuggestTool(
  store: SuggestionStore,
  suggestionsDir: string,
): Tool<AgentSuggestInput, AgentSuggestResult> {
  return {
    name: 'agent_suggest',
    description:
      'Propose an improvement to AGENT.md without applying it directly. ' +
      'The proposal is written to .bolt/suggestions/ for human review. ' +
      'Use this when you have observed a consistent pattern that belongs in the permanent rulebook.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          enum: ['AGENT.md'],
          description: 'The file to propose editing (only AGENT.md is supported).',
        },
        content: {
          type: 'string',
          description: 'The content to append to .bolt/AGENT.md if the suggestion is applied.',
        },
        reason: {
          type: 'string',
          description: 'Why this change is warranted — shown to the human reviewer.',
        },
      },
      required: ['target', 'content', 'reason'],
    },

    async execute(input: AgentSuggestInput, ctx: ToolContext): Promise<AgentSuggestResult> {
      const entry: Parameters<SuggestionStore['write']>[0] = {
        target: input.target,
        content: input.content,
        reason: input.reason,
        sessionId: ctx.sessionId ?? '',
        status: 'pending',
      };

      if (ctx.activeTaskId !== undefined) {
        entry.taskId = ctx.activeTaskId;
      }

      const suggestionId = await store.write(entry);
      return { suggestionId, path: join(suggestionsDir, `${suggestionId}.json`) };
    },
  };
}
