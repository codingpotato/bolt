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

/** ANSI colour codes for pretty output. */
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';

const LEVEL_COLOURS: Record<LogLevel, { fg: string; label: string }> = {
  debug: { fg: DIM, label: 'DBG' },
  info: { fg: GREEN, label: 'INF' },
  warn: { fg: YELLOW, label: 'WRN' },
  error: { fg: RED, label: 'ERR' },
};

/** Shape of each line written to the log file. */
interface LogEntry {
  ts: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

/**
 * Formats a pretty stderr line for debug mode.
 * Shows timestamp, level, message, and key metadata in a human-readable format.
 * Object values are displayed on separate lines with indentation.
 */
function formatPretty(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const colour = LEVEL_COLOURS[level];
  const ts = new Date()
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');
  const levelLabel = `${colour.fg}${BOLD}${colour.label}${RESET}`;
  const tsLabel = `${DIM}${ts}${RESET}`;
  const msgLabel = level === 'error' ? `${RED}${BOLD}${message}${RESET}` : message;

  // Separate inline vs multi-line metadata
  const inlineParts: string[] = [];
  const multiLineParts: string[] = [];

  if (meta) {
    const priorityKeys = [
      'model',
      'toolName',
      'skillName',
      'sessionId',
      'taskId',
      'exitCode',
      'messageCount',
      'inputTokens',
      'outputTokens',
      'stopReason',
      'error',
      'duration',
      'port',
      'host',
      'auth',
      'promptId',
      'workflow',
      'server',
    ];

    const processEntry = (key: string, val: unknown) => {
      if (typeof val === 'object' && val !== null) {
        // Object values go on separate lines
        const formatted = JSON.stringify(val, null, 2);
        const indented = formatted.split('\n').join('\n    ');
        multiLineParts.push(`  ${DIM}${key}:${RESET}\n    ${CYAN}${indented}${RESET}`);
      } else {
        // Simple values inline
        inlineParts.push(`${DIM}${key}${RESET}=${CYAN}${formatValue(val)}${RESET}`);
      }
    };

    // Show priority keys first
    for (const key of priorityKeys) {
      if (key in meta) {
        processEntry(key, meta[key]);
      }
    }

    // Show remaining keys
    const shownKeys = new Set(priorityKeys);
    for (const [key, val] of Object.entries(meta)) {
      if (!shownKeys.has(key)) {
        processEntry(key, val);
      }
    }
  }

  const inlineStr = inlineParts.length > 0 ? ` ${DIM}│${RESET} ${inlineParts.join(' ')}` : '';
  const multiLineStr = multiLineParts.length > 0 ? '\n' + multiLineParts.join('\n') : '';

  return `${tsLabel} ${levelLabel} ${msgLabel}${inlineStr}${multiLineStr}`;
}

/** Formats a simple value for inline display (strings are truncated). */
function formatValue(val: unknown): string {
  if (typeof val === 'string') {
    return val.length > 80 ? val.slice(0, 77) + '...' : val;
  }
  return String(val);
}

/**
 * Formats a compact JSON line for production mode.
 * Only includes essential fields to keep log files small.
 */
function formatCompact(level: LogLevel, message: string, meta?: Record<string, unknown>): string {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };
  return JSON.stringify(entry);
}

/**
 * Creates a structured logger that writes to `logFilePath`.
 *
 * - **Debug mode** (`logLevel === 'debug'`): Pretty human-readable format on stderr,
 *   full structured JSON in the log file.
 * - **Production mode** (`logLevel !== 'debug'`): Compact single-line JSON in the log file,
 *   errors only on stderr.
 *
 * Entries below `logLevel` are silently dropped.
 * `error`-level entries are additionally written to stderr in both modes.
 * File writes are fire-and-forget: errors never propagate to the caller.
 * The log directory is created lazily on the first write.
 */
export function createLogger(logLevel: LogLevel, logFilePath: string): Logger {
  const minSeverity = SEVERITY[logLevel];
  const logDir = dirname(logFilePath);
  const isDebug = logLevel === 'debug';

  let initPromise: Promise<void> | null = null;
  function ensureDir(): Promise<void> {
    if (initPromise === null) {
      initPromise = mkdir(logDir, { recursive: true }).then(() => undefined);
    }
    return initPromise;
  }

  function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (SEVERITY[level] < minSeverity) return;

    // Always write structured JSON to the log file
    const fileLine = formatCompact(level, message, meta) + '\n';
    void ensureDir()
      .then(() => appendFile(logFilePath, fileLine))
      .catch(() => undefined);

    // Debug mode: pretty output to stderr for all levels
    if (isDebug) {
      const prettyLine = formatPretty(level, message, meta);
      process.stderr.write(prettyLine + '\n');
    }

    // Production mode: errors only to stderr
    if (!isDebug && level === 'error') {
      process.stderr.write(`[bolt] ERROR: ${message}\n`);
    }
  }

  return {
    debug(message, meta) {
      write('debug', message, meta);
    },
    info(message, meta) {
      write('info', message, meta);
    },
    warn(message, meta) {
      write('warn', message, meta);
    },
    error(message, meta) {
      write('error', message, meta);
    },
  };
}

/** A no-op logger that discards all entries — used as the default in tests and optional parameters. */
export function createNoopLogger(): Logger {
  return {
    debug() {
      /* noop */
    },
    info() {
      /* noop */
    },
    warn() {
      /* noop */
    },
    error() {
      /* noop */
    },
  };
}
