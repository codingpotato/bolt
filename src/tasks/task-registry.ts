import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TaskStore, type Task, type TaskStatus } from './task-store';

export interface ProjectEntry {
  projectId: string;
  dir: string;
}

const NON_TERMINAL_STATUSES: TaskStatus[] = [
  'pending',
  'waiting',
  'in_progress',
  'blocked',
  'awaiting_approval',
];

/**
 * Manages tasks across multiple stores:
 * - A global store for non-project tasks (.bolt/tasks.json)
 * - Per-project stores for content project tasks (projects/<id>/tasks.json)
 *
 * Maintains a single global task ID counter across all stores, stored in
 * the global tasks.json file.
 */
export class TaskRegistry {
  private readonly globalStore: TaskStore;
  private readonly projectStores: Map<string, TaskStore> = new Map();
  private counter: number;
  private readonly projectsIndexPath: string;
  private readonly corruptedDir: string;
  private readonly workspaceRoot: string | undefined;

  constructor(dataDir: string, workspaceRoot?: string) {
    this.corruptedDir = join(dataDir, 'corrupted');
    this.globalStore = new TaskStore(join(dataDir, 'tasks.json'), this.corruptedDir);
    this.counter = this.globalStore.getCounter();
    this.projectsIndexPath = join(dataDir, 'projects.json');
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Load TaskStore instances for all active projects listed in .bolt/projects.json.
   * Also auto-discovers projects from workspace/projects/ directory if workspaceRoot is set.
   * Call once at startup after constructing the registry.
   */
  async loadActiveProjects(): Promise<void> {
    const index = await this.readProjectsIndex();
    for (const entry of index) {
      const hasActive = this.hasActiveTasksInFile(join(entry.dir, 'tasks.json'));
      if (hasActive) {
        const store = new TaskStore(join(entry.dir, 'tasks.json'), this.corruptedDir);
        this.projectStores.set(entry.projectId, store);
        // Sync counter: if project tasks have higher numeric IDs, update counter
        for (const task of store.list()) {
          const num = parseInt(task.id.replace('task-', ''), 10);
          if (!isNaN(num) && num > this.counter) this.counter = num;
        }
      }
    }

    // Auto-discover projects from workspace/projects/ directory
    if (this.workspaceRoot) {
      await this.discoverWorkspaceProjects();
    }
  }

  /**
   * Auto-discover projects from workspace/projects/ directory.
   * This handles projects that were created manually or before the registration mechanism existed.
   */
  private async discoverWorkspaceProjects(): Promise<void> {
    if (!this.workspaceRoot) return;
    const projectsDir = join(this.workspaceRoot, 'projects');
    try {
      const entries = await readdir(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const projectDir = join(projectsDir, entry.name);
        const tasksPath = join(projectDir, 'tasks.json');

        // Check if this project has active tasks
        if (!this.hasActiveTasksInFile(tasksPath)) continue;

        // Skip if already registered
        if (this.projectStores.has(entry.name)) continue;

        // Load the project store
        const store = new TaskStore(tasksPath, this.corruptedDir);
        this.projectStores.set(entry.name, store);

        // Sync counter
        for (const task of store.list()) {
          const num = parseInt(task.id.replace('task-', ''), 10);
          if (!isNaN(num) && num > this.counter) this.counter = num;
        }
      }
    } catch (err) {
      // Directory doesn't exist or can't be read - that's ok
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  /**
   * Register a new content project. Called by content_project_create tool.
   * Creates the project's task store and adds the project to .bolt/projects.json.
   */
  async registerProject(projectId: string, projectDir: string): Promise<void> {
    const index = await this.readProjectsIndex();
    if (!index.find((e) => e.projectId === projectId)) {
      index.push({ projectId, dir: projectDir });
      await this.writeProjectsIndex(index);
    }
    const tasksPath = join(projectDir, 'tasks.json');
    const store = new TaskStore(tasksPath, this.corruptedDir);
    this.projectStores.set(projectId, store);
  }

  async create(
    title: string,
    description: string,
    dependsOn: string[] = [],
    requiresApproval = false,
    projectId?: string,
  ): Promise<string> {
    // Validate deps exist across all stores
    for (const depId of dependsOn) {
      if (!this.findStore(depId)) {
        throw new Error(`dependency not found: ${depId}`);
      }
    }

    const candidateId = `task-${this.counter + 1}`;

    if (dependsOn.length > 0 && this.wouldCreateCycle(candidateId, dependsOn)) {
      throw new Error(
        `circular dependency: task ${candidateId} with deps [${dependsOn.join(', ')}] would create a cycle`,
      );
    }

    const id = `task-${++this.counter}`;
    const targetStore =
      projectId && this.projectStores.has(projectId)
        ? this.projectStores.get(projectId)!
        : this.globalStore;
    await targetStore.createWithId(id, title, description, dependsOn, requiresApproval);
    // Persist updated counter in global store
    await this.globalStore.setCounter(this.counter);
    return id;
  }

  async update(
    id: string,
    changes: { status: TaskStatus; result?: string; error?: string; sessionId?: string },
  ): Promise<void> {
    const store = this.findStore(id);
    if (!store) throw new Error(`task not found: ${id}`);
    await store.update(id, changes);
  }

  list(): Task[] {
    const all: Task[] = [...this.globalStore.list()];
    for (const store of this.projectStores.values()) {
      all.push(...store.list());
    }
    return all;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private findStore(taskId: string): TaskStore | undefined {
    if (this.globalStore.has(taskId)) return this.globalStore;
    for (const store of this.projectStores.values()) {
      if (store.has(taskId)) return store;
    }
    return undefined;
  }

  private wouldCreateCycle(newId: string, deps: string[]): boolean {
    const allTasks = this.list();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const visited = new Set<string>();
    const stack = [...deps];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === newId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const task = taskMap.get(current);
      if (task) {
        for (const d of task.dependsOn) stack.push(d);
      }
    }
    return false;
  }

  private hasActiveTasksInFile(tasksPath: string): boolean {
    if (!existsSync(tasksPath)) return false;
    try {
      const raw = readFileSync(tasksPath, 'utf-8') as string;
      const parsed = JSON.parse(raw) as { tasks: Task[] };
      if (!Array.isArray(parsed.tasks)) return false;
      return parsed.tasks.some((t) => NON_TERMINAL_STATUSES.includes(t.status));
    } catch {
      return false;
    }
  }

  private async readProjectsIndex(): Promise<ProjectEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.projectsIndexPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    // If the file exists but is corrupt, move it to corrupted/ and start fresh
    // rather than silently dropping the entire project index.
    try {
      return JSON.parse(raw) as ProjectEntry[];
    } catch {
      const ts = Date.now();
      await mkdir(this.corruptedDir, { recursive: true });
      const { rename } = await import('node:fs/promises');
      await rename(this.projectsIndexPath, join(this.corruptedDir, `${ts}-projects.json`));
      return [];
    }
  }

  private async writeProjectsIndex(index: ProjectEntry[]): Promise<void> {
    await mkdir(join(this.projectsIndexPath, '..'), { recursive: true });
    await writeFile(this.projectsIndexPath, JSON.stringify(index, null, 2), 'utf-8');
  }
}
