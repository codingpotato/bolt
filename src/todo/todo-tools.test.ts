import { describe, it, expect, beforeEach } from 'vitest';
import { createTodoTools } from './todo-tools';
import { TodoStore } from './todo-store';
import type { ToolContext } from '../tools/tool';

function makeCtx(): ToolContext {
  return {
    cwd: '/tmp',
    log: { log: () => {} } as unknown as ToolContext['log'],
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as unknown as ToolContext['logger'],
    progress: { onSessionStart: () => {}, onThinking: () => {}, onToolCall: () => {}, onToolResult: () => {}, onTaskStatusChange: () => {}, onContextInjection: () => {}, onMemoryCompaction: () => {}, onRetry: () => {} },
  };
}

describe('todo tools', () => {
  let store: TodoStore;
  let tools: ReturnType<typeof createTodoTools>;
  let ctx: ToolContext;

  beforeEach(() => {
    store = new TodoStore();
    tools = createTodoTools(store);
    ctx = makeCtx();
  });

  function getTool(name: string) {
    const t = tools.find((tool) => tool.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return t;
  }

  // ── todo_create ──────────────────────────────────────────────────────────────

  describe('todo_create', () => {
    it('returns an id', async () => {
      const result = await getTool('todo_create').execute({ title: 'my task' }, ctx);
      expect((result as { id: string }).id).toBeTruthy();
    });

    it('item appears in todo_list after creation', async () => {
      const { id } = (await getTool('todo_create').execute({ title: 'task A' }, ctx)) as {
        id: string;
      };
      const { items } = (await getTool('todo_list').execute({}, ctx)) as {
        items: Array<{ id: string; title: string; status: string }>;
      };
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id, title: 'task A', status: 'pending' });
    });

    it('is not marked sequential', () => {
      expect(getTool('todo_create').sequential).toBeFalsy();
    });
  });

  // ── todo_update ──────────────────────────────────────────────────────────────

  describe('todo_update', () => {
    it('updates the status of an existing item', async () => {
      const { id } = (await getTool('todo_create').execute({ title: 'task' }, ctx)) as {
        id: string;
      };
      await getTool('todo_update').execute({ id, status: 'in_progress' }, ctx);
      const { items } = (await getTool('todo_list').execute({}, ctx)) as {
        items: Array<{ status: string }>;
      };
      expect(items[0]?.status).toBe('in_progress');
    });

    it('updates the description', async () => {
      const { id } = (await getTool('todo_create').execute({ title: 'task' }, ctx)) as {
        id: string;
      };
      await getTool('todo_update').execute({ id, description: 'more info' }, ctx);
      const { items } = (await getTool('todo_list').execute({}, ctx)) as {
        items: Array<{ description?: string }>;
      };
      expect(items[0]?.description).toBe('more info');
    });

    it('throws ToolError when id is not found', async () => {
      await expect(
        getTool('todo_update').execute({ id: 'bad-id', status: 'done' }, ctx),
      ).rejects.toThrow('todo not found');
    });

    it('is marked sequential', () => {
      expect(getTool('todo_update').sequential).toBe(true);
    });
  });

  // ── todo_list ────────────────────────────────────────────────────────────────

  describe('todo_list', () => {
    it('returns empty items array when store is empty', async () => {
      const result = (await getTool('todo_list').execute({}, ctx)) as { items: unknown[] };
      expect(result.items).toEqual([]);
    });

    it('returns all current items with id, title, and status', async () => {
      await getTool('todo_create').execute({ title: 'alpha' }, ctx);
      await getTool('todo_create').execute({ title: 'beta' }, ctx);
      const { items } = (await getTool('todo_list').execute({}, ctx)) as {
        items: Array<{ title: string; status: string }>;
      };
      expect(items).toHaveLength(2);
      expect(items[0]?.title).toBe('alpha');
      expect(items[1]?.title).toBe('beta');
    });
  });

  // ── todo_delete ──────────────────────────────────────────────────────────────

  describe('todo_delete', () => {
    it('removes the item from the store', async () => {
      const { id } = (await getTool('todo_create').execute({ title: 'task' }, ctx)) as {
        id: string;
      };
      await getTool('todo_delete').execute({ id }, ctx);
      const { items } = (await getTool('todo_list').execute({}, ctx)) as { items: unknown[] };
      expect(items).toHaveLength(0);
    });

    it('throws ToolError when id is not found', async () => {
      await expect(getTool('todo_delete').execute({ id: 'bad-id' }, ctx)).rejects.toThrow(
        'todo not found',
      );
    });

    it('only removes the targeted item', async () => {
      await getTool('todo_create').execute({ title: 'keep' }, ctx);
      const { id } = (await getTool('todo_create').execute({ title: 'remove' }, ctx)) as {
        id: string;
      };
      await getTool('todo_create').execute({ title: 'also keep' }, ctx);
      await getTool('todo_delete').execute({ id }, ctx);
      const { items } = (await getTool('todo_list').execute({}, ctx)) as {
        items: Array<{ title: string }>;
      };
      expect(items.map((i) => i.title)).toEqual(['keep', 'also keep']);
    });
  });
});
