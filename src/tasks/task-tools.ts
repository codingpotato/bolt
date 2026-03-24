import { ToolError } from '../tools/tool';
import type { Tool, ToolContext } from '../tools/tool';
import type { Task, TaskStatus, TaskStore } from './task-store';

interface TaskCreateInput {
  title: string;
  description: string;
  dependsOn?: string[];
}

interface TaskCreateOutput {
  id: string;
}

interface TaskUpdateInput {
  id: string;
  status: TaskStatus;
  result?: string;
  error?: string;
}

interface TaskUpdateOutput {
  id: string;
}

interface TaskListOutput {
  tasks: Task[];
}

export function createTaskTools(store: TaskStore): Tool[] {
  const taskCreate: Tool<TaskCreateInput, TaskCreateOutput> = {
    name: 'task_create',
    description: 'Create a structured task with a title and description. Returns the new task id. Writes to .bolt/tasks.json immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the task.' },
        description: { type: 'string', description: 'Full description of the task and its success criteria.' },
        dependsOn: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of task IDs that must complete before this task can start. Tasks with deps start in waiting status.',
        },
      },
      required: ['title', 'description'],
    },
    async execute(input: TaskCreateInput, _ctx: ToolContext): Promise<TaskCreateOutput> {
      try {
        const id = await store.create(input.title, input.description, input.dependsOn);
        return { id };
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
    },
  };

  const taskUpdate: Tool<TaskUpdateInput, TaskUpdateOutput> = {
    name: 'task_update',
    description: 'Update the status of a task. Optionally set result (on completion) or error (on failure).',
    sequential: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the task to update.' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'blocked', 'waiting', 'completed', 'failed'],
          description: 'New status. Tasks start as pending (no deps) or waiting (has unmet deps). waiting → pending is managed automatically by the store when deps complete.',
        },
        result: { type: 'string', description: 'Output of the task when completed.' },
        error: { type: 'string', description: 'Reason for failure when status is failed.' },
      },
      required: ['id', 'status'],
    },
    async execute(input: TaskUpdateInput, ctx: ToolContext): Promise<TaskUpdateOutput> {
      let title = input.id;
      try {
        const existing = store.list().find((t) => t.id === input.id);
        if (existing) title = existing.title;
        await store.update(input.id, {
          status: input.status,
          result: input.result,
          error: input.error,
          sessionId: ctx.sessionId,
        });
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      // Track the active task in ToolContext so AgentCore can stamp taskId on
      // session entries. Set when a task moves to in_progress, cleared otherwise.
      if (input.status === 'in_progress') {
        ctx.activeTaskId = input.id;
      } else if (ctx.activeTaskId === input.id) {
        ctx.activeTaskId = undefined;
      }
      ctx.progress.onTaskStatusChange(input.id, title, input.status);
      return { id: input.id };
    },
  };

  const taskList: Tool<Record<string, never>, TaskListOutput> = {
    name: 'task_list',
    description: 'Return all tasks with their current status, result, and error fields.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input: Record<string, never>, _ctx: ToolContext): Promise<TaskListOutput> {
      return { tasks: store.list() };
    },
  };

  return [taskCreate, taskUpdate, taskList];
}
