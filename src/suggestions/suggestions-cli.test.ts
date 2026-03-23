import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleSuggestionsCli } from './suggestions-cli';
import type { Suggestion, SuggestionStore } from './suggestion-store';

vi.mock('node:fs/promises');

function makeSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    id: 'abc-123',
    createdAt: '2025-01-15T10:00:00.000Z',
    sessionId: 'session-1',
    target: 'AGENT.md',
    scope: 'project',
    content: 'Always write tests first.\nSome extra detail.',
    reason: 'TDD is the project standard.\nSeen across many interactions.',
    status: 'pending',
    ...overrides,
  };
}

function makeStore(suggestions: Suggestion[] = []): SuggestionStore {
  return {
    loadAll: vi.fn().mockResolvedValue(suggestions),
    load: vi.fn().mockImplementation((id: string) => {
      const s = suggestions.find((s) => s.id === id);
      if (!s) return Promise.reject(new Error(`not found: ${id}`));
      return Promise.resolve(s);
    }),
    write: vi.fn().mockResolvedValue('new-id'),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  } as unknown as SuggestionStore;
}

function captureOutput(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s: string) => lines.push(s) };
}

const AGENT_MD_PATHS = {
  project: '/workspace/.bolt/AGENT.md',
  user: '/home/.bolt/AGENT.md',
};

describe('suggestions list (no subcommand)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists pending suggestions with id, createdAt, scope, and first line of reason', async () => {
    const store = makeStore([makeSuggestion()]);
    const out = captureOutput();
    await handleSuggestionsCli([], store, AGENT_MD_PATHS, out.write);
    const output = out.lines.join('\n');
    expect(output).toContain('abc-123');
    expect(output).toContain('project');
    expect(output).toContain('TDD is the project standard.');
    expect(output).not.toContain('Seen across many interactions.');
  });

  it('shows only the first line of reason', async () => {
    const store = makeStore([
      makeSuggestion({ reason: 'Line one\nLine two\nLine three' }),
    ]);
    const out = captureOutput();
    await handleSuggestionsCli([], store, AGENT_MD_PATHS, out.write);
    const output = out.lines.join('\n');
    expect(output).toContain('Line one');
    expect(output).not.toContain('Line two');
  });

  it('shows only pending suggestions', async () => {
    const store = makeStore([
      makeSuggestion({ id: 'p1', status: 'pending' }),
      makeSuggestion({ id: 'a1', status: 'applied' }),
      makeSuggestion({ id: 'r1', status: 'rejected' }),
    ]);
    const out = captureOutput();
    await handleSuggestionsCli([], store, AGENT_MD_PATHS, out.write);
    const output = out.lines.join('\n');
    expect(output).toContain('p1');
    expect(output).not.toContain('a1');
    expect(output).not.toContain('r1');
  });

  it('prints a message when there are no pending suggestions', async () => {
    const store = makeStore([]);
    const out = captureOutput();
    await handleSuggestionsCli([], store, AGENT_MD_PATHS, out.write);
    expect(out.lines.join('\n')).toMatch(/no pending/i);
  });
});

describe('suggestions show <id>', () => {
  beforeEach(() => vi.clearAllMocks());

  it('prints the full content and reason', async () => {
    const store = makeStore([makeSuggestion()]);
    const out = captureOutput();
    await handleSuggestionsCli(['show', 'abc-123'], store, AGENT_MD_PATHS, out.write);
    const output = out.lines.join('\n');
    expect(output).toContain('Always write tests first.');
    expect(output).toContain('Some extra detail.');
    expect(output).toContain('TDD is the project standard.');
    expect(output).toContain('Seen across many interactions.');
  });

  it('prints an error when id is not found', async () => {
    const store = makeStore([]);
    const out = captureOutput();
    await handleSuggestionsCli(['show', 'nonexistent'], store, AGENT_MD_PATHS, out.write);
    expect(out.lines.join('\n')).toMatch(/not found/i);
  });
});

