import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SuggestionStore } from './suggestion-store';
import type { Suggestion } from './suggestion-store';
import { createNoopLogger } from '../logger';

vi.mock('node:fs/promises');

const STORE_DIR = '/data/suggestions';

function makeStore(): SuggestionStore {
  return new SuggestionStore(STORE_DIR, createNoopLogger());
}

function makeSuggestion(overrides: Partial<Omit<Suggestion, 'id' | 'createdAt'>> = {}): Omit<Suggestion, 'id' | 'createdAt'> {
  return {
    sessionId: 'session-1',
    target: 'AGENT.md',
    content: 'Always write tests before implementation.',
    reason: 'The agent has observed TDD is the project standard.',
    status: 'pending',
    ...overrides,
  };
}

describe('SuggestionStore.write()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates the suggestions directory', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    await makeStore().write(makeSuggestion());

    expect(mkdir).toHaveBeenCalledWith(STORE_DIR, { recursive: true });
  });

  it('writes a JSON file named <id>.json', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    const id = await makeStore().write(makeSuggestion());

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const [path, content] = vi.mocked(writeFile).mock.calls[0] as [string, string, string];
    expect(path).toBe(`${STORE_DIR}/${id}.json`);
    const parsed = JSON.parse(content) as Suggestion;
    expect(parsed.id).toBe(id);
    expect(parsed.status).toBe('pending');
  });

  it('stamps createdAt on the entry', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    await makeStore().write(makeSuggestion());

    const [, content] = vi.mocked(writeFile).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content) as Suggestion;
    expect(parsed.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('includes taskId when provided', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    await makeStore().write(makeSuggestion({ taskId: 'task-99' }));

    const [, content] = vi.mocked(writeFile).mock.calls[0] as [string, string, string];
    const parsed = JSON.parse(content) as Suggestion;
    expect(parsed.taskId).toBe('task-99');
  });
});

describe('SuggestionStore.loadAll()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty array when directory does not exist', async () => {
    const { readdir } = await import('node:fs/promises');
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(readdir).mockRejectedValue(err);

    const results = await makeStore().loadAll();
    expect(results).toEqual([]);
  });

  it('loads valid suggestion files', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    const suggestion: Suggestion = {
      id: 'abc-123',
      createdAt: '2025-01-15T10:00:00.000Z',
      sessionId: 'session-1',
      target: 'AGENT.md',
      content: 'some content',
      reason: 'some reason',
      status: 'pending',
    };
    vi.mocked(readdir).mockResolvedValue(['abc-123.json'] as never);
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(suggestion) as never);

    const results = await makeStore().loadAll();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(suggestion);
  });

  it('skips non-.json files', async () => {
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue(['.DS_Store', 'README.md'] as never);

    const results = await makeStore().loadAll();
    expect(results).toEqual([]);
  });

  it('skips corrupt JSON files with a warning', async () => {
    const { readdir, readFile } = await import('node:fs/promises');
    vi.mocked(readdir).mockResolvedValue(['bad.json'] as never);
    vi.mocked(readFile).mockResolvedValue('not valid json' as never);

    const results = await makeStore().loadAll();
    expect(results).toEqual([]);
  });
});

describe('SuggestionStore.load()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the suggestion for a known id', async () => {
    const { readFile } = await import('node:fs/promises');
    const suggestion: Suggestion = {
      id: 'abc-123',
      createdAt: '2025-01-15T10:00:00.000Z',
      sessionId: 'session-1',
      target: 'AGENT.md',
      content: 'content',
      reason: 'reason',
      status: 'pending',
    };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(suggestion) as never);

    const result = await makeStore().load('abc-123');
    expect(result).toEqual(suggestion);
  });

  it('throws when file is not found', async () => {
    const { readFile } = await import('node:fs/promises');
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(readFile).mockRejectedValue(err);

    await expect(makeStore().load('missing-id')).rejects.toThrow('missing-id');
  });
});

describe('SuggestionStore.updateStatus()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rewrites the file with the new status', async () => {
    const { readFile, writeFile } = await import('node:fs/promises');
    const suggestion: Suggestion = {
      id: 'abc-123',
      createdAt: '2025-01-15T10:00:00.000Z',
      sessionId: 'session-1',
      target: 'AGENT.md',
      content: 'content',
      reason: 'reason',
      status: 'pending',
    };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(suggestion) as never);
    vi.mocked(writeFile).mockResolvedValue(undefined);

    await makeStore().updateStatus('abc-123', 'applied');

    const [, written] = vi.mocked(writeFile).mock.calls[0] as [string, string, string];
    expect(JSON.parse(written)).toMatchObject({ id: 'abc-123', status: 'applied' });
  });
});
