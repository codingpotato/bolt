import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'waiting' | 'awaiting_approval' | 'completed' | 'failed';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  /** Task IDs that must be completed before this task can start. */
  dependsOn: string[];
  /** If true, agent must present output via user_review before marking completed. */
  requiresApproval: boolean;
  parentId?: string;
  subtaskIds: string[];
  /** Sessions that have worked on this task (appended when status → in_progress). */
  sessionIds: string[];
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

interface SerializedStore {
  tasks: Task[];
  counter: number;
}

function isSerializedStore(value: unknown): value is SerializedStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tasks' in value &&
    Array.isArray((value as SerializedStore).tasks) &&
    'counter' in value &&
    typeof (value as SerializedStore).counter === 'number'
  );
}

export class TaskStore {
  private readonly taskMap: Map<string, Task> = new Map();
  private counter = 0;
  private readonly filePath: string;
  private corrupt = false;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'tasks.json');
    this.loadSync();
  }

  private loadSync(): void {
    if (!existsSync(this.filePath)) return;

    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8') as string;
    } catch {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.corrupt = true;
      return;
    }

    if (!isSerializedStore(parsed)) {
      return;
    }

    this.counter = parsed.counter;
    // Cast to allow missing fields from data persisted before S4-4/S4-5
    type StoredTask = Omit<Task, 'dependsOn' | 'requiresApproval'> & { dependsOn?: string[]; requiresApproval?: boolean };
    for (const task of parsed.tasks as StoredTask[]) {
      this.taskMap.set(task.id, { dependsOn: [], requiresApproval: false, ...task });
    }
  }

  private async persist(): Promise<void> {
    if (this.corrupt) {
      // Move corrupt file before writing clean state
      const ts = Date.now();
      const corruptedDir = join(dirname(this.filePath), 'corrupted');
      await mkdir(corruptedDir, { recursive: true });
      await rename(this.filePath, join(corruptedDir, `${ts}-tasks.json`));
      this.corrupt = false;
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    const data: SerializedStore = {
      tasks: Array.from(this.taskMap.values()),
      counter: this.counter,
    };
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  async create(title: string, description: string, dependsOn: string[] = [], requiresApproval = false): Promise<string> {
    for (const depId of dependsOn) {
      if (!this.taskMap.has(depId)) {
        throw new Error(`dependency not found: ${depId}`);
      }
    }

    // Compute candidate ID without committing the increment so that validation
    // failures leave the counter unchanged (no gaps in task IDs on error).
    const candidateId = `task-${this.counter + 1}`;

    if (dependsOn.length > 0 && this.wouldCreateCycle(candidateId, dependsOn)) {
      throw new Error(`circular dependency: task ${candidateId} with deps [${dependsOn.join(', ')}] would create a cycle`);
    }

    const newId = `task-${++this.counter}`;
    const now = new Date().toISOString();

    const task: Task = {
      id: newId,
      title,
      description,
      status: dependsOn.length > 0 ? 'waiting' : 'pending',
      dependsOn,
      requiresApproval,
      subtaskIds: [],
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.taskMap.set(newId, task);
    await this.persist();
    return newId;
  }

  private wouldCreateCycle(newId: string, deps: string[]): boolean {
    const visited = new Set<string>();
    const stack = [...deps];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === newId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const task = this.taskMap.get(current);
      if (task) {
        for (const d of task.dependsOn) {
          stack.push(d);
        }
      }
    }
    return false;
  }

  private unlockDependents(completedId: string): void {
    const now = new Date().toISOString();
    for (const task of this.taskMap.values()) {
      if (task.status !== 'waiting') continue;
      if (!task.dependsOn.includes(completedId)) continue;
      const allDone = task.dependsOn.every((depId) => this.taskMap.get(depId)?.status === 'completed');
      if (allDone) {
        task.status = 'pending';
        task.updatedAt = now;
      }
    }
  }

  private cascadeFail(failedId: string): void {
    const now = new Date().toISOString();
    for (const task of this.taskMap.values()) {
      if (task.status !== 'waiting') continue;
      if (!task.dependsOn.includes(failedId)) continue;
      task.status = 'failed';
      task.error = `dependency ${failedId} failed`;
      task.updatedAt = now;
      this.cascadeFail(task.id);
    }
  }

  async update(
    id: string,
    changes: { status: TaskStatus; result?: string; error?: string; sessionId?: string },
  ): Promise<void> {
    const task = this.taskMap.get(id);
    if (!task) throw new Error(`task not found: ${id}`);
    if (changes.status === 'awaiting_approval' && !task.requiresApproval) {
      throw new Error(`cannot set awaiting_approval on task ${id}: requiresApproval is false`);
    }
    task.status = changes.status;
    task.updatedAt = new Date().toISOString();
    if (changes.result !== undefined) task.result = changes.result;
    if (changes.error !== undefined) task.error = changes.error;
    if (changes.status === 'in_progress' && changes.sessionId !== undefined) {
      task.sessionIds.push(changes.sessionId);
    }
    if (changes.status === 'completed') {
      this.unlockDependents(id);
    } else if (changes.status === 'failed') {
      this.cascadeFail(id);
    }
    await this.persist();
  }

  list(): Task[] {
    return Array.from(this.taskMap.values()).map((task) => ({
      ...task,
      dependsOn: [...task.dependsOn],
      subtaskIds: [...task.subtaskIds],
    }));
  }
}
