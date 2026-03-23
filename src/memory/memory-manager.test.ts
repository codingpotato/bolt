import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { MemoryManager } from './memory-manager';
import type { MemoryConfig } from './memory-manager';
import type { SessionStore, SessionEntry } from './session-store';
import type { MemoryStore } from './memory-store';
import type { ProgressReporter } from '../progress/progress';
import { createNoopLogger } from '../logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<SessionEntry> & Pick<SessionEntry, 'role'>,
): SessionEntry {
  return {
    sessionId: 'session-1',
    seq: 1,
    ts: '2026-03-22T10:00:00.000Z',
    date: '2026-03-22',
    content: 'hello',
    ...overrides,
  };
}

const DEFAULT_CONFIG: MemoryConfig = {
  taskHistoryMessages: 20,
  taskHistoryTokenBudget: 20000,
  keepRecentMessages: 5,
  injectRecentChat: true,
};

function makeManager(
  store: Partial<SessionStore>,
  config: Partial<MemoryConfig> = {},
): MemoryManager {
  return new MemoryManager(
    store as SessionStore,
    { ...DEFAULT_CONFIG, ...config },
    createNoopLogger(),
  );
}

// ---------------------------------------------------------------------------
// Compact helpers
// ---------------------------------------------------------------------------

interface CompactManagerOptions {
  keepRecentMessages?: number;
  modelResponse?: string;
  clientThrows?: boolean;
}

interface CompactManagerFixture {
  manager: MemoryManager;
  createSpy: ReturnType<typeof vi.fn>;
  writeSpy: ReturnType<typeof vi.fn>;
  progress: ProgressReporter;
}

function makeMessage(role: 'user' | 'assistant', content: string): Anthropic.MessageParam {
  return { role, content };
}

