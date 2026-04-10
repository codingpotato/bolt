# CLI Progress Output Design

## Goals

- Show the user what the agent is doing at each significant step in real time
- Keep noise low — summarise, don't dump raw data
- Decouple progress reporting from the core agent loop via an injected interface
- Make it easy to suppress for scripted/non-TTY use

---

## ProgressReporter Interface

A `ProgressReporter` is injected into `AgentCore`, `ToolBus` (`ToolContext`), and `MemoryManager`. Each component calls the relevant method at the right moment. The interface is intentionally narrow — it emits events, it does not return values.

```ts
interface ProgressReporter {
  /** Agent session started or resumed */
  onSessionStart(sessionId: string, resumed: boolean): void;

  /** Model is generating a response (spinner / status line) */
  onThinking(): void;

  /** Emitted just before each LLM API call with current context state */
  onLlmCall(info: LlmCallInfo): void;

  /** Emitted immediately after each LLM API response with actual token usage */
  onLlmResponse(info: LlmResponseInfo): void;

  /** A tool call is about to be dispatched */
  onToolCall(name: string, input: unknown): void;

  /** A tool call completed */
  onToolResult(name: string, success: boolean, summary: string): void;

  /** A task's status changed */
  onTaskStatusChange(taskId: string, title: string, status: string): void;

  /** Prior session messages were injected into context */
  onContextInjection(source: 'task' | 'chat', count: number, taskId?: string): void;

  /** Memory compaction completed — evicted messages summarised and stored */
  onMemoryCompaction(evictedCount: number, summary: string, tags: string[]): void;

  /** An API call failed and will be retried */
  onRetry(attempt: number, maxAttempts: number, reason: string): void;

  /** A skill sub-agent is about to be spawned */
  onSubagentStart(skillName: string, description: string): void;

  /** A skill sub-agent completed successfully */
  onSubagentEnd(skillName: string, durationMs: number): void;

  /** A skill sub-agent failed */
  onSubagentError(skillName: string, error: string): void;

  // --- Forwarded sub-agent internal events (see Sub-agent Progress Forwarding) ---

  /** Sub-agent's model is generating (forwarded from child process) */
  onSubagentThinking(skill: string): void;

  /** A tool call made inside a sub-agent (forwarded from child process) */
  onSubagentToolCall(skill: string, name: string, input: unknown): void;

  /** A sub-agent tool call completed (forwarded from child process) */
  onSubagentToolResult(skill: string, name: string, success: boolean, summary: string): void;

  /** A sub-agent API call failed and will be retried (forwarded from child process) */
  onSubagentRetry(skill: string, attempt: number, maxAttempts: number, reason: string): void;
}
```

### NoopProgressReporter

A no-op implementation is provided for Discord channel and unit tests:

```ts
class NoopProgressReporter implements ProgressReporter {
  onSessionStart(): void {}
  onThinking(): void {}
  onLlmCall(): void {}
  onLlmResponse(): void {}
  onToolCall(): void {}
  onToolResult(): void {}
  onTaskStatusChange(): void {}
  onContextInjection(): void {}
  onMemoryCompaction(): void {}
  onRetry(): void {}
  onSubagentStart(): void {}
  onSubagentEnd(): void {}
  onSubagentError(): void {}
  onSubagentThinking(): void {}
  onSubagentToolCall(): void {}
  onSubagentToolResult(): void {}
  onSubagentRetry(): void {}
}
```

### StderrProgressReporter

Used by sub-agents to forward internal progress events to the parent process. Each event is serialised as a newline-delimited JSON line prefixed with `PROGRESS:` and written to `process.stderr`.

Only high-signal events are forwarded — session lifecycle, task state, memory compaction, and token-usage events are suppressed to avoid noise.

```ts
class StderrProgressReporter implements ProgressReporter {
  onThinking(): void {
    this.emit({ event: 'onThinking' });
  }
  onToolCall(name: string, input: unknown): void {
    this.emit({ event: 'onToolCall', name, input });
  }
  onToolResult(name: string, success: boolean, summary: string): void {
    this.emit({ event: 'onToolResult', name, success, summary });
  }
  onRetry(attempt: number, maxAttempts: number, reason: string): void {
    this.emit({ event: 'onRetry', attempt, maxAttempts, reason });
  }
  // Suppressed (low-signal or irrelevant for the parent):
  onSessionStart(): void {}
  onLlmCall(): void {}
  onLlmResponse(): void {}
  onTaskStatusChange(): void {}
  onContextInjection(): void {}
  onMemoryCompaction(): void {}
  onSubagentStart(): void {}
  onSubagentEnd(): void {}
  onSubagentError(): void {}
  onSubagentThinking(): void {}
  onSubagentToolCall(): void {}
  onSubagentToolResult(): void {}
  onSubagentRetry(): void {}

  private emit(data: Record<string, unknown>): void {
    process.stderr.write('PROGRESS:' + JSON.stringify(data) + '\n');
  }
}
```

---

## Injection Points

| Component                            | Events emitted                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `AgentCore`                          | `onSessionStart`, `onThinking`, `onLlmCall`, `onLlmResponse`, `onRetry`           |
| `ToolBus.dispatch`                   | `onToolCall`, `onToolResult`                                                       |
| `MemoryManager`                      | `onContextInjection`, `onMemoryCompaction`                                         |
| Task tools (`task_update`)           | `onTaskStatusChange`                                                               |
| `skill_run` tool                     | `onSubagentStart`, `onSubagentEnd`, `onSubagentError`                              |
| `subagent-runner` (stderr forwarder) | `onSubagentThinking`, `onSubagentToolCall`, `onSubagentToolResult`, `onSubagentRetry` |

