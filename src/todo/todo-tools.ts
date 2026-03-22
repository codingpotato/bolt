import { ToolError } from '../tools/tool';
import type { Tool, ToolContext } from '../tools/tool';
import type { TodoItem, TodoStatus, TodoStore } from './todo-store';

interface TodoCreateInput {
  title: string;
}

interface TodoCreateOutput {
  id: string;
}

interface TodoUpdateInput {
  id: string;
  status?: TodoStatus;
  description?: string;
}

interface TodoUpdateOutput {
  id: string;
}

interface TodoListOutput {
  items: TodoItem[];
}

interface TodoDeleteInput {
  id: string;
}

interface TodoDeleteOutput {
  id: string;
}

export function createTodoTools(store: TodoStore): Tool[] {
  const todoCreate: Tool<TodoCreateInput, TodoCreateOutput> = {
    name: 'todo_create',
    description: 'Add an item to the todo list. Returns the new item id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title for the todo item.' },
      },
      required: ['title'],
    },
    async execute(input: TodoCreateInput, _ctx: ToolContext): Promise<TodoCreateOutput> {
      const id = store.create(input.title);
      return { id };
    },
  };

  const todoUpdate: Tool<TodoUpdateInput, TodoUpdateOutput> = {
    name: 'todo_update',
    description: 'Update the status or description of a todo item.',
    sequential: true,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the todo item to update.' },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'done'],
          description: 'New status.',
        },
        description: { type: 'string', description: 'Updated description.' },
      },
      required: ['id'],
    },
    async execute(input: TodoUpdateInput, _ctx: ToolContext): Promise<TodoUpdateOutput> {
      try {
        store.update(input.id, { status: input.status, description: input.description });
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      return { id: input.id };
    },
  };

  const todoList: Tool<Record<string, never>, TodoListOutput> = {
    name: 'todo_list',
    description: 'Return the current ordered todo list with ids, titles, statuses, and descriptions.',
    inputSchema: { type: 'object', properties: {} },
    async execute(_input: Record<string, never>, _ctx: ToolContext): Promise<TodoListOutput> {
      return { items: store.list() };
    },
  };

  const todoDelete: Tool<TodoDeleteInput, TodoDeleteOutput> = {
    name: 'todo_delete',
    description: 'Remove a todo item by id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id of the todo item to remove.' },
      },
      required: ['id'],
    },
    async execute(input: TodoDeleteInput, _ctx: ToolContext): Promise<TodoDeleteOutput> {
      try {
        store.delete(input.id);
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      return { id: input.id };
    },
  };

  return [todoCreate, todoUpdate, todoList, todoDelete];
}
