import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryWriteTool } from './memory-write';
import type { ToolContext } from './tool';
import { createNoopLogger } from '../logger';
import { NoopProgressReporter } from '../progress';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/workspace',
    log: { log: vi.fn().mockResolvedValue(undefined) },
    logger: createNoopLogger(),
    progress: new NoopProgressReporter(),
    ...overrides,
  };
}

describe('memory_write tool', () => {
  const writeSpy = vi.fn((_entry: Parameters<import('../memory/memory-store').MemoryStore['write']>[0]) => Promise.resolve('new-entry-id'));
  const mockStore = { write: writeSpy } as unknown as import('../memory/memory-store').MemoryStore;
  const tool = createMemoryWriteTool(mockStore);

  beforeEach(() => {
    vi.clearAllMocks();
    writeSpy.mockImplementation(() => Promise.resolve('new-entry-id'));
  });

  it('has name memory_write', () => {
    expect(tool.name).toBe('memory_write');
  });

  it('returns the id of the created entry', async () => {
    writeSpy.mockResolvedValue('abc-123');
    const result = await tool.execute({ content: 'some fact' }, makeCtx());
    expect(result.id).toBe('abc-123');
  });

  it('writes a CompactEntry with type agent_note', async () => {
    await tool.execute({ content: 'important preference' }, makeCtx());
    expect(writeSpy).toHaveBeenCalledOnce();
    const written = writeSpy.mock.calls[0]?.[0];
    expect(written?.type).toBe('agent_note');
  });

  it('sets summary to the provided content', async () => {
    await tool.execute({ content: 'prefer async/await over promise chains' }, makeCtx());
    const written = writeSpy.mock.calls[0]?.[0];
    expect(written?.summary).toBe('prefer async/await over promise chains');
  });

  it('sets tags from input when provided', async () => {
    await tool.execute({ content: 'use tabs not spaces', tags: ['style', 'formatting'] }, makeCtx());
    const written = writeSpy.mock.calls[0]?.[0];
    expect(written?.tags).toEqual(['style', 'formatting']);
  });

  it('defaults tags to empty array when not provided', async () => {
    await tool.execute({ content: 'some note' }, makeCtx());
    const written = writeSpy.mock.calls[0]?.[0];
    expect(written?.tags).toEqual([]);
  });

  it('carries sessionId from context', async () => {
    const ctx = makeCtx({ sessionId: 'session-xyz' });
    await tool.execute({ content: 'note with session' }, ctx);
    const written = writeSpy.mock.calls[0]?.[0];
    expect(written?.sessionId).toBe('session-xyz');
  });

  it('carries activeTaskId from context when set', async () => {
    const ctx = makeCtx({ sessionId: 'session-1', activeTaskId: 'task-42' });
    await tool.execute({ content: 'task-specific note' }, ctx);
    const written = writeSpy.mock.calls[0]?.[0];
    expect(written?.taskId).toBe('task-42');
  });

  it('omits taskId when no active task', async () => {
    const ctx = makeCtx({ sessionId: 'session-1' });
    await tool.execute({ content: 'general note' }, ctx);
    const written = writeSpy.mock.calls[0]?.[0];
    expect(written?.taskId).toBeUndefined();
  });

  it('uses empty string for sessionId when context has none', async () => {
    const ctx = makeCtx();
    await tool.execute({ content: 'note without session' }, ctx);
    const written = writeSpy.mock.calls[0]?.[0];
    expect(written?.sessionId).toBe('');
  });
});
