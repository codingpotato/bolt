import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured logger interface — methods are synchronous (fire-and-forget writes). */
export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Numeric severity for level comparison. */
const SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Shape of each line written to the log file. */
interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

/**
 * Creates a structured logger that writes JSON lines to `logFilePath`.
 *
 * - Entries below `logLevel` are silently dropped.
 * - `error`-level entries are additionally written to stderr.
 * - File writes are fire-and-forget: errors never propagate to the caller.
 * - The log directory is created lazily on the first write.
 */
export function createLogger(logLevel: LogLevel, logFilePath: string): Logger {
  const minSeverity = SEVERITY[logLevel];
  const logDir = dirname(logFilePath);

  let initPromise: Promise<void> | null = null;
  function ensureDir(): Promise<void> {
    if (initPromise === null) {
      initPromise = mkdir(logDir, { recursive: true }).then(() => undefined);
    }
    return initPromise;
  }

  function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (SEVERITY[level] < minSeverity) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...meta,
    };
    const line = JSON.stringify(entry) + '\n';

    // Fire-and-forget: ensure the dir exists then append.
    void ensureDir().then(() => appendFile(logFilePath, line)).catch(() => undefined);

    // error-level entries are also written to stderr for immediate visibility.
    if (level === 'error') {
      process.stderr.write(`[bolt] ERROR: ${message}\n`);
    }
  }

  return {
    debug(message, meta) { write('debug', message, meta); },
    info(message, meta)  { write('info',  message, meta); },
    warn(message, meta)  { write('warn',  message, meta); },
    error(message, meta) { write('error', message, meta); },
  };
}

/** A no-op logger that discards all entries — used as the default in tests and optional parameters. */
export function createNoopLogger(): Logger {
  return {
    debug() { /* noop */ },
    info()  { /* noop */ },
    warn()  { /* noop */ },
    error() { /* noop */ },
  };
}
