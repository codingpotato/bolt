# Logging System Design

## Overview

bolt has three complementary logging mechanisms:

| Mechanism             | Output                          | Purpose                                                                                |
| --------------------- | ------------------------------- | -------------------------------------------------------------------------------------- |
| **Structured logger** | `.bolt/bolt.log`                | Operational and debug output — agent lifecycle, LLM requests/responses, retry warnings |
| **Trace logger**      | `.bolt/trace.log`               | LLM payload inspection — system prompts, messages, tool calls (opt-in)                 |
| **Audit logger**      | `.bolt/tool-audit.jsonl`        | Security record — every tool call with scrubbed input/output                           |

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

Each line in `.bolt/bolt.log` is a JSON object followed by `\n`. At `debug` level, meta fields contain **full content** (complete message text, full tool inputs/outputs) rather than truncated previews.

```jsonc
// debug — user message (full content in `message` field)
{"ts":"2026-03-21T10:00:00.000Z","level":"debug","message":"User turn received","sessionId":"abc","author":"anonymous","messageLength":42,"message":"What trending topics should I write about?"}

// debug — LLM request
{"ts":"2026-03-21T10:00:01.000Z","level":"debug","message":"Sending request to LLM","model":"claude-opus-4-6","messageCount":3,"systemPromptLength":5432,"llmCallNumber":1}

// debug — LLM response (full text in contentBlocks)
{"ts":"2026-03-21T10:00:02.000Z","level":"debug","message":"Received response from LLM","model":"claude-opus-4-6","inputTokens":1240,"outputTokens":312,"stopReason":"tool_use","contentBlocks":[{"type":"tool_use","id":"toolu_abc","name":"bash","input":{"command":"ls -la"}}]}

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

All levels are written to stderr in a **pretty, human-readable format** with ANSI colors and timestamps:

```
2026-03-21 10:00:00 DBG Sending request to LLM │ model=claude-opus-4-6 messageCount=3
2026-03-21 10:00:01 INF Session started │ sessionId=abc-123
2026-03-21 10:00:02 WRN API call failed, retrying │ attempt=1 error=connection refused
2026-03-21 10:00:03 ERR Context window exceeded
```

Format:
- **Timestamp**: `YYYY-MM-DD HH:MM:SS` (local time)
- **Level label**: `DBG` (gray), `INF` (cyan), `WRN` (yellow), `ERR` (red)
- **Separator**: ` │ ` between message and metadata
- **Metadata**: Priority fields shown inline, truncated to 80 chars

### Production mode (any other level)

Only `error`-level entries are written to stderr:

```
[bolt] ERROR: Context window exceeded and cannot be compacted further (195,000/200,000 tokens used).
```

All other levels (`debug`, `info`, `warn`) are file-only JSON.

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

`BOLT_LOG_TRACE` (or `logTrace` in `.bolt/config.json`) enables the **trace logger** which writes LLM payloads to `.bolt/trace.log` for debugging. Default: `false`.

```sh
# Emit trace output for system prompt, LLM requests, and LLM responses
BOLT_LOG_TRACE=true npm run dev

# Combine with debug for both structured metadata and trace output:
BOLT_LOG_LEVEL=debug BOLT_LOG_TRACE=true npm run dev
```

When enabled, trace entries are written to `.bolt/trace.log` for key LLM interaction events:

```
═══════════════════════════════════════════════════════════════════════════
SYSTEM PROMPT: model=qwen3.5-27B chars=6534 tokens=1406
  base=3115ch/662tok
  skills=10×1272ch/265tok
  tools=17×2147ch/479tok
═══════════════════════════════════════════════════════════════════════════
You are bolt, an autonomous AI agent for social media content creators...
[full content, untruncated]

═══════════════════════════════════════════════════════════════════════════
LLM REQUEST: model=qwen3.5-27B messages=3 tools=14
  window=578 / 200000 (0.3%)
  system=662tok  messages=578tok
═══════════════════════════════════════════════════════════════════════════
{"role":"user","content":"What trending topics should I write about?"}

═══════════════════════════════════════════════════════════════════════════
LLM RESPONSE: model=qwen3.5-27B inputTokens=1240 outputTokens=312 stopReason=tool_use
  window=1240 / 200000 (0.6%)
═══════════════════════════════════════════════════════════════════════════
Here are some trending topics you could write about:
1. AI productivity tools in 2026
2. Creator economy shift towards video
```

Trace entries emitted:

| Entry header   | When                                         | What it shows                                                                   |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| `SYSTEM PROMPT`| Once at session start (after prompt assembly)| Full system prompt + base/skills/tools char/token breakdown                    |
| `LLM REQUEST`  | Before each LLM API call                     | Last message in conversation + message count, tool count, context window usage  |
| `LLM RESPONSE` | After each LLM API call                      | Model text output and/or tool calls + input/output tokens, context window usage|

**Note**: Trace output is written to `.bolt/trace.log` with full, untruncated content. Each trace entry includes a header line with key metrics (model, token counts, window capacity).

---

## Log File Locations

| File                     | When created                         |
| ------------------------ | ------------------------------------ |
| `.bolt/bolt.log`         | Always — structured operational logs |
| `.bolt/trace.log`        | When `BOLT_LOG_TRACE=true` — full trace output with complete system prompts and messages |
| `.bolt/tool-audit.jsonl` | Always — security audit trail        |

Files and their parent directories are created lazily on the first write — no manual setup required.

---

## Dependency Injection

The logger and trace logger are created once in `src/cli/index.ts` and threaded through the system:

```
createLogger(config.logLevel, '.bolt/bolt.log')
  │
  ├─► AgentCore (logger argument)
  │
  └─► ToolContext.logger (required field)

createTraceLogger() || createNoopTraceLogger()   // based on config.logTrace
  │
  ├─► AgentCore (traceLogger argument)
  │
  ├─► assembleSystemPrompt() (optional parameter)
  │
  └─► AgentCore emits LLM REQUEST/RESPONSE blocks during handleTurn
```

`createNoopLogger()` and `createNoopTraceLogger()` are exported from `src/logger/index.ts` for use in tests and optional contexts where logging is not needed.

---

## Separation of Concerns

| Logger                | Writes to                      | Controls          | Purpose                                                                  |
| --------------------- | ------------------------------ | ----------------- | ---------------------------------------------------------------------- |
| Structured (`Logger`) | `.bolt/bolt.log` (JSON)        | `BOLT_LOG_LEVEL`  | Operational & debug events: agent lifecycle, LLM calls, token usage    |
| Trace (`TraceLogger`) | `.bolt/trace.log`              | `BOLT_LOG_TRACE`  | Full LLM payloads: system prompt, messages, tool calls, token windows  |
| Audit (`ToolLogger`)  | `.bolt/tool-audit.jsonl` (JSON)| Always on         | Security record: tool calls with credential fields redacted             |
