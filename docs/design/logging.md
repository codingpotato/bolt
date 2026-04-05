# Logging System Design

## Overview

bolt has three complementary logging mechanisms:

| Mechanism             | File                     | Purpose                                                                                 |
| --------------------- | ------------------------ | --------------------------------------------------------------------------------------- |
| **Structured logger** | `.bolt/bolt.log`         | Operational and debug output — agent lifecycle, LLM requests/responses, retry warnings  |
| **Trace logger**      | `.bolt/trace.jsonl`      | Full LLM payloads — system prompts, messages, tool calls, sub-agent dispatches (opt-in) |
| **Audit logger**      | `.bolt/tool-audit.jsonl` | Security record — every tool call with scrubbed input/output                            |

This document covers the structured logger and trace logger. See `docs/design/tools-system.md` for the audit logger.

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

| Level   | Severity | When to use                                                                      |
| ------- | -------- | -------------------------------------------------------------------------------- |
| `debug` | 0        | LLM request/response details, message counts, token usage, tool dispatch details |
| `info`  | 1        | Startup, authentication mode, normal lifecycle events, session/turn lifecycle    |
| `warn`  | 2        | API retry attempts, context compaction triggered, degraded functionality         |
| `error` | 3        | Unrecoverable failures surfaced to the user                                      |

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

| Field     | Type                       | Description                                        |
| --------- | -------------------------- | -------------------------------------------------- |
| `ts`      | ISO 8601 string            | Timestamp of the log event                         |
| `level`   | `debug\|info\|warn\|error` | Severity                                           |
| `message` | string                     | Human-readable description                         |
| `...meta` | any                        | Additional context fields, spread at the top level |

---

## Stderr Output

### Debug mode (`BOLT_LOG_LEVEL=debug`)

All levels are written to stderr in a **pretty, human-readable format** with ANSI colors:

```
2026-03-21 10:00:00 DBG Sending request to LLM │ model=claude-opus-4-6 messageCount=3
2026-03-21 10:00:01 INF Session started │ sessionId=abc-123
2026-03-21 10:00:02 WRN API call failed, retrying │ attempt=1 error=connection refused
2026-03-21 10:00:03 ERR Context window exceeded
```

Key metadata fields (model, toolName, sessionId, error, etc.) are highlighted inline. Long values (previews) are shown in the log file only, not on stderr.

### Production mode (any other level)

Only `error`-level entries are written to stderr:

```
[bolt] ERROR: Context window exceeded and cannot be compacted further (195,000/200,000 tokens used).
```

All other levels (`debug`, `info`, `warn`) are file-only JSON. This ensures errors surface immediately in the terminal without polluting normal output with debug noise.

---

## Configuration

`BOLT_LOG_LEVEL` (or `logLevel` in `.bolt/config.json`) controls which entries are written to the log file. Default: `info`.

| Setting | Written to file             |
| ------- | --------------------------- |
| `debug` | debug + info + warn + error |
| `info`  | info + warn + error         |
| `warn`  | warn + error                |
| `error` | error only                  |

`error`-level entries always appear on stderr regardless of this setting.

### Trace mode (opt-in)

`BOLT_LOG_TRACE` (or `logTrace` in `.bolt/config.json`) enables the **trace logger** which writes full LLM payloads to a separate file. Default: `false`.

```sh
BOLT_LOG_LEVEL=debug BOLT_LOG_TRACE=true bolt
```

When enabled, `.bolt/trace.jsonl` receives full payloads:

```jsonc
// system_prompt — full system prompt (logged once per session)
{"ts":"2026-03-21T10:00:00.000Z","type":"system_prompt","model":"claude-opus-4-6","promptLength":5432,"prompt":"You are bolt, an autonomous AI agent..."}

// llm_request — full messages array and tools
{"ts":"2026-03-21T10:00:01.000Z","type":"llm_request","model":"claude-opus-4-6","messageCount":5,"toolCount":12,"messages":[...],"tools":[...]}

// llm_response — full LLM response with all content blocks
{"ts":"2026-03-21T10:00:02.000Z","type":"llm_response","response":{"id":"msg_abc","content":[...],"usage":{...}}}

// tool_call — full tool call input
{"ts":"2026-03-21T10:00:02.100Z","type":"tool_call","toolName":"bash","callId":"toolu_abc","input":{"command":"ls -la"}}

// tool_result — full tool call result
{"ts":"2026-03-21T10:00:02.200Z","type":"tool_result","toolName":"bash","callId":"toolu_abc","isError":false,"result":{"exitCode":0,"stdout":"...","stderr":""}}

// subagent_dispatch — full sub-agent prompt
{"ts":"2026-03-21T10:00:03.000Z","type":"subagent_dispatch","model":"claude-opus-4-6","promptLength":1234,"prompt":"Research the latest trends...","allowedTools":["bash","web_search"]}

// subagent_result — full sub-agent output
{"ts":"2026-03-21T10:00:15.000Z","type":"subagent_result","outputLength":5678,"output":"Here are the latest trends...","durationMs":12000}
```

The trace file is separate from `bolt.log` to avoid polluting normal logs with multi-kilobyte payloads. It is intended for:

- **Prompt engineering** — analyze exactly what was sent to the LLM
- **Debugging tool calls** — see full inputs and outputs
- **Replay** — reconstruct the exact conversation for reproduction
- **Sub-agent analysis** — understand what child agents received and produced

**Security note**: The trace file contains full prompts and responses, which may include sensitive information. It is gitignored by default and should be rotated or deleted after debugging.

---

## Log File Locations

| File                     | When created                         |
| ------------------------ | ------------------------------------ |
| `.bolt/bolt.log`         | Always — structured operational logs |
| `.bolt/trace.jsonl`      | Only when `BOLT_LOG_TRACE=true`      |
| `.bolt/tool-audit.jsonl` | Always — security audit trail        |

Files and their parent directories are created lazily on the first write — no manual setup required.

---

## Dependency Injection

The logger is created once in `src/cli/index.ts` and threaded through the system:

```
createLogger(config.logLevel, '.bolt/bolt.log')
  │
  ├─► AgentCore constructor (logger argument)
  │
  └─► ToolContext.logger (required field — pass createNoopLogger() in tests)

createTraceLogger('.bolt/trace.jsonl')  // only if logTrace=true, else noop
  │
  └─► AgentCore constructor (traceLogger argument)
```

`createNoopLogger()` and `createNoopTraceLogger()` are exported from `src/logger/index.ts` and used wherever a real logger is not needed (tests, stubs).

---

## Separation of Concerns

| Logger                | Writes to                | Controls         | Credential scrubbing                           |
| --------------------- | ------------------------ | ---------------- | ---------------------------------------------- |
| Structured (`Logger`) | `.bolt/bolt.log`         | `BOLT_LOG_LEVEL` | Not applicable (no tool inputs/outputs)        |
| Trace (`TraceLogger`) | `.bolt/trace.jsonl`      | `BOLT_LOG_TRACE` | No — contains full payloads (use with caution) |
| Audit (`ToolLogger`)  | `.bolt/tool-audit.jsonl` | Always on        | Yes — credential fields redacted               |
