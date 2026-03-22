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
          ┌─────────▼──┐     ┌─────▼──────────────────────────┐
          │  Tool Bus  │     │       Memory Manager           │
          │  (registry │     │                                │
          │  dispatch) │     │  assembles context per turn:   │
          └─────┬──────┘     │  - task history (L2, auto)     │
                │            │  - active context (L1)         │
       ┌────────┴──────────┐ └──┬─────────────────────────────┘
       │   Built-in Tools  │    │
       │  - bash           │    ├──► L1 Active Context (in-process)
       │  - file_read/write│    │    current session messages
       │  - file_edit      │    │
       │  - web_fetch      │    ├──► L2 Session Store (.bolt/sessions/)
       │  - todo_*         │    │    append-only JSONL, written every turn
       │  - task_*         │    │    keyed by sessionId + taskId
       │  - skill_run      │    │
       │  - subagent_run   │    └──► L3 Long-term Memory (.bolt/memory/)
       │  - memory_search  │         compact entries + agent notes
       │  - memory_write   │         queried via memory_search
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
The central loop that drives bolt. At startup it assembles the system prompt from `~/.bolt/AGENT.md` and `.bolt/AGENT.md` (falling back to a built-in default if neither exists). It then calls the Anthropic API with the assembled context and available tools, processes tool calls, appends results, and loops until the task is complete.

### Tool Bus
Registers and dispatches tool calls from the model. Each tool is a standalone module with a JSON schema definition (used by the API) and an `execute` function.

### Memory Manager
Manages the three-level memory system and assembles the context sent to the LLM on each turn. Responsibilities:

1. **Per-turn persistence (L2)** — appends every user turn, tool call, tool result, and assistant response to `.bolt/sessions/<session-id>.jsonl` before the next LLM call
2. **Context assembly** — builds the message array for each LLM call: system prompt, then injected task history (from L2), then L1 active context
3. **Task history injection** — when a task is active, retrieves the last N messages tagged with that `taskId` from prior sessions in L2 and prepends them as read-only context
4. **Compaction (L1 → L3)** — when token usage exceeds the threshold, evicts the oldest L1 messages, summarises them via the model, writes a compact entry to `.bolt/memory/`, and replaces them with a summary stub

### L1 — Active Context
In-process message array for the current session. Always fully included in LLM calls. Compacted on overflow.

### L2 — Session Store
Append-only JSONL files in `.bolt/sessions/`. One file per session (`<session-id>.jsonl`). Written on every turn — never lost on crash. Each entry carries `sessionId`, `taskId`, `seq`, `ts`, `date`, `role`, and `content`. This is the source of truth for raw conversation history.

### L3 — Long-term Memory
JSON files in `.bolt/memory/`. Written by compaction and by the `memory_write` tool. Queryable by the agent via `memory_search` (keyword or embedding backend). Never auto-injected into the LLM context — the agent retrieves explicitly.

### Sub-agent Runner
Spawns isolated child agent processes. Each sub-agent gets its own context — no shared state with the parent. Results are returned as a structured response to the parent.

## Data Flow

0. At startup: AgentCore loads `~/.bolt/AGENT.md` and `.bolt/AGENT.md`, concatenates them into the session system prompt
1. A `Channel` receives a user message and yields it as a `UserTurn`
2. Memory Manager appends the user turn to L2 session store immediately
3. Memory Manager assembles the LLM context: system prompt + task history (L2, task-scoped) + L1 active context
4. Agent Core calls the Anthropic API with the assembled context and available tools
5. Model responds with text and/or tool calls
6. Memory Manager appends the assistant response (and each tool call/result) to L2 as they occur
7. Tool Bus executes tool calls; results are appended to L1 and L2
8. Memory Manager checks token budget; triggers compaction (L1 → L3) if needed
9. Loop continues until the model returns a final text response with no tool calls
10. Agent Core calls `channel.send(response)` to deliver the reply

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
