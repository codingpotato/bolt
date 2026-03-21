# Logging System Design

## Overview

bolt has two complementary logging mechanisms:

| Mechanism | File | Purpose |
|-----------|------|---------|
| **Structured logger** | `.bolt/bolt.log` | Operational and debug output — agent lifecycle, LLM requests/responses, retry warnings |
| **Audit logger** | `.bolt/tool-audit.jsonl` | Security record — every tool call with scrubbed input/output |

This document covers the structured logger. See `docs/design/tools-system.md` for the audit logger.

---

## Logger Interface

```ts
interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
```

Methods are **synchronous from the caller's perspective** — file writes are fire-and-forget. A failing write never propagates to the caller and never crashes the agent.

The optional `meta` object is spread into the log entry alongside the standard fields.

---

## Log Levels

| Level | Severity | When to use |
|-------|----------|-------------|
| `debug` | 0 | LLM request/response details, message counts, token usage |
| `info`  | 1 | Startup, authentication mode, normal lifecycle events |
| `warn`  | 2 | API retry attempts, context compaction triggered |
| `error` | 3 | Unrecoverable failures surfaced to the user |

Entries **below** the configured level are silently dropped and never reach the file.

---

## Log Entry Format

Each line in `.bolt/bolt.log` is a JSON object followed by `\n`:

```jsonc
// debug — LLM request
{"ts":"2026-03-21T10:00:00.000Z","level":"debug","message":"Sending request to LLM","model":"claude-opus-4-6","messageCount":3}

// debug — LLM response
{"ts":"2026-03-21T10:00:01.123Z","level":"debug","message":"Received response from LLM","model":"claude-opus-4-6","inputTokens":1240,"outputTokens":312,"stopReason":"tool_use"}

// info — startup
{"ts":"2026-03-21T10:00:00.001Z","level":"info","message":"bolt started","model":"claude-opus-4-6","auth":"api-key","logLevel":"info"}

// warn — API retry
{"ts":"2026-03-21T10:00:05.000Z","level":"warn","message":"API call failed, retrying","attempt":1,"total":4,"error":"connection refused","retryMs":1000}

// error — unrecoverable
{"ts":"2026-03-21T10:00:10.000Z","level":"error","message":"Context window exceeded and cannot be compacted further (195,000/200,000 tokens used)."}
```

Fields:

| Field | Type | Description |
|-------|------|-------------|
| `ts` | ISO 8601 string | Timestamp of the log event |
| `level` | `debug\|info\|warn\|error` | Severity |
| `message` | string | Human-readable description |
| `...meta` | any | Additional context fields, spread at the top level |

---

## Stderr Output

`error`-level entries are **also** written to `stderr` as a human-readable line:

```
[bolt] ERROR: Context window exceeded and cannot be compacted further (195,000/200,000 tokens used).
```

All other levels (`debug`, `info`, `warn`) are file-only. This ensures errors surface immediately in the terminal without polluting normal output with debug noise.

---

## Configuration

`BOLT_LOG_LEVEL` (or `logLevel` in `.bolt/config.json`) controls which entries are written to the log file. Default: `info`.

| Setting | Written to file |
|---------|----------------|
| `debug` | debug + info + warn + error |
| `info`  | info + warn + error |
| `warn`  | warn + error |
| `error` | error only |

`error`-level entries always appear on stderr regardless of this setting.

To enable full LLM request/response logging:

```sh
BOLT_LOG_LEVEL=debug bolt
```

---

## Log File Location

`.bolt/bolt.log` (relative to `BOLT_DATA_DIR`, default `.bolt/`).

The file and its parent directory are created lazily on the first write — no manual setup required.

---

## Dependency Injection

The logger is created once in `src/cli/index.ts` and threaded through the system:

```
createLogger(config.logLevel, '.bolt/bolt.log')
  │
  ├─► AgentCore constructor (7th argument, optional — defaults to no-op)
  │
  └─► ToolContext.logger (required field — pass createNoopLogger() in tests)
```

`createNoopLogger()` is exported from `src/logger/index.ts` and used wherever a real logger is not needed (tests, stubs).

---

## Separation of Concerns

| Logger | Writes to | Controls | Credential scrubbing |
|--------|-----------|----------|----------------------|
| Structured (`Logger`) | `.bolt/bolt.log` | `BOLT_LOG_LEVEL` | Not applicable (no tool inputs/outputs) |
| Audit (`ToolLogger`) | `.bolt/tool-audit.jsonl` | Always on | Yes — credential fields redacted |
