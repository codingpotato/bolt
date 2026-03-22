import { readFileSync, existsSync } from 'node:fs';
import { writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'completed' | 'failed';

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  parentId?: string;
  subtaskIds: string[];
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
    for (const task of parsed.tasks) {
      this.taskMap.set(task.id, task);
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

  async create(title: string, description: string): Promise<string> {
    const id = `task-${++this.counter}`;
    const now = new Date().toISOString();
    const task: Task = {
      id,
      title,
      description,
      status: 'pending',
      subtaskIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.taskMap.set(id, task);
    await this.persist();
    return id;
  }

  async update(
    id: string,
    changes: { status: TaskStatus; result?: string; error?: string },
  ): Promise<void> {
    const task = this.taskMap.get(id);
    if (!task) throw new Error(`task not found: ${id}`);
    task.status = changes.status;
    task.updatedAt = new Date().toISOString();
    if (changes.result !== undefined) task.result = changes.result;
    if (changes.error !== undefined) task.error = changes.error;
    await this.persist();
  }

  list(): Task[] {
    return Array.from(this.taskMap.values()).map((task) => ({ ...task, subtaskIds: [...task.subtaskIds] }));
  }
}
