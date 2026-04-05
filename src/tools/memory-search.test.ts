import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemorySearchTool } from './memory-search';
import type { CompactEntry } from '../memory/memory-store';
import type { ToolContext } from './tool';
import { createNoopLogger } from '../logger';
import { NoopProgressReporter } from '../progress';

function makeEntry(overrides: Partial<CompactEntry>): CompactEntry {
  return {
    id: 'entry-1',
    type: 'compaction',
    sessionId: 'session-1',
    createdAt: '2025-01-15T10:00:00.000Z',
    date: '2025-01-15',
    summary: 'some summary text',
    tags: [],
    ...overrides,
  };
}

function makeCtx(): ToolContext {
  return {
    cwd: '/workspace',
    log: { log: vi.fn().mockResolvedValue(undefined) },
    logger: createNoopLogger(),
    progress: new NoopProgressReporter(),
  };
}

describe('memory_search tool', () => {
  const getAllSpy = vi.fn(() => [] as CompactEntry[]);
  const mockStore = {
    getAll: getAllSpy,
  } as unknown as import('../memory/memory-store').MemoryStore;
  const tool = createMemorySearchTool(mockStore);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has name memory_search', () => {
    expect(tool.name).toBe('memory_search');
  });

  it('returns empty entries when store is empty', async () => {
    getAllSpy.mockReturnValue([]);
    const result = await tool.execute({ query: 'anything' }, makeCtx());
    expect(result.entries).toEqual([]);
  });

  it('returns empty entries (not an error) when no matches found', async () => {
    getAllSpy.mockReturnValue([makeEntry({ summary: 'completely unrelated content', tags: [] })]);
    const result = await tool.execute({ query: 'xyzzy unique token' }, makeCtx());
    expect(result.entries).toEqual([]);
  });

  it('returns matching entries ranked by relevance', async () => {
    getAllSpy.mockReturnValue([
      makeEntry({ id: 'e1', summary: 'typescript compiler errors', tags: ['typescript'] }),
      makeEntry({ id: 'e2', summary: 'unrelated database stuff', tags: ['sql'] }),
      makeEntry({
        id: 'e3',
        summary: 'typescript types and interfaces',
        tags: ['typescript', 'types'],
      }),
    ]);
    const result = await tool.execute({ query: 'typescript', limit: 5 }, makeCtx());
    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain('e1');
    expect(ids).toContain('e3');
    expect(ids).not.toContain('e2');
  });

  it('respects limit parameter', async () => {
    getAllSpy.mockReturnValue([
      makeEntry({ id: 'e1', summary: 'alpha beta gamma', tags: ['alpha'] }),
      makeEntry({ id: 'e2', summary: 'alpha delta epsilon', tags: ['alpha'] }),
      makeEntry({ id: 'e3', summary: 'alpha zeta eta', tags: ['alpha'] }),
    ]);
    const result = await tool.execute({ query: 'alpha', limit: 2 }, makeCtx());
    expect(result.entries.length).toEqual(2);
  });

  it('defaults to limit 5', async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ id: `e${i}`, summary: `apple entry number ${i}`, tags: ['apple'] }),
    );
    getAllSpy.mockReturnValue(entries);
    const result = await tool.execute({ query: 'apple' }, makeCtx());
    expect(result.entries.length).toEqual(5);
  });

  it('filters by taskId', async () => {
    getAllSpy.mockReturnValue([
      makeEntry({
        id: 'e1',
        summary: 'refactoring the auth module',
        tags: ['auth'],
        taskId: 'task-A',
      }),
      makeEntry({
        id: 'e2',
        summary: 'refactoring the payment module',
        tags: ['payment'],
        taskId: 'task-B',
      }),
      makeEntry({
        id: 'e3',
        summary: 'refactoring the cache layer',
        tags: ['cache'],
        taskId: 'task-A',
      }),
    ]);
    const result = await tool.execute(
      { query: 'refactoring', taskId: 'task-A', limit: 10 },
      makeCtx(),
    );
    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain('e1');
    expect(ids).toContain('e3');
    expect(ids).not.toContain('e2');
  });

  it('filters by dateFrom', async () => {
    getAllSpy.mockReturnValue([
      makeEntry({ id: 'e1', summary: 'deploy pipeline fix', tags: [], date: '2025-01-10' }),
      makeEntry({ id: 'e2', summary: 'deploy configuration update', tags: [], date: '2025-01-20' }),
    ]);
    const result = await tool.execute(
      { query: 'deploy', dateFrom: '2025-01-15', limit: 10 },
      makeCtx(),
    );
    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain('e2');
    expect(ids).not.toContain('e1');
  });

  it('filters by dateTo', async () => {
    getAllSpy.mockReturnValue([
      makeEntry({ id: 'e1', summary: 'deploy pipeline fix', tags: [], date: '2025-01-10' }),
      makeEntry({ id: 'e2', summary: 'deploy configuration update', tags: [], date: '2025-01-20' }),
    ]);
    const result = await tool.execute(
      { query: 'deploy', dateTo: '2025-01-15', limit: 10 },
      makeCtx(),
    );
    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain('e1');
    expect(ids).not.toContain('e2');
  });

  it('filters by both dateFrom and dateTo', async () => {
    getAllSpy.mockReturnValue([
      makeEntry({ id: 'e1', summary: 'cache invalidation bug', tags: [], date: '2025-01-01' }),
      makeEntry({ id: 'e2', summary: 'cache warm up logic', tags: [], date: '2025-01-10' }),
      makeEntry({ id: 'e3', summary: 'cache eviction policy', tags: [], date: '2025-01-20' }),
    ]);
    const result = await tool.execute(
      {
        query: 'cache',
        dateFrom: '2025-01-05',
        dateTo: '2025-01-15',
        limit: 10,
      },
      makeCtx(),
    );
    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain('e2');
    expect(ids).not.toContain('e1');
    expect(ids).not.toContain('e3');
  });

  it('matches query terms in tags', async () => {
    getAllSpy.mockReturnValue([
      makeEntry({ id: 'e1', summary: 'general discussion', tags: ['database', 'postgres'] }),
      makeEntry({ id: 'e2', summary: 'general discussion', tags: ['frontend', 'react'] }),
    ]);
    const result = await tool.execute({ query: 'postgres', limit: 10 }, makeCtx());
    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain('e1');
    expect(ids).not.toContain('e2');
  });

  it('returns entries with correct shape', async () => {
    getAllSpy.mockReturnValue([
      makeEntry({
        id: 'e1',
        type: 'agent_note',
        summary: 'important fact about the system',
        tags: ['system'],
        taskId: 'task-1',
        createdAt: '2025-01-15T10:00:00.000Z',
      }),
    ]);
    const result = await tool.execute({ query: 'important fact', limit: 5 }, makeCtx());
    expect(result.entries).toHaveLength(1);
    const entry = result.entries[0];
    expect(entry).toMatchObject({
      id: 'e1',
      type: 'agent_note',
      summary: 'important fact about the system',
      tags: ['system'],
      taskId: 'task-1',
      createdAt: '2025-01-15T10:00:00.000Z',
    });
  });

  it('higher relevance entries appear first', async () => {
    getAllSpy.mockReturnValue([
      makeEntry({ id: 'low', summary: 'error occurred during startup', tags: [] }),
      makeEntry({ id: 'high', summary: 'error error error multiple occurrences', tags: ['error'] }),
    ]);
    const result = await tool.execute({ query: 'error', limit: 5 }, makeCtx());
    expect(result.entries[0]?.id).toBe('high');
  });
});
