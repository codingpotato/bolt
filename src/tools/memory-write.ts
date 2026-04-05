import type { Tool, ToolContext } from './tool';
import type { MemoryStore } from '../memory/memory-store';

export interface MemoryWriteInput {
  content: string;
  tags?: string[];
}

export interface MemoryWriteResult {
  id: string;
}

export function createMemoryWriteTool(
  store: MemoryStore,
): Tool<MemoryWriteInput, MemoryWriteResult> {
  return {
    name: 'memory_write',
    description:
      'Explicitly write a fact, preference, or note to long-term memory (L3). ' +
      'Use this to persist cross-task knowledge that would not otherwise be captured by compaction.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The fact or note to persist.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional topic tags to aid future retrieval via memory_search.',
        },
      },
      required: ['content'],
    },

    async execute(input: MemoryWriteInput, ctx: ToolContext): Promise<MemoryWriteResult> {
      const entry: Parameters<MemoryStore['write']>[0] = {
        type: 'agent_note',
        sessionId: ctx.sessionId ?? '',
        summary: input.content,
        tags: input.tags ?? [],
      };

      if (ctx.activeTaskId !== undefined) {
        entry.taskId = ctx.activeTaskId;
      }

      const id = await store.write(entry);
      return { id };
    },
  };
}
