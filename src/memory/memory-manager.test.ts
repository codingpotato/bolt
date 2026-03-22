import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryManager } from './memory-manager';
import type { MemoryConfig } from './memory-manager';
import type { SessionStore, SessionEntry } from './session-store';
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
    // Each entry has ~40 chars of content → ~10 tokens each
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({
        role: 'user',
        content: `message-content-${i}`.padEnd(40, 'x'),
        taskId: 'task-1',
        ts: `2026-03-22T10:0${i}:00.000Z`,
        seq: i + 1,
      }),
    );
    loadSession.mockResolvedValue(entries);

    // Very small token budget — should drop oldest entries
    const manager = makeManager(
      { listSessionIds, loadSession },
      { taskHistoryTokenBudget: 30, taskHistoryMessages: 20 },
    );
    const messages = await manager.assembleInjectedHistory({
      currentSessionId: 'current',
      activeTaskId: 'task-1',
    });

    // Fewer than all 10 entries should be injected
    expect(messages.length).toBeLessThan(10);
    // The most recent entry should be included
    const contents = messages.map((m) => String(m.content));
    expect(contents[contents.length - 1]).toContain('message-content-9');
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
});
