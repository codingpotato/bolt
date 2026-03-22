import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStore } from './session-store';
import type { SessionEntry } from './session-store';
import { createNoopLogger } from '../logger';

// ---------------------------------------------------------------------------
// In-memory filesystem mock
// ---------------------------------------------------------------------------

// Track files as { [path]: content } and directories as a Set.
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
  it('writes a JSON line to the correct file', async () => {
    const store = makeStore();
    await store.append(makeEntry());

    const filePath = `${SESSIONS_DIR}/${SESSION_ID}.jsonl`;
    expect(files[filePath]).toBeDefined();
    const line = files[filePath]!.trim();
    const parsed = JSON.parse(line) as SessionEntry;
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.role).toBe('user');
    expect(parsed.content).toBe('hello');
  });

  it('stamps seq, ts, and date', async () => {
    const store = makeStore();
    await store.append(makeEntry());

    const filePath = `${SESSIONS_DIR}/${SESSION_ID}.jsonl`;
    const parsed = JSON.parse(files[filePath]!.trim()) as SessionEntry;
    expect(parsed.seq).toBe(1);
    expect(typeof parsed.ts).toBe('string');
    expect(parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('increments seq for each append in the same session', async () => {
    const store = makeStore();
    await store.append(makeEntry({ role: 'user' }));
    await store.append(makeEntry({ role: 'assistant' }));

    const filePath = `${SESSIONS_DIR}/${SESSION_ID}.jsonl`;
    const lines = files[filePath]!.trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as SessionEntry;
    const second = JSON.parse(lines[1]!) as SessionEntry;
    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it('uses independent seq counters for different sessions', async () => {
    const store = makeStore();
    await store.append(makeEntry({ sessionId: 'session-a' }));
    await store.append(makeEntry({ sessionId: 'session-b' }));
    await store.append(makeEntry({ sessionId: 'session-a' }));

    const aLines = files[`${SESSIONS_DIR}/session-a.jsonl`]!.trim().split('\n');
    const bLines = files[`${SESSIONS_DIR}/session-b.jsonl`]!.trim().split('\n');
    expect((JSON.parse(aLines[0]!) as SessionEntry).seq).toBe(1);
    expect((JSON.parse(aLines[1]!) as SessionEntry).seq).toBe(2);
    expect((JSON.parse(bLines[0]!) as SessionEntry).seq).toBe(1);
  });

  it('persists taskId when provided', async () => {
    const store = makeStore();
    await store.append(makeEntry({ taskId: 'task-1' }));

    const filePath = `${SESSIONS_DIR}/${SESSION_ID}.jsonl`;
    const parsed = JSON.parse(files[filePath]!.trim()) as SessionEntry;
    expect(parsed.taskId).toBe('task-1');
  });

  it('creates the sessions directory', async () => {
    const store = makeStore();
    await store.append(makeEntry());
    expect(dirs.has(SESSIONS_DIR)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadSession
// ---------------------------------------------------------------------------

describe('SessionStore.loadSession', () => {
  it('returns empty array when file does not exist', async () => {
    const store = makeStore();
    const entries = await store.loadSession('no-such-session');
    expect(entries).toEqual([]);
  });

  it('loads all valid entries from the file', async () => {
    const store = makeStore();
    await store.append(makeEntry({ role: 'user', content: 'ping' }));
    await store.append(makeEntry({ role: 'assistant', content: 'pong' }));

    const entries = await store.loadSession(SESSION_ID);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.role).toBe('user');
    expect(entries[1]!.role).toBe('assistant');
  });

  it('skips corrupt (non-JSON) lines with a warning', async () => {
    const warnSpy = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn() };
    const store = new SessionStore(SESSIONS_DIR, logger);

    const filePath = `${SESSIONS_DIR}/${SESSION_ID}.jsonl`;
    // Manually inject a corrupt line between two valid entries
    const valid1 = JSON.stringify({
      sessionId: SESSION_ID,
      seq: 1,
      ts: new Date().toISOString(),
      date: '2024-01-01',
      role: 'user',
      content: 'valid1',
    });
    const valid2 = JSON.stringify({
      sessionId: SESSION_ID,
      seq: 2,
      ts: new Date().toISOString(),
      date: '2024-01-01',
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

    const filePath = `${SESSIONS_DIR}/${SESSION_ID}.jsonl`;
    const valid = JSON.stringify({
      sessionId: SESSION_ID,
      seq: 1,
      ts: new Date().toISOString(),
      date: '2024-01-01',
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
    const filePath = `${SESSIONS_DIR}/${SESSION_ID}.jsonl`;
    const valid = JSON.stringify({
      sessionId: SESSION_ID,
      seq: 1,
      ts: new Date().toISOString(),
      date: '2024-01-01',
      role: 'user',
      content: 'hello',
    });
    files[filePath] = `\n${valid}\n\n`;

    const entries = await store.loadSession(SESSION_ID);
    expect(entries).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// listSessionIds
// ---------------------------------------------------------------------------

describe('SessionStore.listSessionIds()', () => {
  it('returns empty array when sessions directory does not exist', async () => {
    const store = makeStore();
    const ids = await store.listSessionIds();
    expect(ids).toEqual([]);
  });

  it('returns session IDs derived from .jsonl filenames', async () => {
    files[`${SESSIONS_DIR}/session-a.jsonl`] = '';
    files[`${SESSIONS_DIR}/session-b.jsonl`] = '';

    const store = makeStore();
    const ids = await store.listSessionIds();
    expect(ids.sort()).toEqual(['session-a', 'session-b']);
  });

  it('ignores non-.jsonl files', async () => {
    files[`${SESSIONS_DIR}/session-a.jsonl`] = '';
    files[`${SESSIONS_DIR}/readme.txt`] = '';

    const store = makeStore();
    const ids = await store.listSessionIds();
    expect(ids).toEqual(['session-a']);
  });
});
