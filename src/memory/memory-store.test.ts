import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryStore } from './memory-store';
import type { CompactEntry } from './memory-store';
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
  writeFile: vi.fn(async (path: string, data: string) => {
    files[String(path)] = String(data);
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
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    return Object.keys(files)
      .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map((p) => p.slice(prefix.length));
  }),
  rename: vi.fn(async (src: string, dest: string) => {
    const s = String(src);
    const d = String(dest);
    if (!(s in files)) {
      const err = Object.assign(new Error(`ENOENT: ${s}`), { code: 'ENOENT' });
      throw err;
    }
    files[d] = files[s] as string;
    delete files[s];
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORE_DIR = '/bolt/memory';
const CORRUPTED_DIR = '/bolt/corrupted';
const logger = createNoopLogger();

function makeStore(): MemoryStore {
  return new MemoryStore(STORE_DIR, CORRUPTED_DIR, logger);
}

function validEntry(overrides?: Partial<CompactEntry>): CompactEntry {
  return {
    id: 'test-id',
    type: 'agent_note',
    sessionId: 'session-1',
    createdAt: '2026-03-22T00:00:00.000Z',
    date: '2026-03-22',
    summary: 'A test note.',
    tags: ['test'],
    ...overrides,
  };
}

beforeEach(() => {
  files = {};
  dirs = new Set();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// write()
// ---------------------------------------------------------------------------

describe('MemoryStore.write()', () => {
  it('writes a JSON file to <storeDir>/<id>.json and returns the id', async () => {
    const store = makeStore();
    const id = await store.write({
      type: 'agent_note',
      sessionId: 'session-1',
      summary: 'A test note.',
      tags: ['test'],
    });

    const filePath = `${STORE_DIR}/${id}.json`;
    expect(files[filePath]).toBeDefined();
    const parsed = JSON.parse(files[filePath] as string) as CompactEntry;
    expect(parsed.id).toBe(id);
    expect(parsed.type).toBe('agent_note');
    expect(parsed.sessionId).toBe('session-1');
    expect(parsed.summary).toBe('A test note.');
    expect(parsed.tags).toEqual(['test']);
    expect(parsed.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(parsed.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('creates the store directory if it does not exist', async () => {
    const store = makeStore();
    await store.write({ type: 'agent_note', sessionId: 's1', summary: 'note', tags: [] });

    const { mkdir } = await import('node:fs/promises');
    expect(mkdir).toHaveBeenCalledWith(STORE_DIR, { recursive: true });
  });

  it('generates a unique id for each write', async () => {
    const store = makeStore();
    const id1 = await store.write({ type: 'agent_note', sessionId: 's1', summary: 'a', tags: [] });
    const id2 = await store.write({ type: 'agent_note', sessionId: 's1', summary: 'b', tags: [] });
    expect(id1).not.toBe(id2);
  });

  it('stores optional taskId and messages when provided', async () => {
    const store = makeStore();
    const id = await store.write({
      type: 'compaction',
      sessionId: 'session-1',
      taskId: 'task-abc',
      summary: 'Compacted context.',
      messages: [{ role: 'user', content: 'hello' }],
      tags: ['compaction'],
    });

    const parsed = JSON.parse(files[`${STORE_DIR}/${id}.json`] as string) as CompactEntry;
    expect(parsed.taskId).toBe('task-abc');
    expect(parsed.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('adds the written entry to the in-memory cache', async () => {
    const store = makeStore();
    const id = await store.write({ type: 'agent_note', sessionId: 's1', summary: 'cached', tags: [] });
    expect(store.getAll().some((e: CompactEntry) => e.id === id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadAll()
// ---------------------------------------------------------------------------

describe('MemoryStore.loadAll()', () => {
  it('returns empty array when store directory does not exist', async () => {
    const store = makeStore();
    const entries = await store.loadAll();
    expect(entries).toEqual([]);
  });

  it('loads valid JSON files and returns their entries', async () => {
    const entry = validEntry();
    files[`${STORE_DIR}/${entry.id}.json`] = JSON.stringify(entry);

    const store = makeStore();
    const entries = await store.loadAll();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(entry.id);
    expect(entries[0]?.summary).toBe(entry.summary);
  });

  it('skips non-.json files', async () => {
    const entry = validEntry();
    files[`${STORE_DIR}/${entry.id}.json`] = JSON.stringify(entry);
    files[`${STORE_DIR}/readme.txt`] = 'not a json file';

    const store = makeStore();
    const entries = await store.loadAll();
    expect(entries).toHaveLength(1);
  });

  it('moves corrupt (invalid JSON) files to corruptedDir and skips them', async () => {
    files[`${STORE_DIR}/bad.json`] = 'not valid json {{{';

    const store = makeStore();
    const entries = await store.loadAll();

    expect(entries).toHaveLength(0);
    expect(files[`${STORE_DIR}/bad.json`]).toBeUndefined();
    const corruptedFiles = Object.keys(files).filter((p) => p.startsWith(CORRUPTED_DIR + '/'));
    expect(corruptedFiles.length).toBeGreaterThan(0);
  });

  it('moves malformed (valid JSON but wrong shape) files to corruptedDir and skips them', async () => {
    files[`${STORE_DIR}/malformed.json`] = JSON.stringify({ foo: 'bar' });

    const store = makeStore();
    const entries = await store.loadAll();

    expect(entries).toHaveLength(0);
    expect(files[`${STORE_DIR}/malformed.json`]).toBeUndefined();
    const corruptedFiles = Object.keys(files).filter((p) => p.startsWith(CORRUPTED_DIR + '/'));
    expect(corruptedFiles.length).toBeGreaterThan(0);
  });

  it('creates corruptedDir before moving a corrupt file', async () => {
    files[`${STORE_DIR}/bad.json`] = 'bad json';

    const store = makeStore();
    await store.loadAll();

    const { mkdir } = await import('node:fs/promises');
    expect(mkdir).toHaveBeenCalledWith(CORRUPTED_DIR, { recursive: true });
  });

  it('loads valid entries alongside corrupt ones without blocking', async () => {
    const e1 = validEntry({ id: 'id-1' });
    const e2 = validEntry({ id: 'id-2' });
    files[`${STORE_DIR}/id-1.json`] = JSON.stringify(e1);
    files[`${STORE_DIR}/id-2.json`] = JSON.stringify(e2);
    files[`${STORE_DIR}/bad.json`] = 'corrupted';

    const store = makeStore();
    const entries = await store.loadAll();

    expect(entries).toHaveLength(2);
    expect(entries.map((e: CompactEntry) => e.id).sort()).toEqual(['id-1', 'id-2']);
  });

  it('populates the in-memory cache after loading', async () => {
    const entry = validEntry();
    files[`${STORE_DIR}/${entry.id}.json`] = JSON.stringify(entry);

    const store = makeStore();
    await store.loadAll();

    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0]?.id).toBe(entry.id);
  });
});
