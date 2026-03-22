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

  /** A tool call is about to be dispatched */
  onToolCall(name: string, input: unknown): void;

  /** A tool call completed */
  onToolResult(name: string, success: boolean, summary: string): void;

  /** A task's status changed */
  onTaskStatusChange(taskId: string, title: string, status: string): void;

  /** Prior session messages were injected into context */
  onContextInjection(source: 'task' | 'chat', count: number, taskId?: string): void;

  /** Memory compaction was triggered */
  onMemoryCompaction(evictedCount: number): void;

  /** An API call failed and will be retried */
  onRetry(attempt: number, maxAttempts: number, reason: string): void;
}
```

### NoopProgressReporter

A no-op implementation is provided for Discord channel, sub-agents, skills, and unit tests:

```ts
class NoopProgressReporter implements ProgressReporter {
  onSessionStart(): void {}
  onThinking(): void {}
  onToolCall(): void {}
  onToolResult(): void {}
  onTaskStatusChange(): void {}
  onContextInjection(): void {}
  onMemoryCompaction(): void {}
  onRetry(): void {}
}
```

---

## Injection Points

| Component | Events emitted |
|-----------|---------------|
| `AgentCore` | `onSessionStart`, `onThinking`, `onRetry` |
| `ToolBus.dispatch` | `onToolCall`, `onToolResult` |
| `MemoryManager` | `onContextInjection`, `onMemoryCompaction` |
| Task tools (`task_update`) | `onTaskStatusChange` |

`ProgressReporter` is added to `ToolContext` so tool implementations (including task tools) can emit events without depending on AgentCore:

```ts
interface ToolContext {
  cwd: string;
  log: ToolLogger;
  logger: Logger;
  allowedTools?: string[];
  progress: ProgressReporter;   // ← added
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
```

### Input summarisation

`CliProgressReporter` summarises tool inputs for display — raw input is never dumped verbatim. Each tool has a known summary format:

| Tool | Summary shown |
|------|--------------|
| `bash` | `$ <command>` (truncated to 120 chars) |
| `file_read` | `<path>` |
| `file_write` | `<path>` |
| `file_edit` | `<path>` |
| `web_fetch` | `<url>` (truncated to 120 chars) |
| `task_create` | `"<title>"` |
| `task_update` | `<id> → <status>` |
| `memory_search` | `"<query>"` |
| `memory_write` | first 80 chars of content |
| `agent_suggest` | `<scope>/AGENT.md` |
| _(default)_ | first 120 chars of `JSON.stringify(input)` |

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

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `cli.progress` | `true` | Enable progress output in TTY mode |
| `cli.verbose` | `false` | Enable progress output even in non-TTY mode |

Both are also settable via CLI flags `--quiet` (disables progress) and `--verbose` (enables in non-TTY).