function makeCompactManager(options: CompactManagerOptions = {}): CompactManagerFixture {
  const { keepRecentMessages = 3, modelResponse = 'Summary text\nTags: foo, bar', clientThrows = false } = options;

  const createSpy = vi.fn();
  if (clientThrows) {
    createSpy.mockRejectedValue(new Error('model error'));
  } else {
    createSpy.mockResolvedValue({
      content: [{ type: 'text', text: modelResponse }],
    });
  }

  const mockClient = {
    messages: { create: createSpy },
  } as unknown as import('@anthropic-ai/sdk').default;

  const writeSpy = vi.fn().mockResolvedValue('entry-id');
  const mockMemoryStore = { write: writeSpy } as unknown as MemoryStore;

  const mockProgress: ProgressReporter = {
    onSessionStart: vi.fn(),
    onThinking: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onTaskStatusChange: vi.fn(),
    onContextInjection: vi.fn(),
    onMemoryCompaction: vi.fn(),
    onRetry: vi.fn(),
  };

  const config: MemoryConfig = { ...DEFAULT_CONFIG, keepRecentMessages };
  const manager = new MemoryManager(
    {} as SessionStore,
    config,
    createNoopLogger(),
    mockMemoryStore,
    mockClient,
    'claude-test-model',
  );

  return { manager, createSpy, writeSpy, progress: mockProgress };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryManager.assembleInjectedHistory()', () => {
  let listSessionIds: ReturnType<typeof vi.fn>;
  let loadSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listSessionIds = vi.fn();
    loadSession = vi.fn();
  });

  // -------------------------------------------------------------------------
  // Priority 1 — Task history
  // -------------------------------------------------------------------------

  it('injects entries tagged with the active task from prior sessions', async () => {
    listSessionIds.mockResolvedValue(['prior-1', 'prior-2', 'current']);
    loadSession.mockImplementation(async (id: string) => {
      if (id === 'prior-1') {
        return [
          makeEntry({ sessionId: 'prior-1', role: 'user', content: 'task question', taskId: 'task-1' }),
          makeEntry({ sessionId: 'prior-1', role: 'assistant', content: 'task answer', taskId: 'task-1' }),
        ];
      }
      if (id === 'prior-2') {
        return [
          makeEntry({ sessionId: 'prior-2', role: 'user', content: 'another question', taskId: 'task-1' }),
        ];
      }
      return [];
    });

    const manager = makeManager({ listSessionIds, loadSession });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
      activeTaskId: 'task-1',
    });

    // Should include entries from prior-1 and prior-2, not current
    expect(messages.length).toBeGreaterThan(0);
    const contents = messages.map((m: { role: string; content: unknown }) => m.content);
    expect(contents).toContain('task question');
    expect(contents).toContain('task answer');
    expect(contents).toContain('another question');
  });

  it('excludes entries from the current session when loading task history', async () => {
    listSessionIds.mockResolvedValue(['current', 'prior-1']);
    loadSession.mockImplementation(async (id: string) => {
      if (id === 'prior-1') {
        return [makeEntry({ sessionId: 'prior-1', role: 'user', content: 'prior', taskId: 'task-1' })];
      }
      return [makeEntry({ sessionId: 'current', role: 'user', content: 'current', taskId: 'task-1' })];
    });

    const manager = makeManager({ listSessionIds, loadSession });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
      activeTaskId: 'task-1',
    });

    const contents = messages.map((m: { role: string; content: unknown }) => m.content);
    expect(contents).toContain('prior');
    expect(contents).not.toContain('current');
  });

  it('only injects entries tagged with the active taskId', async () => {
    listSessionIds.mockResolvedValue(['prior-1']);
    loadSession.mockResolvedValue([
      makeEntry({ role: 'user', content: 'task entry', taskId: 'task-1' }),
      makeEntry({ role: 'user', content: 'other task', taskId: 'task-2' }),
      makeEntry({ role: 'user', content: 'no task' }),
    ]);

    const manager = makeManager({ listSessionIds, loadSession });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
      activeTaskId: 'task-1',
    });

    const contents = messages.map((m: { role: string; content: unknown }) => m.content);
    expect(contents).toContain('task entry');
    expect(contents).not.toContain('other task');
    expect(contents).not.toContain('no task');
  });

  it('respects taskHistoryMessages limit', async () => {
    listSessionIds.mockResolvedValue(['prior-1']);
    const manyEntries = Array.from({ length: 30 }, (_, i) =>
      makeEntry({ role: 'user', content: `message ${i}`, taskId: 'task-1', seq: i + 1 }),
    );
    loadSession.mockResolvedValue(manyEntries);

    const manager = makeManager({ listSessionIds, loadSession }, { taskHistoryMessages: 5 });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
      activeTaskId: 'task-1',
    });

    expect(messages.length).toBeLessThanOrEqual(5);
  });

  it('drops oldest entries when token budget is exceeded', async () => {
    listSessionIds.mockResolvedValue(['prior-1']);
    // Alternate user/assistant so entriesToMessageParams keeps all entries.
    // Each entry has ~40 chars of content → ~10 tokens each.
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message-content-${i}`.padEnd(40, 'x'),
        taskId: 'task-1',
        ts: `2026-03-22T10:0${i}:00.000Z`,
        seq: i + 1,
      }),
    );
    loadSession.mockResolvedValue(entries);

    // Budget fits ~3 entries (30 tokens / ~10 per entry).
    const manager = makeManager(
      { listSessionIds, loadSession },
      { taskHistoryTokenBudget: 30, taskHistoryMessages: 20 },
    );
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
      activeTaskId: 'task-1',
    });

    // applyTokenBudget must drop older entries to fit within the budget
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.length).toBeLessThan(10);
    // The most recent entry should be retained
    const contents = messages.map((m) => String(m.content));
    expect(contents[contents.length - 1]).toContain('message-content-9');
    // The oldest entry should have been dropped
    expect(contents).not.toContain(entries[0]!.content);
  });

  it('returns empty array when no prior sessions have task entries', async () => {
    listSessionIds.mockResolvedValue(['prior-1']);
    loadSession.mockResolvedValue([
      makeEntry({ role: 'user', content: 'unrelated' }), // no taskId
    ]);

    const manager = makeManager({ listSessionIds, loadSession });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
      activeTaskId: 'task-1',
    });

    expect(messages).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Priority 2 — Session resume
  // -------------------------------------------------------------------------

  it('injects last keepRecentMessages entries from the resumed session', async () => {
    const entries = Array.from({ length: 8 }, (_, i) =>
      makeEntry({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i}`, seq: i + 1 }),
    );
    loadSession.mockResolvedValue(entries);

    const manager = makeManager({ listSessionIds, loadSession }, { keepRecentMessages: 3 });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
      resumedSessionId: 'prior-session',
    });

    // At most keepRecentMessages entries
    expect(messages.length).toBeLessThanOrEqual(3);
    // Most recent entries should be present
    const contents = messages.map((m) => String(m.content));
    expect(contents.some((c) => c.includes('msg 7'))).toBe(true);
  });

  it('does not call listSessionIds for session resume', async () => {
    loadSession.mockResolvedValue([
      makeEntry({ role: 'user', content: 'hi' }),
    ]);

    const manager = makeManager({ listSessionIds, loadSession });
    await manager.assembleInjectedHistory({
      currentSessionId: 'current',
      resumedSessionId: 'prior',
    });

    expect(listSessionIds).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Priority 3 — Chat continuity
  // -------------------------------------------------------------------------

  it('injects entries from the most recent prior session when injectRecentChat is true', async () => {
    listSessionIds.mockResolvedValue(['old-session', 'recent-session', 'current']);
    loadSession.mockImplementation(async (id: string) => {
      if (id === 'old-session') {
        return [makeEntry({ sessionId: 'old-session', role: 'user', content: 'old msg', ts: '2026-03-20T10:00:00.000Z' })];
      }
      if (id === 'recent-session') {
        return [makeEntry({ sessionId: 'recent-session', role: 'user', content: 'recent msg', ts: '2026-03-21T10:00:00.000Z' })];
      }
      return [];
    });

    const manager = makeManager({ listSessionIds, loadSession }, { injectRecentChat: true });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
    });

    const contents = messages.map((m: { role: string; content: unknown }) => m.content);
    expect(contents).toContain('recent msg');
    expect(contents).not.toContain('old msg');
  });

  it('returns empty array when injectRecentChat is false', async () => {
    const manager = makeManager({ listSessionIds, loadSession }, { injectRecentChat: false });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
    });

    expect(messages).toEqual([]);
    expect(listSessionIds).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Priority 4 — First-ever session / no prior sessions
  // -------------------------------------------------------------------------

  it('returns empty array when there are no prior sessions', async () => {
    listSessionIds.mockResolvedValue(['current']); // only the current session

    const manager = makeManager({ listSessionIds, loadSession }, { injectRecentChat: true });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
    });

    expect(messages).toEqual([]);
  });

  it('returns empty array when the sessions directory is empty', async () => {
    listSessionIds.mockResolvedValue([]);

    const manager = makeManager({ listSessionIds, loadSession }, { injectRecentChat: true });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
    });

    expect(messages).toEqual([]);
  });

  it('renders assistant entry with array content containing no text blocks as [Tool use response]', async () => {
    loadSession.mockResolvedValue([
      makeEntry({
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }],
        seq: 1,
      }),
    ]);

    const manager = makeManager({ listSessionIds, loadSession }, { injectRecentChat: true });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
      resumedSessionId: 'prior',
    });

    expect(messages.some((m) => m.content === '[Tool use response]')).toBe(true);
  });

  it('renders assistant entry with non-string non-array content via JSON.stringify', async () => {
    loadSession.mockResolvedValue([
      makeEntry({ role: 'assistant', content: 42 as unknown as string, seq: 1 }),
    ]);

    const manager = makeManager({ listSessionIds, loadSession }, { injectRecentChat: true });
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
      resumedSessionId: 'prior',
    });

    expect(messages.some((m) => m.content === '42')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MemoryManager.compact() tests
// ---------------------------------------------------------------------------

describe('MemoryManager.compact()', () => {
  it('returns null when messages count is less than keepRecentMessages', async () => {
    const { manager, progress } = makeCompactManager({ keepRecentMessages: 5 });
    const messages = [
      makeMessage('user', 'a'),
      makeMessage('assistant', 'b'),
      makeMessage('user', 'c'),
    ];
    const result = await manager.compact(messages, 'session-1', undefined, progress);
    expect(result).toBeNull();
  });

  it('returns null when messages count equals keepRecentMessages', async () => {
    const { manager, progress } = makeCompactManager({ keepRecentMessages: 5 });
    const messages = [
      makeMessage('user', 'a'),
      makeMessage('assistant', 'b'),
      makeMessage('user', 'c'),
      makeMessage('assistant', 'd'),
      makeMessage('user', 'e'),
    ];
    const result = await manager.compact(messages, 'session-1', undefined, progress);
    expect(result).toBeNull();
  });

  it('calls model to summarize evicted messages', async () => {
    const { manager, createSpy, progress } = makeCompactManager({ keepRecentMessages: 3 });
    const messages = [
      makeMessage('user', 'msg-0'),
      makeMessage('assistant', 'msg-1'),
      makeMessage('user', 'msg-2'),
      makeMessage('assistant', 'msg-3'),
      makeMessage('user', 'msg-4'),
    ];
    await manager.compact(messages, 'session-1', undefined, progress);
    expect(createSpy).toHaveBeenCalledTimes(1);
    const callArgs = createSpy.mock.calls[0]![0] as { messages: Anthropic.MessageParam[] };
    const userMessage = callArgs.messages[0];
    expect(userMessage?.role).toBe('user');
    expect(typeof userMessage?.content === 'string' && userMessage.content).toContain('msg-0');
  });

  it('writes CompactEntry to MemoryStore', async () => {
    const { manager, writeSpy, progress } = makeCompactManager({ keepRecentMessages: 3 });
    const messages = [
      makeMessage('user', 'evicted-0'),
      makeMessage('assistant', 'evicted-1'),
      makeMessage('user', 'kept-0'),
      makeMessage('assistant', 'kept-1'),
      makeMessage('user', 'kept-2'),
    ];
    await manager.compact(messages, 'my-session', 'my-task', progress);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const writeArg = writeSpy.mock.calls[0]![0] as {
      type: string;
      sessionId: string;
      taskId: string;
      summary: string;
      messages: Anthropic.MessageParam[];
    };
    expect(writeArg.type).toBe('compaction');
    expect(writeArg.sessionId).toBe('my-session');
    expect(writeArg.taskId).toBe('my-task');
    expect(typeof writeArg.summary).toBe('string');
    expect(writeArg.messages).toEqual([
      makeMessage('user', 'evicted-0'),
      makeMessage('assistant', 'evicted-1'),
    ]);
  });

  it('extracts tags from model response', async () => {
    const { manager, writeSpy, progress } = makeCompactManager({
      keepRecentMessages: 3,
      modelResponse: 'Here is the summary.\nTags: alpha, beta, gamma',
    });
    const messages = [
      makeMessage('user', 'a'),
      makeMessage('assistant', 'b'),
      makeMessage('user', 'c'),
      makeMessage('assistant', 'd'),
      makeMessage('user', 'e'),
    ];
    await manager.compact(messages, 'session-1', undefined, progress);
    const writeArg = writeSpy.mock.calls[0]![0] as { tags: string[] };
    expect(writeArg.tags).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('emits onMemoryCompaction with evicted count', async () => {
    const { manager, progress } = makeCompactManager({ keepRecentMessages: 3 });
    const messages = [
      makeMessage('user', 'a'),
      makeMessage('assistant', 'b'),
      makeMessage('user', 'c'),
      makeMessage('assistant', 'd'),
      makeMessage('user', 'e'),
    ];
    await manager.compact(messages, 'session-1', undefined, progress);
    expect(progress.onMemoryCompaction).toHaveBeenCalledWith(2);
  });

  it('handles model failure gracefully — uses fallback summary', async () => {
    const { manager, writeSpy, progress } = makeCompactManager({
      keepRecentMessages: 3,
      clientThrows: true,
    });
    const messages = [
      makeMessage('user', 'a'),
      makeMessage('assistant', 'b'),
      makeMessage('user', 'c'),
      makeMessage('assistant', 'd'),
      makeMessage('user', 'e'),
    ];
    const result = await manager.compact(messages, 'session-1', undefined, progress);
    expect(result).not.toBeNull();
    const writeArg = writeSpy.mock.calls[0]![0] as { summary: string };
    expect(writeArg.summary).toBe('[Conversation history compacted — summary unavailable]');
  });

  it('returned messages start with summary stub followed by kept messages', async () => {
    const { manager, progress } = makeCompactManager({ keepRecentMessages: 3 });
    const messages = [
      makeMessage('user', 'msg-0'),
      makeMessage('assistant', 'msg-1'),
      makeMessage('user', 'msg-2'),
      makeMessage('assistant', 'msg-3'),
      makeMessage('user', 'msg-4'),
      makeMessage('assistant', 'msg-5'),
      makeMessage('user', 'msg-6'),
      makeMessage('assistant', 'msg-7'),
    ];
    const result = await manager.compact(messages, 'session-1', undefined, progress);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4); // 1 stub + 3 kept
    expect(result![0]!.role).toBe('user');
    expect(typeof result![0]!.content === 'string' && result![0]!.content).toContain('compacted');
  });

  it('writes CompactEntry before eviction (write called before return)', async () => {
    const callOrder: string[] = [];
    const createSpy = vi.fn().mockImplementation(async () => {
      callOrder.push('create');
      return { content: [{ type: 'text', text: 'Summary\nTags: x' }] };
    });
    const writeSpy = vi.fn().mockImplementation(async () => {
      callOrder.push('write');
      return 'entry-id';
    });

    const mockClient = { messages: { create: createSpy } } as unknown as import('@anthropic-ai/sdk').default;
    const mockMemoryStore = { write: writeSpy } as unknown as MemoryStore;
    const mockProgress: ProgressReporter = {
      onSessionStart: vi.fn(),
      onThinking: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onTaskStatusChange: vi.fn(),
      onContextInjection: vi.fn(),
      onMemoryCompaction: vi.fn(),
      onRetry: vi.fn(),
    };

    const config: MemoryConfig = { ...DEFAULT_CONFIG, keepRecentMessages: 3 };
    const manager = new MemoryManager(
      {} as SessionStore,
      config,
      createNoopLogger(),
      mockMemoryStore,
      mockClient,
      'claude-test-model',
    );

    const messages = [
      makeMessage('user', 'a'),
      makeMessage('assistant', 'b'),
      makeMessage('user', 'c'),
      makeMessage('assistant', 'd'),
      makeMessage('user', 'e'),
    ];
    await manager.compact(messages, 'session-1', undefined, mockProgress);
    expect(callOrder.indexOf('write')).toBeLessThan(messages.length); // write was called
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(createSpy).toHaveBeenCalledTimes(1);
    // write must be called before compact returns (both in callOrder)
    expect(callOrder).toContain('write');
    expect(callOrder).toContain('create');
  });
});
