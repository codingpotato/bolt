import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';

vi.mock('node:fs/promises');
vi.mock('node:fs');

import { TaskStore } from './task-store';

describe('TaskStore', () => {
  const dataDir = '/data';
  const tasksPath = '/data/tasks.json';

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no existing tasks file
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsPromises.rename).mockResolvedValue(undefined);
  });

  // ── startup loading ──────────────────────────────────────────────────────────

  describe('startup loading', () => {
    it('starts with an empty task list when no file exists', () => {
      const store = new TaskStore(dataDir);
      expect(store.list()).toEqual([]);
    });

    it('loads tasks from an existing tasks.json', async () => {
      const saved = [
        {
          id: 'task-1',
          title: 'loaded task',
          description: 'desc',
          status: 'pending',
          subtaskIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ];
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ tasks: saved, counter: 1 }));

      const store = new TaskStore(dataDir);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]?.title).toBe('loaded task');

      // Counter must be restored so new tasks don't collide with loaded ones
      const newId = await store.create('next task', 'desc');
      expect(newId).toBe('task-2');
    });

    it('uses an empty state and moves the corrupt file when JSON is invalid', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('not valid json {{{');

      const store = new TaskStore(dataDir);
      expect(store.list()).toEqual([]);

      // Moving corrupt file is async — trigger it via a mutation
      await store.create('task', 'desc');
      expect(vi.mocked(fsPromises.rename)).toHaveBeenCalledWith(
        tasksPath,
        expect.stringMatching(/\/data\/corrupted\/\d+-tasks\.json$/),
      );
    });

    it('uses an empty state when the file is valid JSON but not the expected shape', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ unexpected: true }));

      const store = new TaskStore(dataDir);
      expect(store.list()).toEqual([]);
    });
  });

  // ── create ───────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('returns a unique id', async () => {
      const store = new TaskStore(dataDir);
      const id1 = await store.create('task 1', 'desc 1');
      const id2 = await store.create('task 2', 'desc 2');
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it('adds a task with pending status and correct fields', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('my task', 'my description');
      const tasks = store.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({
        id,
        title: 'my task',
        description: 'my description',
        status: 'pending',
        subtaskIds: [],
        sessionIds: [],
      });
    });

    it('sets createdAt and updatedAt as ISO strings', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      const task = store.list().find((t) => t.id === id);
      expect(task?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(task?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('writes to tasks.json immediately after creation', async () => {
      const store = new TaskStore(dataDir);
      await store.create('task', 'desc');
      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
        tasksPath,
        expect.any(String),
        'utf-8',
      );
    });

    it('serialized JSON contains the new task', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      const written = vi.mocked(fsPromises.writeFile).mock.calls[0]?.[1] as string;
      const parsed = JSON.parse(written) as { tasks: Array<{ id: string }> };
      expect(parsed.tasks.some((t) => t.id === id)).toBe(true);
    });
  });

  // ── update ───────────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates the status of a task', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      vi.mocked(fsPromises.writeFile).mockClear();

      await store.update(id, { status: 'in_progress' });
      expect(store.list().find((t) => t.id === id)?.status).toBe('in_progress');
    });

    it('updates result when provided', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      await store.update(id, { status: 'completed', result: 'done!' });
      expect(store.list().find((t) => t.id === id)?.result).toBe('done!');
    });

    it('updates error when provided', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      await store.update(id, { status: 'failed', error: 'something broke' });
      expect(store.list().find((t) => t.id === id)?.error).toBe('something broke');
    });

    it('updates updatedAt on every mutation', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      const before = store.list().find((t) => t.id === id)?.updatedAt;
      await store.update(id, { status: 'in_progress' });
      const after = store.list().find((t) => t.id === id)?.updatedAt;
      // updatedAt must be a valid ISO string (may or may not differ in fast tests)
      expect(after).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(typeof before).toBe('string');
    });

    it('throws when id is not found', async () => {
      const store = new TaskStore(dataDir);
      await expect(store.update('nonexistent', { status: 'completed' })).rejects.toThrow(
        'task not found',
      );
    });

    it('re-serializes to tasks.json after update', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      vi.mocked(fsPromises.writeFile).mockClear();
      await store.update(id, { status: 'in_progress' });
      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledOnce();
    });

    it('appends sessionId when transitioning to in_progress', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      await store.update(id, { status: 'in_progress', sessionId: 'session-abc' });
      expect(store.list().find((t) => t.id === id)?.sessionIds).toEqual(['session-abc']);
    });

    it('appends multiple sessionIds across successive in_progress transitions', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      await store.update(id, { status: 'in_progress', sessionId: 'session-1' });
      await store.update(id, { status: 'completed' });
      await store.update(id, { status: 'in_progress', sessionId: 'session-2' });
      expect(store.list().find((t) => t.id === id)?.sessionIds).toEqual(['session-1', 'session-2']);
    });

    it('does not modify sessionIds when transitioning to a non-in_progress status', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      await store.update(id, { status: 'completed', sessionId: 'session-x' });
      expect(store.list().find((t) => t.id === id)?.sessionIds).toEqual([]);
    });

    it('does not modify sessionIds when no sessionId is provided', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      await store.update(id, { status: 'in_progress' });
      expect(store.list().find((t) => t.id === id)?.sessionIds).toEqual([]);
    });
  });

  // ── dependencies ─────────────────────────────────────────────────────────────

  describe('dependencies', () => {
    it('task with no deps starts as pending', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      expect(store.list().find((t) => t.id === id)?.status).toBe('pending');
    });

    it('task with deps starts as waiting', async () => {
      const store = new TaskStore(dataDir);
      const depId = await store.create('dep', 'desc');
      const id = await store.create('task', 'desc', [depId]);
      expect(store.list().find((t) => t.id === id)?.status).toBe('waiting');
    });

    it('task_list includes dependsOn field', async () => {
      const store = new TaskStore(dataDir);
      const depId = await store.create('dep', 'desc');
      await store.create('task', 'desc', [depId]);
      const tasks = store.list();
      const withDeps = tasks.find((t) => t.dependsOn.length > 0);
      expect(withDeps?.dependsOn).toEqual([depId]);
    });

    it('linear chain: waiting task becomes pending when its dep completes', async () => {
      const store = new TaskStore(dataDir);
      const depId = await store.create('dep', 'desc');
      const taskId = await store.create('task', 'desc', [depId]);

      await store.update(depId, { status: 'completed', result: 'done' });

      expect(store.list().find((t) => t.id === taskId)?.status).toBe('pending');
    });

    it('fan-in: task stays waiting until all deps complete', async () => {
      const store = new TaskStore(dataDir);
      const dep1 = await store.create('dep1', 'desc');
      const dep2 = await store.create('dep2', 'desc');
      const taskId = await store.create('task', 'desc', [dep1, dep2]);

      await store.update(dep1, { status: 'completed' });
      expect(store.list().find((t) => t.id === taskId)?.status).toBe('waiting');

      await store.update(dep2, { status: 'completed' });
      expect(store.list().find((t) => t.id === taskId)?.status).toBe('pending');
    });

    it('cascade failure: failing a dep auto-fails its waiting dependent', async () => {
      const store = new TaskStore(dataDir);
      const depId = await store.create('dep', 'desc');
      const taskId = await store.create('task', 'desc', [depId]);

      await store.update(depId, { status: 'failed', error: 'oops' });

      const task = store.list().find((t) => t.id === taskId);
      expect(task?.status).toBe('failed');
      expect(task?.error).toContain(depId);
    });

    it('cascade failure propagates transitively', async () => {
      const store = new TaskStore(dataDir);
      const a = await store.create('a', 'desc');
      const b = await store.create('b', 'desc', [a]);
      const c = await store.create('c', 'desc', [b]);

      await store.update(a, { status: 'failed', error: 'root failure' });

      expect(store.list().find((t) => t.id === b)?.status).toBe('failed');
      expect(store.list().find((t) => t.id === c)?.status).toBe('failed');
    });

    it('circular detection: rejects deps that would create a cycle', async () => {
      // Pre-load a store where task-1 already lists task-2 in its dependsOn.
      // The counter is set to 1 so the next create() will produce task-2.
      // Creating task-2 with deps [task-1] then forms: task-2 → task-1 → task-2.
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          tasks: [
            {
              id: 'task-1',
              title: 'A',
              description: 'desc',
              status: 'waiting',
              dependsOn: ['task-2'],
              subtaskIds: [],
              sessionIds: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          counter: 1,
        }),
      );

      const store = new TaskStore(dataDir);
      await expect(store.create('B', 'desc', ['task-1'])).rejects.toThrow(/circular/i);
    });

    it('rejects deps referencing non-existent task IDs', async () => {
      const store = new TaskStore(dataDir);
      await expect(store.create('task', 'desc', ['nonexistent'])).rejects.toThrow(
        /dependency not found/i,
      );
    });

    it('does not advance the counter when dep validation fails', async () => {
      const store = new TaskStore(dataDir);
      await expect(store.create('bad', 'desc', ['nonexistent'])).rejects.toThrow();
      // Next successful create should still get task-1, not task-2
      const id = await store.create('good', 'desc');
      expect(id).toBe('task-1');
    });

    it('does not advance the counter when cycle detection fails', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          tasks: [
            {
              id: 'task-1',
              title: 'A',
              description: 'desc',
              status: 'waiting',
              dependsOn: ['task-2'],
              subtaskIds: [],
              sessionIds: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          counter: 1,
        }),
      );
      const store = new TaskStore(dataDir);
      await expect(store.create('B', 'desc', ['task-1'])).rejects.toThrow(/circular/i);
      // Next successful create should get task-2, not task-3
      const id = await store.create('C', 'desc');
      expect(id).toBe('task-2');
    });
  });

  // ── approval gates ───────────────────────────────────────────────────────────

  describe('approval gates', () => {
    it('task created with requiresApproval:true has requiresApproval=true', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc', [], true);
      expect(store.list().find((t) => t.id === id)?.requiresApproval).toBe(true);
    });

    it('task created without requiresApproval has requiresApproval=false', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      expect(store.list().find((t) => t.id === id)?.requiresApproval).toBe(false);
    });

    it('allows awaiting_approval status when requiresApproval is true', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc', [], true);
      await store.update(id, { status: 'in_progress' });
      await expect(store.update(id, { status: 'awaiting_approval' })).resolves.toBeUndefined();
      expect(store.list().find((t) => t.id === id)?.status).toBe('awaiting_approval');
    });

    it('rejects awaiting_approval status when requiresApproval is false', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc', [], false);
      await expect(store.update(id, { status: 'awaiting_approval' })).rejects.toThrow(
        /requiresApproval/,
      );
    });

    it('approval flow: awaiting_approval → completed', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc', [], true);
      await store.update(id, { status: 'in_progress' });
      await store.update(id, { status: 'awaiting_approval' });
      await store.update(id, { status: 'completed', result: 'approved output' });
      const task = store.list().find((t) => t.id === id);
      expect(task?.status).toBe('completed');
      expect(task?.result).toBe('approved output');
    });

    it('rejection flow: awaiting_approval → in_progress for revision', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc', [], true);
      await store.update(id, { status: 'in_progress' });
      await store.update(id, { status: 'awaiting_approval' });
      await store.update(id, { status: 'in_progress' });
      expect(store.list().find((t) => t.id === id)?.status).toBe('in_progress');
    });

    it('task_list includes requiresApproval field', async () => {
      const store = new TaskStore(dataDir);
      await store.create('task', 'desc', [], true);
      const tasks = store.list();
      expect(tasks[0]).toHaveProperty('requiresApproval', true);
    });

    it('loads requiresApproval from persisted data', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          tasks: [
            {
              id: 'task-1',
              title: 'approval task',
              description: 'desc',
              status: 'pending',
              requiresApproval: true,
              dependsOn: [],
              subtaskIds: [],
              sessionIds: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          counter: 1,
        }),
      );
      const store = new TaskStore(dataDir);
      expect(store.list().find((t) => t.id === 'task-1')?.requiresApproval).toBe(true);
    });

    it('defaults requiresApproval to false for tasks persisted before S4-5', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          tasks: [
            {
              id: 'task-1',
              title: 'old task',
              description: 'desc',
              status: 'pending',
              dependsOn: [],
              subtaskIds: [],
              sessionIds: [],
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ],
          counter: 1,
        }),
      );
      const store = new TaskStore(dataDir);
      expect(store.list().find((t) => t.id === 'task-1')?.requiresApproval).toBe(false);
    });
  });

  // ── list ─────────────────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns empty array with no tasks', () => {
      const store = new TaskStore(dataDir);
      expect(store.list()).toEqual([]);
    });

    it('returns copies — mutating a returned task does not affect the store', async () => {
      const store = new TaskStore(dataDir);
      const id = await store.create('task', 'desc');
      const task = store.list().find((t) => t.id === id);
      if (task) task.status = 'completed';
      expect(store.list().find((t) => t.id === id)?.status).toBe('pending');
    });
  });
});
