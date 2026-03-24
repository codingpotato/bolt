import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTaskTools } from './task-tools';
import type { ToolContext } from '../tools/tool';
import type { Task, TaskStatus } from './task-store';

// Minimal TaskStore interface used by the tools
interface MockTaskStore {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

function makeStore(overrides: Partial<MockTaskStore> = {}): MockTaskStore {
  return {
    create: vi.fn().mockResolvedValue('task-1'),
    update: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'test task',
    description: 'test description',
    status: 'pending',
    dependsOn: [],
    subtaskIds: [],
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('task tools', () => {
  let store: MockTaskStore;
  let tools: ReturnType<typeof createTaskTools>;
  let ctx: ToolContext;

  beforeEach(() => {
    store = makeStore();
    tools = createTaskTools(store as never);
    ctx = makeCtx();
  });

  function getTool(name: string) {
    const t = tools.find((tool) => tool.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return t;
  }

  // ── task_create ──────────────────────────────────────────────────────────────

  describe('task_create', () => {
    it('returns the id from store.create', async () => {
      store.create.mockResolvedValue('task-42');
      const result = (await getTool('task_create').execute(
        { title: 'my task', description: 'details' },
        ctx,
      )) as { id: string };
      expect(result.id).toBe('task-42');
    });

    it('passes title and description to store.create', async () => {
      await getTool('task_create').execute({ title: 'T', description: 'D' }, ctx);
      expect(store.create).toHaveBeenCalledWith('T', 'D', undefined);
    });

    it('passes dependsOn to store.create when provided', async () => {
      await getTool('task_create').execute({ title: 'T', description: 'D', dependsOn: ['task-1'] }, ctx);
      expect(store.create).toHaveBeenCalledWith('T', 'D', ['task-1']);
    });

    it('is not marked sequential', () => {
      expect(getTool('task_create').sequential).toBeFalsy();
    });

    it('throws ToolError when store.create rejects', async () => {
      store.create.mockRejectedValue(new Error('dependency not found: bad-id'));
      await expect(
        getTool('task_create').execute({ title: 'T', description: 'D', dependsOn: ['bad-id'] }, ctx),
      ).rejects.toThrow('dependency not found: bad-id');
    });
  });

  // ── task_update ──────────────────────────────────────────────────────────────

  describe('task_update', () => {
    it('passes id and status to store.update', async () => {
      await getTool('task_update').execute({ id: 'task-1', status: 'in_progress' }, ctx);
      expect(store.update).toHaveBeenCalledWith('task-1', { status: 'in_progress' });
    });

    it('passes result when provided', async () => {
      await getTool('task_update').execute(
        { id: 'task-1', status: 'completed', result: 'done' },
        ctx,
      );
      expect(store.update).toHaveBeenCalledWith('task-1', { status: 'completed', result: 'done' });
    });

    it('passes error when provided', async () => {
      await getTool('task_update').execute(
        { id: 'task-1', status: 'failed', error: 'oops' },
        ctx,
      );
      expect(store.update).toHaveBeenCalledWith('task-1', { status: 'failed', error: 'oops' });
    });

    it('returns the task id', async () => {
      const result = (await getTool('task_update').execute(
        { id: 'task-1', status: 'in_progress' },
        ctx,
      )) as { id: string };
      expect(result.id).toBe('task-1');
    });

    it('throws ToolError when store.update rejects', async () => {
      store.update.mockRejectedValue(new Error('task not found: bad-id'));
      await expect(
        getTool('task_update').execute({ id: 'bad-id', status: 'completed' }, ctx),
      ).rejects.toThrow('task not found');
    });

    it('is marked sequential', () => {
      expect(getTool('task_update').sequential).toBe(true);
    });

    it('sets ctx.activeTaskId when transitioning to in_progress', async () => {
      await getTool('task_update').execute({ id: 'task-1', status: 'in_progress' }, ctx);
      expect(ctx.activeTaskId).toBe('task-1');
    });

    it('clears ctx.activeTaskId when the active task leaves in_progress', async () => {
      ctx.activeTaskId = 'task-1';
      await getTool('task_update').execute({ id: 'task-1', status: 'completed' }, ctx);
      expect(ctx.activeTaskId).toBeUndefined();
    });

    it('does not clear ctx.activeTaskId when a different task changes status', async () => {
      ctx.activeTaskId = 'task-1';
      await getTool('task_update').execute({ id: 'task-2', status: 'completed' }, ctx);
      expect(ctx.activeTaskId).toBe('task-1');
    });
  });

  // ── task_list ────────────────────────────────────────────────────────────────

  describe('task_list', () => {
    it('returns empty tasks array when store is empty', async () => {
      const result = (await getTool('task_list').execute({}, ctx)) as { tasks: Task[] };
      expect(result.tasks).toEqual([]);
    });

    it('returns all tasks from the store', async () => {
      const tasks = [makeTask({ id: 'task-1' }), makeTask({ id: 'task-2', title: 'second' })];
      store.list.mockReturnValue(tasks);

      const result = (await getTool('task_list').execute({}, ctx)) as { tasks: Task[] };
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0]?.id).toBe('task-1');
      expect(result.tasks[1]?.id).toBe('task-2');
    });

    it('returns tasks with all required fields', async () => {
      store.list.mockReturnValue([makeTask()]);
      const result = (await getTool('task_list').execute({}, ctx)) as { tasks: Task[] };
      const task = result.tasks[0];
      expect(task).toMatchObject({
        id: expect.any(String),
        title: expect.any(String),
        description: expect.any(String),
        status: expect.any(String),
        subtaskIds: expect.any(Array),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('reflects updated status after task_update', async () => {
      const task = makeTask({ status: 'pending' });
      store.list.mockReturnValue([{ ...task, status: 'in_progress' as TaskStatus }]);

      const result = (await getTool('task_list').execute({}, ctx)) as { tasks: Task[] };
      expect(result.tasks[0]?.status).toBe('in_progress');
    });

    it('includes dependsOn field in returned tasks', async () => {
      store.list.mockReturnValue([makeTask({ dependsOn: ['task-0'] })]);
      const result = (await getTool('task_list').execute({}, ctx)) as { tasks: Task[] };
      expect(result.tasks[0]?.dependsOn).toEqual(['task-0']);
    });

    it('shows waiting status when task has unmet deps', async () => {
      store.list.mockReturnValue([makeTask({ status: 'waiting', dependsOn: ['task-0'] })]);
      const result = (await getTool('task_list').execute({}, ctx)) as { tasks: Task[] };
      expect(result.tasks[0]?.status).toBe('waiting');
    });
  });
});
