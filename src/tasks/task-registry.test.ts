import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as fs from 'node:fs';
import { join } from 'node:path';

vi.mock('node:fs/promises');
vi.mock('node:fs');

import { TaskRegistry } from './task-registry';

const DATA_DIR = '/bolt';
const TASKS_PATH = join(DATA_DIR, 'tasks.json');
const PROJECTS_INDEX_PATH = join(DATA_DIR, 'projects.json');

function emptyTasksJson(): string {
  return JSON.stringify({ tasks: [], counter: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();

  // Default: no files exist
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockImplementation((path) => {
    throw Object.assign(new Error(`ENOENT: ${String(path)}`), { code: 'ENOENT' });
  });
  vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
  vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
  vi.mocked(fsPromises.rename).mockResolvedValue(undefined);
  vi.mocked(fsPromises.readFile).mockRejectedValue(
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
  );
});

function makeRegistryWithEmptyGlobal(): TaskRegistry {
  // Make tasks.json exist and be empty
  vi.mocked(fs.existsSync).mockImplementation((p) => String(p) === TASKS_PATH);
  vi.mocked(fs.readFileSync).mockImplementation((p) => {
    if (String(p) === TASKS_PATH) return emptyTasksJson();
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  return new TaskRegistry(DATA_DIR);
}

describe('TaskRegistry', () => {
  describe('create — global store (no projectId)', () => {
    it('creates a task in the global store and returns a task id', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      const id = await registry.create('my task', 'desc');
      expect(id).toBe('task-1');
    });

    it('increments counter across multiple creates', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      const id1 = await registry.create('task 1', 'desc');
      const id2 = await registry.create('task 2', 'desc');
      expect(id1).toBe('task-1');
      expect(id2).toBe('task-2');
    });

    it('created task appears in list()', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      await registry.create('listed task', 'desc');
      const tasks = registry.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.title).toBe('listed task');
    });

    it('throws on unknown dependency', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      await expect(registry.create('task', 'desc', ['task-99'])).rejects.toThrow(
        'dependency not found',
      );
    });

    it('throws on circular dependency', async () => {
      makeRegistryWithEmptyGlobal(); // reset existsSync/readFileSync mocks to TASKS_PATH baseline
      // Seed: tasks.json has task-1 with dependsOn: [task-2], counter: 1
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === TASKS_PATH) {
          return JSON.stringify({
            tasks: [
              {
                id: 'task-1',
                title: 'A',
                description: 'desc',
                status: 'waiting',
                dependsOn: ['task-2'],
                requiresApproval: false,
                subtaskIds: [],
                sessionIds: [],
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
              },
            ],
            counter: 1,
          });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      const circularRegistry = new TaskRegistry(DATA_DIR);
      await expect(circularRegistry.create('B', 'desc', ['task-1'])).rejects.toThrow(/circular/i);
    });
  });

  describe('create — project store (with projectId)', () => {
    it('creates a task in the project store when projectId is registered', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      const projectDir = '/projects/proj-1';
      const projectTasksPath = join(projectDir, 'tasks.json');

      // Make the project tasks.json exist
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const ps = String(p);
        return ps === TASKS_PATH || ps === projectTasksPath;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === TASKS_PATH || String(p) === projectTasksPath) return emptyTasksJson();
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fsPromises.readFile).mockImplementation(async (p) => {
        if (String(p) === PROJECTS_INDEX_PATH) {
          return JSON.stringify([
            { projectId: 'proj-1', status: 'active', dir: projectDir },
          ]);
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      await registry.registerProject('proj-1', projectDir);
      const id = await registry.create('proj task', 'desc', [], false, 'proj-1');
      expect(id).toBe('task-1');

      // Global list merges both stores
      const tasks = registry.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.title).toBe('proj task');
    });

    it('falls back to global store when projectId is not registered', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      const id = await registry.create('task', 'desc', [], false, 'unknown-proj');
      expect(id).toBe('task-1');
      // Should be in global list
      expect(registry.list()).toHaveLength(1);
    });
  });

  describe('list()', () => {
    it('returns empty array when no tasks', () => {
      const registry = makeRegistryWithEmptyGlobal();
      expect(registry.list()).toEqual([]);
    });

    it('merges global and project tasks', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      const projectDir = '/projects/proj-2';
      const projectTasksPath = join(projectDir, 'tasks.json');

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const ps = String(p);
        return ps === TASKS_PATH || ps === projectTasksPath;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === TASKS_PATH || String(p) === projectTasksPath) return emptyTasksJson();
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fsPromises.readFile).mockResolvedValue('[]' as never);

      await registry.registerProject('proj-2', projectDir);
      await registry.create('global task', 'desc');
      await registry.create('project task', 'desc', [], false, 'proj-2');

      const tasks = registry.list();
      expect(tasks).toHaveLength(2);
      const titles = tasks.map((t) => t.title).sort();
      expect(titles).toEqual(['global task', 'project task']);
    });
  });

  describe('update()', () => {
    it('updates a task in the global store', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      const id = await registry.create('task', 'desc');
      await registry.update(id, { status: 'in_progress' });
      const task = registry.list().find((t) => t.id === id);
      expect(task?.status).toBe('in_progress');
    });

    it('throws when task is not found in any store', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      await expect(registry.update('task-99', { status: 'completed' })).rejects.toThrow(
        'task not found',
      );
    });
  });

  describe('registerProject()', () => {
    it('adds project to index and creates store', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      const projectDir = '/projects/my-proj';

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const ps = String(p);
        return ps === TASKS_PATH || ps === join(projectDir, 'tasks.json');
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (
          String(p) === TASKS_PATH ||
          String(p) === join(projectDir, 'tasks.json')
        ) {
          return emptyTasksJson();
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fsPromises.readFile).mockResolvedValue('[]' as never);

      await registry.registerProject('my-proj', projectDir);

      // After registration, should be able to create a project task
      const id = await registry.create('proj task', 'desc', [], false, 'my-proj');
      expect(id).toBeTruthy();
      expect(registry.list()).toHaveLength(1);
    });

    it('moves corrupt projects.json to corrupted/ and starts fresh', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      const projectDir = '/projects/new-proj';

      // projects.json exists but contains invalid JSON
      vi.mocked(fsPromises.readFile).mockImplementation(async (p) => {
        if (String(p) === PROJECTS_INDEX_PATH) return 'not valid json {{{' as never;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const ps = String(p);
        return ps === TASKS_PATH || ps === join(projectDir, 'tasks.json');
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === TASKS_PATH || String(p) === join(projectDir, 'tasks.json')) {
          return emptyTasksJson();
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      // Should not throw — corrupt file is moved and a fresh index is used
      await registry.registerProject('new-proj', projectDir);

      // rename should have been called to move the corrupt file
      expect(vi.mocked(fsPromises.rename)).toHaveBeenCalledWith(
        PROJECTS_INDEX_PATH,
        expect.stringMatching(/corrupted.*projects\.json$/),
      );
      // The new index is written with only the new project
      const indexWrites = vi.mocked(fsPromises.writeFile).mock.calls.filter(
        (c) => String(c[0]) === PROJECTS_INDEX_PATH,
      );
      expect(indexWrites).toHaveLength(1);
      const written = JSON.parse(indexWrites[0]![1] as string) as Array<{ projectId: string }>;
      expect(written).toHaveLength(1);
      expect(written[0]!.projectId).toBe('new-proj');
    });

    it('does not duplicate project in index if already exists', async () => {
      const registry = makeRegistryWithEmptyGlobal();
      const projectDir = '/projects/dup-proj';

      const existingIndex = JSON.stringify([
        { projectId: 'dup-proj', dir: projectDir },
      ]);
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const ps = String(p);
        return (
          ps === TASKS_PATH ||
          ps === PROJECTS_INDEX_PATH ||
          ps === join(projectDir, 'tasks.json')
        );
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === TASKS_PATH || String(p) === join(projectDir, 'tasks.json')) {
          return emptyTasksJson();
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fsPromises.readFile).mockResolvedValue(
        existingIndex as never,
      );

      await registry.registerProject('dup-proj', projectDir);

      // writeFile should not be called for the projects index (no change)
      const writeFileCalls = vi.mocked(fsPromises.writeFile).mock.calls;
      const indexWrites = writeFileCalls.filter((c) => String(c[0]) === PROJECTS_INDEX_PATH);
      expect(indexWrites).toHaveLength(0);
    });
  });

  describe('loadActiveProjects()', () => {
    it('loads project stores for projects with active tasks', async () => {
      const projectDir = '/projects/active-proj';
      const projectTasksPath = join(projectDir, 'tasks.json');

      const projectTasksContent = JSON.stringify({
        tasks: [
          {
            id: 'task-5',
            title: 'active task',
            description: 'desc',
            status: 'in_progress',
            dependsOn: [],
            requiresApproval: false,
            subtaskIds: [],
            sessionIds: [],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        counter: 5,
      });

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const ps = String(p);
        return (
          ps === TASKS_PATH ||
          ps === PROJECTS_INDEX_PATH ||
          ps === projectTasksPath
        );
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === TASKS_PATH) return emptyTasksJson();
        if (String(p) === projectTasksPath) return projectTasksContent;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fsPromises.readFile).mockImplementation(async (p) => {
        if (String(p) === PROJECTS_INDEX_PATH) {
          return JSON.stringify([
            { projectId: 'active-proj', dir: projectDir },
          ]) as never;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const registry = new TaskRegistry(DATA_DIR);
      await registry.loadActiveProjects();

      // The project task should be included in list()
      const tasks = registry.list();
      expect(tasks.some((t) => t.id === 'task-5')).toBe(true);

      // Counter should be synced to max of all task IDs seen
      // (task-5 has numeric ID 5, so counter should be at least 5)
      const nextId = await registry.create('new task', 'desc');
      expect(nextId).toBe('task-6');
    });

    it('skips projects with no active tasks', async () => {
      const projectDir = '/projects/done-proj';
      const projectTasksPath = join(projectDir, 'tasks.json');

      const completedTasksContent = JSON.stringify({
        tasks: [
          {
            id: 'task-3',
            title: 'done task',
            description: 'desc',
            status: 'completed',
            dependsOn: [],
            requiresApproval: false,
            subtaskIds: [],
            sessionIds: [],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        counter: 3,
      });

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const ps = String(p);
        return ps === TASKS_PATH || ps === PROJECTS_INDEX_PATH || ps === projectTasksPath;
      });
      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === TASKS_PATH) return emptyTasksJson();
        if (String(p) === projectTasksPath) return completedTasksContent;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      vi.mocked(fsPromises.readFile).mockImplementation(async (p) => {
        if (String(p) === PROJECTS_INDEX_PATH) {
          return JSON.stringify([
            { projectId: 'done-proj', dir: projectDir },
          ]) as never;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const registry = new TaskRegistry(DATA_DIR);
      await registry.loadActiveProjects();

      // Completed tasks should NOT be loaded (project not active)
      const tasks = registry.list();
      expect(tasks.some((t) => t.id === 'task-3')).toBe(false);
    });

    it('auto-discovers projects from workspace/projects/ directory', async () => {
      const workspaceRoot = '/workspace';
      const projectsDir = join(workspaceRoot, 'projects');
      const discoveredProjectDir = join(projectsDir, 'discovered-proj');
      const discoveredTasksPath = join(discoveredProjectDir, 'tasks.json');

      const discoveredTasksContent = JSON.stringify({
        tasks: [
          {
            id: 'task-10',
            title: 'discovered task',
            description: 'desc',
            status: 'pending',
            dependsOn: [],
            requiresApproval: false,
            subtaskIds: [],
            sessionIds: [],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        counter: 10,
      });

      // Mock existsSync for discovered project tasks
      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const ps = String(p);
        return ps === TASKS_PATH || ps === discoveredTasksPath;
      });

      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === TASKS_PATH) return emptyTasksJson();
        if (String(p) === discoveredTasksPath) return discoveredTasksContent;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      // Empty projects index (no registered projects)
      vi.mocked(fsPromises.readFile).mockImplementation(async (p) => {
        if (String(p) === PROJECTS_INDEX_PATH) {
          return JSON.stringify([]) as never;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      // Mock readdir to return the discovered project directory
      vi.mocked(fsPromises.readdir).mockImplementation(async (p) => {
        if (String(p) === projectsDir) {
          return [{ name: 'discovered-proj', isDirectory: () => true } as never];
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const registry = new TaskRegistry(DATA_DIR, workspaceRoot);
      await registry.loadActiveProjects();

      // The discovered project task should be included in list()
      const tasks = registry.list();
      expect(tasks.some((t) => t.id === 'task-10')).toBe(true);

      // Counter should be synced to max of all task IDs seen
      const nextId = await registry.create('new task', 'desc');
      expect(nextId).toBe('task-11');
    });

    it('skips workspace projects with no active tasks', async () => {
      const workspaceRoot = '/workspace';
      const projectsDir = join(workspaceRoot, 'projects');
      const inactiveProjectDir = join(projectsDir, 'inactive-proj');
      const inactiveTasksPath = join(inactiveProjectDir, 'tasks.json');

      const inactiveTasksContent = JSON.stringify({
        tasks: [
          {
            id: 'task-20',
            title: 'completed task',
            description: 'desc',
            status: 'completed',
            dependsOn: [],
            requiresApproval: false,
            subtaskIds: [],
            sessionIds: [],
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
        counter: 20,
      });

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        const ps = String(p);
        return ps === TASKS_PATH || ps === inactiveTasksPath;
      });

      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === TASKS_PATH) return emptyTasksJson();
        if (String(p) === inactiveTasksPath) return inactiveTasksContent;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      vi.mocked(fsPromises.readFile).mockImplementation(async (p) => {
        if (String(p) === PROJECTS_INDEX_PATH) {
          return JSON.stringify([]) as never;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      vi.mocked(fsPromises.readdir).mockImplementation(async (p) => {
        if (String(p) === projectsDir) {
          return [{ name: 'inactive-proj', isDirectory: () => true } as never];
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const registry = new TaskRegistry(DATA_DIR, workspaceRoot);
      await registry.loadActiveProjects();

      // Inactive tasks should NOT be loaded
      const tasks = registry.list();
      expect(tasks.some((t) => t.id === 'task-20')).toBe(false);
    });

    it('handles missing workspace/projects/ directory gracefully', async () => {
      const workspaceRoot = '/workspace';

      vi.mocked(fs.existsSync).mockImplementation((p) => {
        return String(p) === TASKS_PATH;
      });

      vi.mocked(fs.readFileSync).mockImplementation((p) => {
        if (String(p) === TASKS_PATH) return emptyTasksJson();
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      vi.mocked(fsPromises.readFile).mockImplementation(async (p) => {
        if (String(p) === PROJECTS_INDEX_PATH) {
          return JSON.stringify([]) as never;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      vi.mocked(fsPromises.readdir).mockImplementation(async (_p) => {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      });

      const registry = new TaskRegistry(DATA_DIR, workspaceRoot);

      // Should not throw even if workspace/projects/ doesn't exist
      await expect(registry.loadActiveProjects()).resolves.not.toThrow();
    });
  });
});
