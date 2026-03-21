# Architecture

## High-Level Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Input Channels                                │
│                                                                          │
│  ┌─────────────────┐   ┌──────────────────────────┐   ┌───────────────┐ │
│  │   CLI Channel   │   │    Discord Channel       │   │  Web Channel  │ │
│  │ (stdin / args)  │   │  (Gateway → user turns)  │   │(HTTP/WebSocket│ │
│  └────────┬────────┘   └────────────┬─────────────┘   └──────┬────────┘ │
└───────────┼────────────────────────────────────────────────────┼─────────┘
            │               Channel interface                     │
            └──────────────────────┬──────────────────────────────┘
                                   │  receive() / send()
                 ┌─────────▼──────────┐
                 │    Agent Core      │
                 │  (Anthropic SDK)   │◄──── tool_use / tool_result loop
                 └──┬──────────────┬──┘
                    │              │
          ┌─────────▼──┐     ┌─────▼──────────┐
          │  Tool Bus  │     │ Memory Manager │
          │  (registry │     └─────┬──────────┘
          │  dispatch) │           │
          └─────┬──────┘     ┌─────▼──────────┐
                │            │ Context Store   │
       ┌────────┴──────────┐ │ (in-process)   │
       │   Built-in Tools  │ │                │
       │  - bash           │ │ Compact Store  │
       │  - file_read/write│ │ (persisted)    │
       │  - file_edit      │ └────────────────┘
       │  - web_fetch      │
       │  - todo_*         │
       │  - task_*         │
       │  - skill_run      │
       │  - subagent_run   │
       │  - memory_search  │
       └───────────────────┘
```

## Components

### Channel (interface)

The abstraction for all inbound/outbound communication. The Agent Core depends only on this interface — it has no knowledge of the underlying transport.

```ts
interface UserTurn {
  /** The message content from the user */
  content: string;
  /**
   * Transport-specific metadata — not passed to the model.
   * Examples: { userId, channelId } for Discord; empty for CLI.
   */
  metadata?: Record<string, string>;
}

interface Channel {
  /** Yields inbound user turns; completes when the channel closes */
  receive(): AsyncIterable<UserTurn>;
  /** Sends the agent's final response back to the user */
  send(response: string): Promise<void>;
}
```

Implementations:

| Channel | Status | Description |
|---------|--------|-------------|
| `CliChannel` | built-in | Reads from stdin / CLI args; writes to stdout |
| `DiscordChannel` | built-in | Listens to a configured Discord channel via the Gateway; posts responses back |
| `WebChannel` | planned | Accepts connections over HTTP (REST) or WebSocket; streams responses back to the browser client |

**`WebChannel` design notes:**
- **HTTP mode** — each POST to `/chat` is a user turn; the response is held open until `send()` resolves it
- **WebSocket mode** — preferred; connection stays open, enabling token-by-token streaming and multi-turn sessions without reconnection overhead

Adding a new transport (e.g. Slack, SMS) means implementing `Channel` — no changes to Agent Core are required.

### Agent Core
The central loop that drives bolt. It calls the Anthropic API with the current context and available tools, processes tool calls, appends results, and loops until the task is complete.

### Tool Bus
Registers and dispatches tool calls from the model. Each tool is a standalone module with a JSON schema definition (used by the API) and an `execute` function.

### Memory Manager
Tracks token usage in the current context. When usage approaches the model's context window limit, it triggers compaction: summarizes older messages, writes them to the Compact Store, and replaces them with a summary stub in the active context.

### Context Store
In-process message array for the current session.

### Compact Store
Persistent storage (file-based or SQLite) for compacted message history. Queryable by the agent for relevant past context.

### Sub-agent Runner
Spawns isolated child agent processes. Each sub-agent gets its own context — no shared state with the parent. Results are returned as a structured response to the parent.

## Data Flow

1. A `Channel` receives a user message and yields it as a `UserTurn`
2. Agent Core builds a message, calls Anthropic API
3. Model responds with text and/or tool calls
4. Tool Bus executes tool calls, appends results
5. Memory Manager checks token budget; compacts if needed
6. Loop continues until model returns a final text response
7. Agent Core calls `channel.send(response)` to deliver the reply

## Error Handling and Recovery

### Tool Errors
- Tools signal failure by throwing `ToolError`
- Tool Bus catches it, serializes as `tool_result` with `is_error: true`, and returns to the model
- The model decides whether to retry, use a fallback, or abandon the task
- Non-retryable errors are logged and surfaced to the user immediately

### Anthropic API Failures
- Network errors and 5xx responses: retry up to 3 times with exponential backoff
- 4xx errors (bad request, auth failure): fail immediately with a clear error message
- Context window exceeded: trigger compaction first, then retry the API call

### Sub-agent Crashes
- If a sub-agent process exits with a non-zero code, the parent marks the delegated task as `failed` with the stderr as the error reason
- The parent agent decides whether to retry delegation or surface the failure to the user

### Corrupt State Files
- On startup, if `.bolt/tasks.json` or memory store files cannot be parsed, bolt logs a warning and starts with an empty state rather than crashing
- Corrupt entries are moved to `.bolt/corrupted/` for inspection

### Channel Disconnection
- `DiscordChannel`: reconnects automatically with backoff on gateway disconnect
- `WebChannel`: WebSocket clients that disconnect mid-response are silently dropped; HTTP connections time out after `tools.timeoutMs`
- `CliChannel`: EOF on stdin causes a clean shutdown