describe('suggestions apply <id>', () => {
  beforeEach(() => vi.clearAllMocks());

  it('appends content to an existing AGENT.md and sets status to applied', async () => {
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue('existing content\n' as never);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const store = makeStore([makeSuggestion()]);
    const out = captureOutput();
    await handleSuggestionsCli(['apply', 'abc-123'], store, AGENT_MD_PATHS, out.write);

    expect(writeFile).toHaveBeenCalledWith(
      AGENT_MD_PATHS.project,
      expect.stringContaining('existing content'),
      'utf-8',
    );
    expect(writeFile).toHaveBeenCalledWith(
      AGENT_MD_PATHS.project,
      expect.stringContaining('Always write tests first.'),
      'utf-8',
    );
    expect(vi.mocked(store.updateStatus)).toHaveBeenCalledWith('abc-123', 'applied');
  });

  it('creates AGENT.md when it does not exist', async () => {
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    vi.mocked(readFile).mockRejectedValue(err);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const store = makeStore([makeSuggestion()]);
    await handleSuggestionsCli(['apply', 'abc-123'], store, AGENT_MD_PATHS, captureOutput().write);

    expect(writeFile).toHaveBeenCalledWith(
      AGENT_MD_PATHS.project,
      expect.stringContaining('Always write tests first.'),
      'utf-8',
    );
    expect(vi.mocked(store.updateStatus)).toHaveBeenCalledWith('abc-123', 'applied');
  });

  it('uses the user-scoped AGENT.md path for user scope', async () => {
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue('' as never);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const store = makeStore([makeSuggestion({ scope: 'user' })]);
    await handleSuggestionsCli(['apply', 'abc-123'], store, AGENT_MD_PATHS, captureOutput().write);

    expect(writeFile).toHaveBeenCalledWith(
      AGENT_MD_PATHS.user,
      expect.any(String),
      'utf-8',
    );
  });

  it('updates status before writing file so double-apply is prevented on partial failure', async () => {
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue('' as never);
    vi.mocked(mkdir).mockResolvedValue(undefined);

    const callOrder: string[] = [];
    const store = makeStore([makeSuggestion()]);
    vi.mocked(store.updateStatus).mockImplementation(async () => { callOrder.push('updateStatus'); });
    vi.mocked(writeFile).mockImplementation(async () => { callOrder.push('writeFile'); });

    await handleSuggestionsCli(['apply', 'abc-123'], store, AGENT_MD_PATHS, captureOutput().write);

    expect(callOrder.indexOf('updateStatus')).toBeLessThan(callOrder.indexOf('writeFile'));
  });

  it('prints an error when id is not found', async () => {
    const store = makeStore([]);
    const out = captureOutput();
    await handleSuggestionsCli(['apply', 'nonexistent'], store, AGENT_MD_PATHS, out.write);
    expect(out.lines.join('\n')).toMatch(/not found/i);
  });
});

describe('suggestions reject <id>', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets status to rejected and confirms', async () => {
    const store = makeStore([makeSuggestion()]);
    const out = captureOutput();
    await handleSuggestionsCli(['reject', 'abc-123'], store, AGENT_MD_PATHS, out.write);

    expect(vi.mocked(store.updateStatus)).toHaveBeenCalledWith('abc-123', 'rejected');
    expect(out.lines.join('\n')).toContain('abc-123');
  });

  it('prints an error when id is not found', async () => {
    const store = makeStore([]);
    const out = captureOutput();
    await handleSuggestionsCli(['reject', 'nonexistent'], store, AGENT_MD_PATHS, out.write);
    expect(out.lines.join('\n')).toMatch(/not found/i);
  });
});

describe('unknown subcommand', () => {
  it('prints usage information', async () => {
    const store = makeStore([]);
    const out = captureOutput();
    await handleSuggestionsCli(['foobar'], store, AGENT_MD_PATHS, out.write);
    expect(out.lines.join('\n')).toMatch(/usage/i);
  });
});