`ProgressReporter` is added to `ToolContext` so tool implementations (including task tools) can emit events without depending on AgentCore:

```ts
interface ToolContext {
  cwd: string;
  log: ToolLogger;
  logger: Logger;
  allowedTools?: string[];
  progress: ProgressReporter; // ← added
}
```

---

## CliProgressReporter

The CLI implementation writes formatted lines to `process.stdout`. It replaces the "Thinking…" line currently managed by `CliChannel` — that responsibility moves here.

### Output format

```
◆ Session a1b2c3d4 started
◆ Session a1b2c3d4 resumed
  ↳ Loaded 12 messages from task "Build auth system"
  ↳ Loaded 5 messages from previous chat session

⟳ Thinking…

⚙  bash
   $ npm test -- --coverage

   ✓ completed  (exit 0)

⚙  file_edit
   src/auth/login.ts

   ✗ error  file not found

⚙  memory_search
   "user authentication patterns"

   ✓ 3 results found

◆ Task "Write unit tests" → in_progress
◆ Task "Write unit tests" → completed

⟳ Compacting 42 messages…

⚠  API error, retrying (1/3): connect ECONNREFUSED

⟳ Subagent: write-blog-post — Draft a blog post about TypeScript
  ⟳ Thinking…
  ⚙  web_fetch
     https://example.com/article
     ✓ completed
  ⚙  file_write
     posts/typescript-blog.md
     ✓ completed
✓ Subagent done: write-blog-post (4231ms)
```

Forwarded sub-agent events (the indented block) are rendered with a two-space indent to visually group them under the active sub-agent. The `onSubagentEnd` line clears the indent context.

### Input summarisation

`CliProgressReporter` summarises tool inputs for display — raw input is never dumped verbatim. Each tool has a known summary format:

| Tool            | Summary shown                              |
| --------------- | ------------------------------------------ |
| `bash`          | `$ <command>` (truncated to 120 chars)     |
| `file_read`     | `<path>`                                   |
| `file_write`    | `<path>`                                   |
| `file_edit`     | `<path>`                                   |
| `web_fetch`     | `<url>` (truncated to 120 chars)           |
| `task_create`   | `"<title>"`                                |
| `task_update`   | `<id> → <status>`                          |
| `memory_search` | `"<query>"`                                |
| `memory_write`  | first 80 chars of content                  |
| _(default)_     | first 120 chars of `JSON.stringify(input)` |

### TTY guard

Progress lines are only written when `process.stdout.isTTY` is true **or** `--verbose` is passed. In non-TTY mode (piped output, CI), all progress output is suppressed and only the final response is written.

The `--quiet` flag suppresses progress output even on a TTY.

```
bolt                     → full progress output (TTY)
bolt --quiet             → final response only
bolt --verbose           → full progress output even when not a TTY
bolt | cat               → no progress output (non-TTY, no --verbose)
```

### Thinking line management

`CliProgressReporter` manages the "Thinking…" spinner line:

- `onThinking()` writes `⟳ Thinking…` to stdout
- The next `onToolCall()` or final `channel.send()` erases it with `\x1b[1A\x1b[2K` before writing

`CliChannel` no longer manages "Thinking…" directly — it delegates to the `ProgressReporter`.

---

## Sub-agent Progress Forwarding

Sub-agents run as isolated child processes that communicate with the parent via stdio. The protocol is extended to stream internal progress events from the child's stderr:

```
Parent process                          Child process (sub-agent)
──────────────                          ─────────────────────────
stdin  → SubagentPayload (JSON)
                                        AgentCore runs with StderrProgressReporter
                                        stderr ← PROGRESS:{"event":"onThinking"}
                                        stderr ← PROGRESS:{"event":"onToolCall","name":"web_fetch",...}
                                        stderr ← PROGRESS:{"event":"onToolResult","name":"web_fetch",...}
                                        stdout ← SubagentResult (JSON)
```

### `subagent-runner` forwarding loop

`runSubagent` reads child stderr line-by-line in real time (not buffered until close). Lines beginning with `PROGRESS:` are parsed as JSON and re-emitted on the parent's `ProgressReporter` as the corresponding `onSubagent*` methods. All other stderr lines are written to the parent logger.

```
stderr line → starts with "PROGRESS:"?
  yes → parse JSON → dispatch onSubagentThinking / onSubagentToolCall / onSubagentToolResult / onSubagentRetry
  no  → logger.debug(line)
```

`runSubagent` accepts an optional `progress: ProgressReporter` and `skillName: string` so the forwarded events carry the skill name. Callers that do not need forwarding (e.g. tests) omit these parameters.

### WebChannel forwarded events

`WebChannelProgressReporter` broadcasts forwarded events as:

```json
{ "type": "subagent_progress", "event": "tool_call",   "skill": "write-blog-post", "tool": "web_fetch",  "input": "https://..." }
{ "type": "subagent_progress", "event": "tool_result",  "skill": "write-blog-post", "tool": "web_fetch",  "success": true, "summary": "200 OK" }
{ "type": "subagent_progress", "event": "thinking",     "skill": "write-blog-post" }
{ "type": "subagent_progress", "event": "retry",        "skill": "write-blog-post", "attempt": 1, "maxAttempts": 3, "reason": "..." }
```

---

## Configuration

| Key            | Default | Description                                 |
| -------------- | ------- | ------------------------------------------- |
| `cli.progress` | `true`  | Enable progress output in TTY mode          |
| `cli.verbose`  | `false` | Enable progress output even in non-TTY mode |

Both are also settable via CLI flags `--quiet` (disables progress) and `--verbose` (enables in non-TTY).
