import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../logger';

/** A single persisted event in the L2 session log. */
export interface SessionEntry {
  /** UUID of the session that produced this entry. */
  sessionId: string;
  /** Monotonically increasing counter within the session. */
  seq: number;
  /** ISO 8601 timestamp. */
  ts: string;
  /** Active task at the time of this entry, if any. */
  taskId?: string;
  /** YYYY-MM-DD derived from ts — used for date-range queries and daily file routing. */
  date: string;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result';
  /** Raw message content (Anthropic message format). */
  content: unknown;
}

/**
 * Append-only JSONL store for L2 session history with daily log rotation.
 *
 * bolt runs 7×24, so rather than growing a single per-session file indefinitely,
 * entries are written to a file named by the current UTC date:
 *   `<sessionsDir>/YYYY-MM-DD.jsonl`
 * A new file is opened automatically at midnight without restarting the process.
 *
 * The `sessionId` field stamped on every entry is the correlation key.
 * Querying by session or task means scanning the relevant date files and
 * filtering by `sessionId` or `taskId`.
 *
 * An in-process cache (Map<sessionId, SessionEntry[]>) is built lazily on the
 * first read and kept up-to-date as entries are appended, so repeated reads are
 * cheap within a single process lifetime.
 */
export class SessionStore {
  private readonly seqMap: Map<string, number> = new Map();
  /** null = not yet built */
  private cache: Map<string, SessionEntry[]> | null = null;

  constructor(
    private readonly sessionsDir: string,
    private readonly logger: Logger,
  ) {}

  /**
   * Append one entry to the session log.
   * Writes to `<sessionsDir>/YYYY-MM-DD.jsonl` (the current UTC date).
   * Creates the sessions directory if it does not already exist.
   */
  async append(entry: Omit<SessionEntry, 'seq' | 'ts' | 'date'>): Promise<void> {
    const sessionId = entry.sessionId;
    const seq = (this.seqMap.get(sessionId) ?? 0) + 1;
    this.seqMap.set(sessionId, seq);

    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const full: SessionEntry = {
      ...entry,
      seq,
      ts: now.toISOString(),
      date,
    };

    const filePath = join(this.sessionsDir, `${date}.jsonl`);
    await mkdir(this.sessionsDir, { recursive: true });
    await appendFile(filePath, JSON.stringify(full) + '\n', 'utf-8');

    // Keep cache consistent if it has already been built
    if (this.cache !== null) {
      const existing = this.cache.get(sessionId) ?? [];
      existing.push(full);
      this.cache.set(sessionId, existing);
    }
  }

  /**
   * List all session IDs that have at least one persisted entry.
   * Scans all date files in the sessions directory (built lazily and cached).
   */
  async listSessionIds(): Promise<string[]> {
    await this.ensureCache();
    return Array.from(this.cache!.keys());
  }

  /**
   * Load all valid entries for a given session ID across all date files.
   * Corrupt lines (invalid JSON or missing required fields) are skipped with a
   * warning so a single bad write does not block the entire session from loading.
   */
  async loadSession(sessionId: string): Promise<SessionEntry[]> {
    await this.ensureCache();
    return this.cache!.get(sessionId) ?? [];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the in-process cache by scanning all YYYY-MM-DD.jsonl files in
   * sessionsDir and grouping entries by sessionId. Called at most once per
   * process lifetime; subsequent calls are no-ops.
   */
  private async ensureCache(): Promise<void> {
    if (this.cache !== null) return;
    this.cache = new Map();

    let fileNames: string[];
    try {
      fileNames = await readdir(this.sessionsDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    // Sort ascending so entries end up in chronological order within each session
    const dateFiles = fileNames.filter((n) => n.endsWith('.jsonl')).sort();

    for (const fileName of dateFiles) {
      const filePath = join(this.sessionsDir, fileName);
      let raw: string;
      try {
        raw = await readFile(filePath, 'utf-8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          this.logger.warn('Failed to read session file — history may be incomplete', {
            fileName,
            code,
          });
        }
        continue;
      }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (isSessionEntry(parsed)) {
            const bucket = this.cache.get(parsed.sessionId) ?? [];
            bucket.push(parsed);
            this.cache.set(parsed.sessionId, bucket);
          } else {
            this.logger.warn('Skipping malformed session entry', { line: trimmed });
          }
        } catch {
          this.logger.warn('Skipping corrupt session entry (invalid JSON)', { line: trimmed });
        }
      }
    }
  }
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['sessionId'] === 'string' &&
    typeof v['seq'] === 'number' &&
    typeof v['ts'] === 'string' &&
    typeof v['date'] === 'string' &&
    typeof v['role'] === 'string' &&
    ['user', 'assistant', 'tool_call', 'tool_result'].includes(v['role'] as string) &&
    'content' in v
  );
}
