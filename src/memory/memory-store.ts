import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../logger';

/** A single persisted entry in the L3 long-term memory store. */
export interface CompactEntry {
  /** UUID for this entry. */
  id: string;
  /** 'compaction' — produced by context overflow; 'agent_note' — written by the agent explicitly. */
  type: 'compaction' | 'agent_note';
  /** Session that produced this entry. */
  sessionId: string;
  /** Task active at the time of writing, if any. */
  taskId?: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** YYYY-MM-DD derived from createdAt — used for date-range queries. */
  date: string;
  /** Model-generated summary (compaction) or agent-written content (agent_note). */
  summary: string;
  /** Raw evicted messages (compaction only). */
  messages?: unknown[];
  /** Topic tags for retrieval. */
  tags: string[];
}

/**
 * Persistent store for L3 long-term memory entries.
 *
 * Each entry is written as a separate JSON file: `<storeDir>/<id>.json`
 *
 * On startup, `loadAll()` reads every `.json` file from storeDir.
 * Corrupt or malformed files are moved to `corruptedDir` and skipped so
 * they never block startup.
 *
 * An in-memory cache is kept in sync with disk so callers can read entries
 * via `getAll()` without repeated filesystem I/O.
 */
export class MemoryStore {
  private cache: CompactEntry[] = [];

  constructor(
    private readonly storeDir: string,
    private readonly corruptedDir: string,
    private readonly logger: Logger,
  ) {}

  /**
   * Write a new entry to disk and add it to the in-memory cache.
   * Returns the generated entry id.
   */
  async write(entry: Omit<CompactEntry, 'id' | 'createdAt' | 'date'>): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    const full: CompactEntry = {
      ...entry,
      id,
      createdAt: now.toISOString(),
      date: now.toISOString().slice(0, 10),
    };

    await mkdir(this.storeDir, { recursive: true });
    await writeFile(join(this.storeDir, `${id}.json`), JSON.stringify(full, null, 2), 'utf-8');

    this.cache.push(full);
    return id;
  }

  /**
   * Load all valid entries from storeDir into the in-memory cache.
   * Corrupt or malformed files are moved to corruptedDir and skipped.
   * Missing storeDir is treated as an empty store (no error).
   */
  async loadAll(): Promise<CompactEntry[]> {
    let fileNames: string[];
    try {
      fileNames = await readdir(this.storeDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const entries: CompactEntry[] = [];

    for (const name of fileNames) {
      if (!name.endsWith('.json')) continue;

      const filePath = join(this.storeDir, name);
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf-8');
      } catch (err) {
        this.logger.warn('Failed to read memory entry file', { file: name, error: String(err) });
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.logger.warn('Moving corrupt memory entry (invalid JSON) to corrupted dir', {
          file: name,
        });
        await this.moveToCorrupted(filePath, name);
        continue;
      }

      if (!isCompactEntry(parsed)) {
        this.logger.warn('Moving malformed memory entry to corrupted dir', { file: name });
        await this.moveToCorrupted(filePath, name);
        continue;
      }

      entries.push(parsed);
    }

    this.cache = entries;
    return entries;
  }

  /** Returns all entries currently in the in-memory cache. */
  getAll(): CompactEntry[] {
    return this.cache;
  }

  private async moveToCorrupted(filePath: string, name: string): Promise<void> {
    try {
      await mkdir(this.corruptedDir, { recursive: true });
      await rename(filePath, join(this.corruptedDir, name));
    } catch (err) {
      this.logger.warn('Failed to move corrupt memory entry', { file: name, error: String(err) });
    }
  }
}

function isCompactEntry(value: unknown): value is CompactEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    (v['type'] === 'compaction' || v['type'] === 'agent_note') &&
    typeof v['sessionId'] === 'string' &&
    typeof v['createdAt'] === 'string' &&
    typeof v['date'] === 'string' &&
    typeof v['summary'] === 'string' &&
    Array.isArray(v['tags'])
  );
}
