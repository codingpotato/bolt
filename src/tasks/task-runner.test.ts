import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskRunner } from './task-runner';
import type { Task, TaskStatus } from './task-store';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'test task',
    description: 'do something',
    status: 'pending',
    subtaskIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface MockStore {
  list: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function makeStore(tasks: Task[]): MockStore {
  // list() returns the current snapshot; tests can replace tasks in the array
  // to simulate state changes between calls.
  const state = [...tasks];
  return {
    list: vi.fn(() => [...state]),
    update: vi.fn(async (id: string, changes: { status: TaskStatus; result?: string; error?: string }) => {
      const task = state.find((t) => t.id === id);
      if (!task) throw new Error(`task not found: ${id}`);
      task.status = changes.status;
      if (changes.result !== undefined) task.result = changes.result;
      if (changes.error !== undefined) task.error = changes.error;
    }),
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('TaskRunner', () => {
  let executor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    executor = vi.fn().mockResolvedValue('result');
  });

  // ── pick next pending ────────────────────────────────────────────────────────

  describe('picking the next task', () => {
    it('marks the first pending task as in_progress before executing', async () => {
      const task = makeTask();
      const store = makeStore([task]);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(store.update).toHaveBeenCalledWith(task.id, { status: 'in_progress' });
    });

    it('passes the task to the executor', async () => {
      const task = makeTask({ title: 'my task' });
      const store = makeStore([task]);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(executor).toHaveBeenCalledWith(expect.objectContaining({ id: task.id, title: 'my task' }));
    });

    it('does nothing when there are no tasks', async () => {
      const store = makeStore([]);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(executor).not.toHaveBeenCalled();
      expect(store.update).not.toHaveBeenCalled();
    });
  });

  // ── success path ─────────────────────────────────────────────────────────────

  describe('on success', () => {
    it('marks the task completed with the executor result', async () => {
      executor.mockResolvedValue('task output');
      const task = makeTask();
      const store = makeStore([task]);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(store.update).toHaveBeenCalledWith(task.id, {
        status: 'completed',
        result: 'task output',
      });
    });
  });

  // ── failure path ─────────────────────────────────────────────────────────────

  describe('on failure', () => {
    it('marks the task failed with the error message', async () => {
      executor.mockRejectedValue(new Error('something went wrong'));
      const task = makeTask();
      const store = makeStore([task]);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(store.update).toHaveBeenCalledWith(task.id, {
        status: 'failed',
        error: 'something went wrong',
      });
    });

    it('uses String(err) for non-Error rejections', async () => {
      executor.mockRejectedValue('plain string error');
      const task = makeTask();
      const store = makeStore([task]);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(store.update).toHaveBeenCalledWith(task.id, {
        status: 'failed',
        error: 'plain string error',
      });
    });
  });

  // ── blocked tasks ─────────────────────────────────────────────────────────────

  describe('blocked tasks', () => {
    it('skips blocked tasks — does not mark them in_progress or execute them', async () => {
      const blocked = makeTask({ id: 'task-1', status: 'blocked' });
      const store = makeStore([blocked]);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(executor).not.toHaveBeenCalled();
      expect(store.update).not.toHaveBeenCalled();
    });

    it('executes a pending task even when a blocked task is also present', async () => {
      const blocked = makeTask({ id: 'task-1', status: 'blocked' });
      const pending = makeTask({ id: 'task-2', status: 'pending' });
      const store = makeStore([blocked, pending]);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(executor).toHaveBeenCalledTimes(1);
      expect(executor).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-2' }));
    });
  });

  // ── multi-task loop ───────────────────────────────────────────────────────────

  describe('execution loop', () => {
    it('processes all pending tasks in order', async () => {
      const tasks = [
        makeTask({ id: 'task-1', status: 'pending' }),
        makeTask({ id: 'task-2', status: 'pending' }),
        makeTask({ id: 'task-3', status: 'pending' }),
      ];
      const store = makeStore(tasks);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(executor).toHaveBeenCalledTimes(3);
      const calls = executor.mock.calls.map((c) => (c[0] as Task).id);
      expect(calls).toEqual(['task-1', 'task-2', 'task-3']);
    });

    it('continues after a failed task and processes remaining pending tasks', async () => {
      executor
        .mockRejectedValueOnce(new Error('task 1 failed'))
        .mockResolvedValueOnce('task 2 done');
      const tasks = [
        makeTask({ id: 'task-1', status: 'pending' }),
        makeTask({ id: 'task-2', status: 'pending' }),
      ];
      const store = makeStore(tasks);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(executor).toHaveBeenCalledTimes(2);
      expect(store.update).toHaveBeenCalledWith('task-1', {
        status: 'failed',
        error: 'task 1 failed',
      });
      expect(store.update).toHaveBeenCalledWith('task-2', {
        status: 'completed',
        result: 'task 2 done',
      });
    });

    it('stops when only blocked tasks remain', async () => {
      const tasks = [makeTask({ id: 'task-1', status: 'blocked' })];
      const store = makeStore(tasks);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(executor).not.toHaveBeenCalled();
    });

    it('stops when all tasks are already completed or failed', async () => {
      const tasks = [
        makeTask({ id: 'task-1', status: 'completed' }),
        makeTask({ id: 'task-2', status: 'failed' }),
      ];
      const store = makeStore(tasks);
      const runner = new TaskRunner(store as never, executor);

      await runner.run();

      expect(executor).not.toHaveBeenCalled();
      expect(store.update).not.toHaveBeenCalled();
    });
  });
});
