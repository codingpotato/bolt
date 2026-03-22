import { appendFile, mkdir, readFile } from 'node:fs/promises';
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
  /** YYYY-MM-DD derived from ts — used for date-range queries. */
  date: string;
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result';
  /** Raw message content (Anthropic message format). */
  content: unknown;
}

/**
 * Append-only JSONL store for L2 session history.
 *
 * One file per session: `<sessionsDir>/<session-id>.jsonl`
 *
 * Writes are appended immediately on every turn so no data is lost on crash.
 * On load, corrupt lines are skipped with a warning.
 */
export class SessionStore {
  private readonly seqMap: Map<string, number> = new Map();

  constructor(
    private readonly sessionsDir: string,
    private readonly logger: Logger,
  ) {}

  /**
   * Append one entry to the session log.
   * Creates the sessions directory if it does not already exist.
   */
  async append(entry: Omit<SessionEntry, 'seq' | 'ts' | 'date'>): Promise<void> {
    const sessionId = entry.sessionId;
    const seq = (this.seqMap.get(sessionId) ?? 0) + 1;
    this.seqMap.set(sessionId, seq);

    const now = new Date();
    const full: SessionEntry = {
      ...entry,
      seq,
      ts: now.toISOString(),
      date: now.toISOString().slice(0, 10),
    };

    const filePath = join(this.sessionsDir, `${sessionId}.jsonl`);
    await mkdir(this.sessionsDir, { recursive: true });
    await appendFile(filePath, JSON.stringify(full) + '\n', 'utf-8');
  }

  /**
   * Load all valid entries from a session file.
   * Corrupt lines (invalid JSON or missing required fields) are skipped with a
   * warning so a single bad write does not block the entire session from loading.
   */
  async loadSession(sessionId: string): Promise<SessionEntry[]> {
    const filePath = join(this.sessionsDir, `${sessionId}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw err;
    }

    const entries: SessionEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (isSessionEntry(parsed)) {
          entries.push(parsed);
        } else {
          this.logger.warn('Skipping malformed session entry', { sessionId, line: trimmed });
        }
      } catch {
        this.logger.warn('Skipping corrupt session entry (invalid JSON)', { sessionId, line: trimmed });
      }
    }
    return entries;
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
