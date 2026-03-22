import type { Task, TaskStore } from './task-store';

/**
 * Executes a single task and returns a result string on success.
 * Throw to signal failure — the runner will catch and mark the task failed.
 */
export type TaskExecutor = (task: Task) => Promise<string>;

/**
 * TaskRunner drives the task execution loop.
 *
 * On each iteration:
 *   1. Pick the first pending task from the store.
 *   2. Mark it in_progress.
 *   3. Call the executor.
 *   4. On success: mark completed with the returned result string.
 *      On failure: mark failed with the error message.
 *
 * The loop stops when no pending tasks remain (all are completed, failed,
 * or blocked). Blocked tasks are never picked — they must be explicitly
 * transitioned back to pending by an external actor before they can run.
 */
export class TaskRunner {
  constructor(
    private readonly store: TaskStore,
    private readonly executor: TaskExecutor,
  ) {}

  async run(): Promise<void> {
    while (true) {
      const task = this.store.list().find((t) => t.status === 'pending');
      if (!task) break;

      await this.store.update(task.id, { status: 'in_progress' });

      try {
        const result = await this.executor(task);
        await this.store.update(task.id, { status: 'completed', result });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await this.store.update(task.id, { status: 'failed', error });
      }
    }
  }
}
