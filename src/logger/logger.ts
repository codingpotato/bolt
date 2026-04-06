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

/** Trace logger interface — outputs rich blocks to stderr for debugging. */
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
 * Creates a trace logger that writes pretty bordered blocks to stderr.
 * Trace blocks are only written when `BOLT_LOG_TRACE=true`.
 * Each block type (SYSTEM PROMPT, LLM REQUEST, LLM RESPONSE) is rendered as a box.
 */
export function createTraceLogger(): TraceLogger {
  function writeBlock(title: string, headerLine: string, body: string): void {
    const maxWidth = Math.max(title.length + 8, headerLine.length, 70);
    const padding = ' '.repeat(Math.max(0, maxWidth - title.length - 4));
    const lines = body.split('\n').slice(0, 60);

    process.stderr.write(`╔══ ${title}${padding}╗\n`);
    process.stderr.write(`║ ${headerLine.padEnd(maxWidth - 2)} ║\n`);
    process.stderr.write(`╟${'─'.repeat(maxWidth)}╢\n`);
    for (const line of lines) {
      process.stderr.write(`║ ${line.slice(0, maxWidth - 2).padEnd(maxWidth - 2)} ║\n`);
    }
    process.stderr.write(`╚${'═'.repeat(maxWidth)}╝\n`);
  }

  return {
    systemPrompt(content, meta) {
      const headerLine = `model=${meta.model}  chars=${meta.chars}  tokens=${meta.tokens}`;
      const breakdown = `base=${meta.base.chars}ch/${meta.base.tokens}tok  skills=${meta.skills.count}×${meta.skills.chars}ch/${meta.skills.tokens}tok  tools=${meta.tools.count}×${meta.tools.chars}ch/${meta.tools.tokens}tok`;
      const fullHeader = `${headerLine}\n║ ${breakdown}`;
      writeBlock('SYSTEM PROMPT', fullHeader, content);
    },

    llmRequest(lastMessage, meta) {
      const windowUsage = `${meta.ctxTokens} / ${meta.windowCapacity} (${((meta.ctxTokens / meta.windowCapacity) * 100).toFixed(1)}%)`;
      const headerLine = `model=${meta.model}  messages=${meta.messages}  tools=${meta.tools}  window=${windowUsage}`;
      const systemLine = `system=${meta.systemTokens}tok  context=${meta.ctxTokens}tok`;
      const fullHeader = `${headerLine}\n║ ${systemLine}`;
      writeBlock('LLM REQUEST', fullHeader, lastMessage.slice(0, 2000));
    },

    llmResponse(content, meta) {
      const windowUsage = `${meta.inputTokens} / ${meta.windowCapacity} (${((meta.inputTokens / meta.windowCapacity) * 100).toFixed(1)}%)`;
      const headerLine = `model=${meta.model}  inputTokens=${windowUsage}  outputTokens=${meta.outputTokens}  stopReason=${meta.stopReason}`;
      writeBlock('LLM RESPONSE', headerLine, content);
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