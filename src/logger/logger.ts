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

/** Trace logger interface — writes LLM payloads to trace log for debugging. */
export interface TraceLogger {
  systemPrompt(
    content: string,
    meta: {
      model: string;
      chars: number;
      tokens: number;
      base: { chars: number; tokens: number };
      skills: { chars: number; tokens: number; count: number };
      tools: { chars: number; tokens: number; count: number };
    },
  ): void;
  llmRequest(
    lastMessage: string,
    meta: {
      model: string;
      messages: number;
      tools: number;
      systemTokens: number;
      ctxTokens: number;
      windowCapacity: number;
    },
  ): void;
  llmResponse(
    content: string,
    meta: {
      model: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
      windowCapacity: number;
    },
  ): void;
}

/** Numeric severity for level comparison. */
const SEVERITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Level labels with ANSI colors. */
const LEVEL_LABELS: Record<LogLevel, { label: string; color: string }> = {
  debug: { label: 'DBG', color: '\x1b[90m' },    // gray
  info: { label: 'INF', color: '\x1b[36m' },     // cyan
  warn: { label: 'WRN', color: '\x1b[33m' },     // yellow
  error: { label: 'ERR', color: '\x1b[31m' },    // red
};

const RESET = '\x1b[0m';

/** Format a value for display in metadata. */
function formatValue(val: unknown): string {
  if (typeof val === 'string') {
    // Escape newlines for single-line display
    return val.replace(/\n/g, '\\n').slice(0, 80);
  }
  if (typeof val === 'object' && val !== null && !Array.isArray(val) && Object.keys(val).length === 0) {
    return '{}';
  }
  if (typeof val === 'object' && val !== null) {
    return JSON.stringify(val).slice(0, 80);
  }
  return String(val);
}

/** Format a local timestamp as YYYY-MM-DD HH:MM:SS. */
function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
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
      let prettyLine: string;
      if (level === 'error') {
        prettyLine = `[bolt] ERROR: ${message}`;
      } else {
        const timestamp = formatTimestamp(ts);
        const { label, color } = LEVEL_LABELS[level];
        const metaPart = meta && Object.keys(meta).length > 0
          ? ' │ ' + Object.entries(meta)
              .map(([k, v]) => `${k}=${formatValue(v)}`)
              .join(' ')
          : '';
        prettyLine = `${timestamp} ${color}${label}${RESET} ${message}${metaPart}`;
      }
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

/**
 * Creates a trace logger that writes to the workspace's `.bolt/trace.log` file.
 * Full untruncated content is written to the trace log file.
 */
export function createTraceLogger(workspaceRoot: string): TraceLogger {
  const traceFilePath = workspaceRoot + '/.bolt/trace.log';
  let initPromise: Promise<void> | null = null;
  const logDir = dirname(traceFilePath);

  function ensureDir(): Promise<void> {
    if (initPromise === null) {
      initPromise = mkdir(logDir, { recursive: true }).then(() => undefined);
    }
    return initPromise;
  }

  function writeToFile(line: string): void {
    void ensureDir()
      .then(() => appendFile(traceFilePath, line + '\n'))
      .catch(() => undefined);
  }

  return {
    systemPrompt(content, meta) {
      // Write full system prompt to trace file (untruncated)
      writeToFile('═══════════════════════════════════════════════════════════════════════════');
      writeToFile(`SYSTEM PROMPT: model=${meta.model} chars=${meta.chars} tokens=${meta.tokens}`);
      writeToFile(`  base=${meta.base.chars}ch/${meta.base.tokens}tok`);
      writeToFile(`  skills=${meta.skills.count}×${meta.skills.chars}ch/${meta.skills.tokens}tok`);
      writeToFile(`  tools=${meta.tools.count}×${meta.tools.chars}ch/${meta.tools.tokens}tok`);
      writeToFile('═══════════════════════════════════════════════════════════════════════════');
      writeToFile(content); // Full content, untruncated
      writeToFile('');
    },

    llmRequest(lastMessage, meta) {
      const totalTokens = meta.systemTokens + meta.ctxTokens;
      const windowUsage = `${totalTokens} / ${meta.windowCapacity} (${((totalTokens / meta.windowCapacity) * 100).toFixed(1)}%)`;

      // Write full LLM request to trace file (untruncated)
      writeToFile('═══════════════════════════════════════════════════════════════════════════');
      writeToFile(`LLM REQUEST: model=${meta.model} messages=${meta.messages} tools=${meta.tools}`);
      writeToFile(`  window=${windowUsage}`);
      writeToFile(`  system=${meta.systemTokens}tok  messages=${meta.ctxTokens}tok`);
      writeToFile('═══════════════════════════════════════════════════════════════════════════');
      writeToFile(lastMessage); // Full content, untruncated
      writeToFile('');
    },

    llmResponse(content, meta) {
      const windowUsage = `${meta.inputTokens} / ${meta.windowCapacity} (${((meta.inputTokens / meta.windowCapacity) * 100).toFixed(1)}%)`;

      // Write full LLM response to trace file (untruncated)
      writeToFile('═══════════════════════════════════════════════════════════════════════════');
      writeToFile(
        `LLM RESPONSE: model=${meta.model} inputTokens=${meta.inputTokens} outputTokens=${meta.outputTokens} stopReason=${meta.stopReason}`,
      );
      writeToFile(`  window=${windowUsage}`);
      writeToFile('═══════════════════════════════════════════════════════════════════════════');
      writeToFile(content); // Full content, untruncated
      writeToFile('');
    },
  };
}

/** A no-op trace logger that discards all entries. */
export function createNoopTraceLogger(): TraceLogger {
  return {
    systemPrompt() {},
    llmRequest() {},
    llmResponse() {},
  };
}