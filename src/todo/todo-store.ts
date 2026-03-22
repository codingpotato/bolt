export type TodoStatus = 'pending' | 'in_progress' | 'done';

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
  description?: string;
}

export class TodoStore {
  private readonly items: Map<string, TodoItem> = new Map();
  private counter = 0;

  create(title: string): string {
    const id = `todo-${++this.counter}`;
    this.items.set(id, { id, title, status: 'pending' });
    return id;
  }

  update(id: string, changes: { status?: TodoStatus; description?: string }): void {
    const item = this.items.get(id);
    if (!item) throw new Error(`todo not found: ${id}`);
    if (changes.status !== undefined) item.status = changes.status;
    if (changes.description !== undefined) item.description = changes.description;
  }

  list(): TodoItem[] {
    return Array.from(this.items.values()).map((item) => ({ ...item }));
  }

  delete(id: string): void {
    if (!this.items.has(id)) throw new Error(`todo not found: ${id}`);
    this.items.delete(id);
  }
}
