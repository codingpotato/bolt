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

/** Level labels. */
const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: '[DBG]',
  info: '[INF]',
  warn: '[WRN]',
  error: '[ERR]',
};

/** Format a value for display in metadata. */
function formatValue(val: unknown): string {
  if (typeof val === 'string') {
    // Escape newlines for single-line display
    return val.replace(/\n/g, '\\n').slice(0, 60);
  }
  if (typeof val === 'object' && val !== null && !Array.isArray(val) && Object.keys(val).length === 0) {
    return '{}';
  }
  if (typeof val === 'object' && val !== null) {
    return JSON.stringify(val).slice(0, 60);
  }
  return String(val);
}

/**
 * Creates a structured logger that writes to `logFilePath` in JSON format
 * and optionally to stderr for visibility.
 *
 * - In debug mode (logLevel: 'debug'): writes all logs to stderr with pretty formatting
 * - In production mode (logLevel >= 'info'): writes only errors to stderr
 * - Always writes JSON format to file for structured logging
 *
 * All entries below `logLevel` are silently dropped.
 * File writes are fire-and-forget: errors never propagate to the caller.
 * The log directory is created lazily on the first write.
 */
export function createLogger(logLevel: LogLevel, logFilePath: string): Logger {
  const minSeverity = SEVERITY[logLevel];
  const logDir = dirname(logFilePath);
  const isDebugMode = logLevel === 'debug';

  let initPromise: Promise<void> | null = null;
  function ensureDir(): Promise<void> {
    if (initPromise === null) {
      initPromise = mkdir(logDir, { recursive: true }).then(() => undefined);
    }
    return initPromise;
  }

  function writeFile(jsonLine: string): void {
    void ensureDir()
      .then(() => appendFile(logFilePath, jsonLine + '\n'))
      .catch(() => undefined);
  }

  function writeStderr(prettyLine: string): void {
    process.stderr.write(prettyLine + '\n');
  }

  function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (SEVERITY[level] < minSeverity) return;

    const ts = new Date().toISOString();

    // Write JSON format to file - spread meta fields at top level
    const entry = { ts, level, message, ...(meta ?? {}) };
    writeFile(JSON.stringify(entry));

    // Write pretty format to stderr based on level and mode
    const shouldWriteStderr = isDebugMode || level === 'error';
    if (shouldWriteStderr) {
      const prefix = level === 'error' ? '[bolt] ERROR:' : LEVEL_LABELS[level];
      const metaPart = meta && Object.keys(meta).length > 0
        ? ' ' + Object.entries(meta)
            .map(([k, v]) => `${k}=${formatValue(v)}`)
            .join(' ')
        : '';
      const prettyLine = `${prefix} ${message}${metaPart}`;
      writeStderr(prettyLine);
    }
  }

  return {
    debug(message, meta) {
      log('debug', message, meta);
    },
    info(message, meta) {
      log('info', message, meta);
    },
    warn(message, meta) {
      log('warn', message, meta);
    },
    error(message, meta) {
      log('error', message, meta);
    },
  };
}

/** A no-op logger that discards all entries — used as the default in tests and optional parameters. */
export function createNoopLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}