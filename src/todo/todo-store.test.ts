import { describe, it, expect, beforeEach } from 'vitest';
import { TodoStore } from './todo-store';

describe('TodoStore', () => {
  let store: TodoStore;

  beforeEach(() => {
    store = new TodoStore();
  });

  describe('create', () => {
    it('returns a unique id', () => {
      const id1 = store.create('first task');
      const id2 = store.create('second task');
      expect(id1).toBeTruthy();
      expect(id2).toBeTruthy();
      expect(id1).not.toBe(id2);
    });

    it('adds item with pending status and given title', () => {
      const id = store.create('my task');
      const items = store.list();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ id, title: 'my task', status: 'pending' });
    });

    it('preserves insertion order in list', () => {
      store.create('alpha');
      store.create('beta');
      store.create('gamma');
      expect(store.list().map((i: { title: string }) => i.title)).toEqual([
        'alpha',
        'beta',
        'gamma',
      ]);
    });
  });

  describe('update', () => {
    it('updates status', () => {
      const id = store.create('task');
      store.update(id, { status: 'in_progress' });
      expect(store.list()[0]?.status).toBe('in_progress');
    });

    it('updates description', () => {
      const id = store.create('task');
      store.update(id, { description: 'some details' });
      expect(store.list()[0]?.description).toBe('some details');
    });

    it('can update both status and description at once', () => {
      const id = store.create('task');
      store.update(id, { status: 'done', description: 'finished' });
      expect(store.list()[0]).toMatchObject({ status: 'done', description: 'finished' });
    });

    it('throws when id is not found', () => {
      expect(() => store.update('nonexistent', { status: 'done' })).toThrow('todo not found');
    });
  });

  describe('list', () => {
    it('returns empty array when no todos', () => {
      expect(store.list()).toEqual([]);
    });

    it('returns a snapshot — mutations to the returned array do not affect the store', () => {
      store.create('task');
      const items = store.list();
      items.pop();
      expect(store.list()).toHaveLength(1);
    });

    it('returns item copies — mutating a returned item does not affect the store', () => {
      const id = store.create('task');
      const item = store.list()[0];
      if (item) item.status = 'done';
      expect(store.list().find((i: { id: string }) => i.id === id)?.status).toBe('pending');
    });
  });

  describe('delete', () => {
    it('removes an item by id', () => {
      const id = store.create('task');
      store.delete(id);
      expect(store.list()).toHaveLength(0);
    });

    it('throws when id is not found', () => {
      expect(() => store.delete('nonexistent')).toThrow('todo not found');
    });

    it('only removes the targeted item', () => {
      store.create('keep');
      const id = store.create('remove');
      store.create('also keep');
      store.delete(id);
      expect(store.list().map((i: { title: string }) => i.title)).toEqual(['keep', 'also keep']);
    });
  });
});
