import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStore } from './session-store';
import type { SessionEntry } from './session-store';
import { createNoopLogger } from '../logger';

// ---------------------------------------------------------------------------
// In-memory filesystem mock
// ---------------------------------------------------------------------------

let files: Record<string, string> = {};
let dirs: Set<string> = new Set();

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async (path: string) => {
    dirs.add(String(path));
  }),
  appendFile: vi.fn(async (path: string, data: string) => {
    const p = String(path);
    files[p] = (files[p] ?? '') + data;
  }),
  readFile: vi.fn(async (path: string) => {
    const p = String(path);
    if (!(p in files)) {
      const err = Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      throw err;
    }
    return files[p];
  }),
  readdir: vi.fn(async (dir: string) => {
    const prefix = String(dir).endsWith('/') ? String(dir) : String(dir) + '/';
    return Object.keys(files)
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map((p) => p.slice(prefix.length));
  }),
}));

beforeEach(() => {
  files = {};
  dirs = new Set();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-uuid';
const SESSIONS_DIR = '/tmp/sessions';

/** The date file path for today's UTC date */
function todayFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${SESSIONS_DIR}/${date}.jsonl`;
}

function makeStore(): SessionStore {
  return new SessionStore(SESSIONS_DIR, createNoopLogger());
}

function makeEntry(
  overrides: Partial<Omit<SessionEntry, 'seq' | 'ts' | 'date'>> = {},
): Omit<SessionEntry, 'seq' | 'ts' | 'date'> {
  return {
    sessionId: SESSION_ID,
    role: 'user',
    content: 'hello',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// append
// ---------------------------------------------------------------------------

describe('SessionStore.append', () => {
  it('writes a JSON line to the date-based file (YYYY-MM-DD.jsonl)', async () => {
    const store = makeStore();
    await store.append(makeEntry());

    const filePath = todayFile();
    expect(files[filePath]).toBeDefined();
    const line = files[filePath]!.trim();
    const parsed = JSON.parse(line) as SessionEntry;
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.role).toBe('user');
    expect(parsed.content).toBe('hello');
  });

  it('does NOT write to a per-session UUID file', async () => {
    const store = makeStore();
    await store.append(makeEntry());

    const sessionFile = `${SESSIONS_DIR}/${SESSION_ID}.jsonl`;
    expect(files[sessionFile]).toBeUndefined();
  });

  it('stamps seq, ts, and date', async () => {
    const store = makeStore();
    await store.append(makeEntry());

    const parsed = JSON.parse(files[todayFile()]!.trim()) as SessionEntry;
    expect(parsed.seq).toBe(1);
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('increments seq for each append in the same session', async () => {
    const store = makeStore();
    await store.append(makeEntry({ role: 'user' }));
    await store.append(makeEntry({ role: 'assistant' }));

    const lines = files[todayFile()]!.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]!) as SessionEntry).seq).toBe(1);
    expect((JSON.parse(lines[1]!) as SessionEntry).seq).toBe(2);
  });

  it('uses independent seq counters for different sessions', async () => {
    const store = makeStore();
    await store.append(makeEntry({ sessionId: 'session-a' }));
    await store.append(makeEntry({ sessionId: 'session-b' }));
    await store.append(makeEntry({ sessionId: 'session-a' }));

    const lines = files[todayFile()]!.trim().split('\n');
    const entries = lines.map((l) => JSON.parse(l) as SessionEntry);
    const aEntries = entries.filter((e) => e.sessionId === 'session-a');
    const bEntries = entries.filter((e) => e.sessionId === 'session-b');
    expect(aEntries[0]!.seq).toBe(1);
    expect(aEntries[1]!.seq).toBe(2);
    expect(bEntries[0]!.seq).toBe(1);
  });

  it('persists taskId when provided', async () => {
    const store = makeStore();
    await store.append(makeEntry({ taskId: 'task-1' }));

    const parsed = JSON.parse(files[todayFile()]!.trim()) as SessionEntry;
    expect(parsed.taskId).toBe('task-1');
  });

  it('creates the sessions directory', async () => {
    const store = makeStore();
    await store.append(makeEntry());
    expect(dirs.has(SESSIONS_DIR)).toBe(true);
  });

  it('multiple sessions in same date file are stored together', async () => {
    const store = makeStore();
    await store.append(makeEntry({ sessionId: 'session-a', content: 'a1' }));
    await store.append(makeEntry({ sessionId: 'session-b', content: 'b1' }));

    const lines = files[todayFile()]!.trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// loadSession
// ---------------------------------------------------------------------------

describe('SessionStore.loadSession', () => {
  it('returns empty array when no entries exist for the session', async () => {
    const store = makeStore();
    const entries = await store.loadSession('no-such-session');
    expect(entries).toEqual([]);
  });

  it('loads entries for the given sessionId from the date file', async () => {
    const store = makeStore();
    await store.append(makeEntry({ role: 'user', content: 'ping' }));
    await store.append(makeEntry({ role: 'assistant', content: 'pong' }));

    const entries = await store.loadSession(SESSION_ID);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.role).toBe('user');
    expect(entries[1]!.role).toBe('assistant');
  });

  it('returns only entries matching the requested sessionId', async () => {
    const store = makeStore();
    await store.append(makeEntry({ sessionId: 'session-a', content: 'a' }));
    await store.append(makeEntry({ sessionId: 'session-b', content: 'b' }));

    const a = await store.loadSession('session-a');
    expect(a).toHaveLength(1);
    expect(a[0]!.content).toBe('a');

    const b = await store.loadSession('session-b');
    expect(b).toHaveLength(1);
    expect(b[0]!.content).toBe('b');
  });

  it('skips corrupt (non-JSON) lines with a warning', async () => {
    const warnSpy = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() };
    const store = new SessionStore(SESSIONS_DIR, logger);

    const date = new Date().toISOString().slice(0, 10);
    const filePath = `${SESSIONS_DIR}/${date}.jsonl`;
    const valid1 = JSON.stringify({
      sessionId: SESSION_ID,
      seq: 1,
      ts: new Date().toISOString(),
      date,
      role: 'user',
      content: 'valid1',
    });
    const valid2 = JSON.stringify({
      sessionId: SESSION_ID,
      seq: 2,
      ts: new Date().toISOString(),
      date,
      role: 'assistant',
      content: 'valid2',
    });
    files[filePath] = `${valid1}\nnot valid json\n${valid2}\n`;

    const entries = await store.loadSession(SESSION_ID);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.content).toBe('valid1');
    expect(entries[1]!.content).toBe('valid2');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('skips malformed (valid JSON but missing fields) lines with a warning', async () => {
    const warnSpy = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() };
    const store = new SessionStore(SESSIONS_DIR, logger);

    const date = new Date().toISOString().slice(0, 10);
    const filePath = `${SESSIONS_DIR}/${date}.jsonl`;
    const valid = JSON.stringify({
      sessionId: SESSION_ID,
      seq: 1,
      ts: new Date().toISOString(),
      date,
      role: 'user',
      content: 'ok',
    });
    const malformed = JSON.stringify({ not: 'a session entry' });
    files[filePath] = `${valid}\n${malformed}\n`;

    const entries = await store.loadSession(SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('ignores blank lines', async () => {
    const store = makeStore();
    const date = new Date().toISOString().slice(0, 10);
    const filePath = `${SESSIONS_DIR}/${date}.jsonl`;
    const valid = JSON.stringify({
      sessionId: SESSION_ID,
      seq: 1,
      ts: new Date().toISOString(),
      date,
      role: 'user',
      content: 'hello',
    });
    files[filePath] = `\n${valid}\n\n`;

    const entries = await store.loadSession(SESSION_ID);
    expect(entries).toHaveLength(1);
  });

  it('cache is updated by append so loadSession reflects new entries without re-reading disk', async () => {
    const store = makeStore();
    // Pre-build cache by calling loadSession (returns empty)
    await store.loadSession(SESSION_ID);

    // Now append — should update cache in-process
    await store.append(makeEntry({ content: 'new entry' }));

    const entries = await store.loadSession(SESSION_ID);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.content).toBe('new entry');
  });
});

// ---------------------------------------------------------------------------
// listSessionIds
// ---------------------------------------------------------------------------

describe('SessionStore.listSessionIds', () => {
  it('returns empty array when sessions directory does not exist', async () => {
    const store = makeStore();
    const ids = await store.listSessionIds();
    expect(ids).toEqual([]);
  });

  it('returns unique session IDs found across date files', async () => {
    const date = new Date().toISOString().slice(0, 10);
    const entry = (sid: string) =>
      JSON.stringify({
        sessionId: sid,
        seq: 1,
        ts: new Date().toISOString(),
        date,
        role: 'user',
        content: 'x',
      });
    files[`${SESSIONS_DIR}/${date}.jsonl`] = `${entry('session-a')}\n${entry('session-b')}\n`;

    const store = makeStore();
    const ids = await store.listSessionIds();
    expect(ids.sort()).toEqual(['session-a', 'session-b']);
  });

  it('deduplicates session IDs that appear in multiple date files', async () => {
    const makeEntryLine = (sid: string, d: string) =>
      JSON.stringify({
        sessionId: sid,
        seq: 1,
        ts: `${d}T00:00:00.000Z`,
        date: d,
        role: 'user',
        content: 'x',
      });
    files[`${SESSIONS_DIR}/2026-04-01.jsonl`] = makeEntryLine('session-a', '2026-04-01') + '\n';
    files[`${SESSIONS_DIR}/2026-04-02.jsonl`] = makeEntryLine('session-a', '2026-04-02') + '\n';

    const store = makeStore();
    const ids = await store.listSessionIds();
    expect(ids).toEqual(['session-a']); // deduplicated
  });

  it('ignores non-.jsonl files', async () => {
    const date = new Date().toISOString().slice(0, 10);
    const entry = JSON.stringify({
      sessionId: 'session-a',
      seq: 1,
      ts: new Date().toISOString(),
      date,
      role: 'user',
      content: 'x',
    });
    files[`${SESSIONS_DIR}/${date}.jsonl`] = entry + '\n';
    files[`${SESSIONS_DIR}/readme.txt`] = 'ignored';

    const store = makeStore();
    const ids = await store.listSessionIds();
    expect(ids).toEqual(['session-a']);
  });

  it('logs a warning (not throws) when a date file cannot be read due to a non-ENOENT error', async () => {
    const warnSpy = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() };
    const store = new SessionStore(SESSIONS_DIR, logger);

    const date = new Date().toISOString().slice(0, 10);
    // Put a valid file in the mock filesystem so readdir returns it
    dirs.add(SESSIONS_DIR);
    files[`${SESSIONS_DIR}/${date}.jsonl`] = ''; // placeholder to make readdir see it

    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );

    // Should not throw — the file is skipped with a warning
    const ids = await store.listSessionIds();
    expect(ids).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to read session file — history may be incomplete',
      expect.objectContaining({ code: 'EACCES' }),
    );
  });

  it('rethrows non-ENOENT errors from readdir', async () => {
    const { readdir } = await import('node:fs/promises');
    vi.mocked(readdir).mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));

    const store = makeStore();
    await expect(store.listSessionIds()).rejects.toThrow('EPERM');
  });
});
