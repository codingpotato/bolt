# Architecture

## High-Level Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                            Input Channels                                │
│                                                                          │
│  ┌─────────────────┐                                 ┌───────────────┐  │
│  │   CLI Channel   │                                 │  Web Channel  │  │
│  │ (stdin / args)  │                                 │(HTTP/WebSocket│  │
│  └────────┬────────┘                                 └──────┬────────┘  │
└───────────┼──────────────────────────────────────────────────┼──────────┘
            │               Channel interface                   │
            └──────────────────────┬────────────────────────────┘
                                   │  receive() / send() / sendMedia() / requestReview()
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
       │  - web_search     │    │    append-only JSONL, written every turn
       │  - user_review    │    │    keyed by sessionId + taskId
       │  - mcp_call       │    │
       │  - todo_*         │    └──► L3 Long-term Memory (.bolt/memory/)
       │  - task_*         │         compact entries + agent notes
       │  - skill_run      │         queried via memory_search
       │  - subagent_run   │
       │  - memory_search  │    ┌────────────────────────────────┐
       │  - memory_write   │    │       MCP Client               │
       │  - video_merge    │    │  Connects to external servers  │
       │  - video_add_audio│    │  (ComfyUI, etc.)               │
       │  - video_add_subs │    └────────────────────────────────┘
       └─────────┬─────────┘
                 │                ┌────────────────────────────────┐
                 └───────────────►│       FFmpeg Runner             │
                  video_* tools   │  Local video post-production   │
                                  │  (merge clips, add audio,      │
                                  │   add subtitles)               │
                                  └────────────────────────────────┘
```

## Components

### Channel (interface)

The abstraction for all inbound/outbound communication. The Agent Core depends only on this interface — it has no knowledge of the underlying transport.

```ts
interface UserTurn {
  /** The message content from the user */
  content: string;
  /**
   * Display name of the user who sent this turn.
   * Set by WebChannel from the ?name= query param; defaults to "User1", "User2", etc.
   * Used by AgentCore to prefix the message to the LLM: "[Alice]: ...".
   * Not set by CliChannel (single-user).
   */
  author?: string;
  /**
   * Transport-specific metadata — not passed to the model.
   * Examples: empty for CLI; { sessionToken } for WebChannel.
   */
  metadata?: Record<string, string>;
}

interface Channel {
  /** Yields inbound user turns; completes when the channel closes */
  receive(): AsyncIterable<UserTurn>;
  /** Sends the agent's final text response back to the user */
  send(response: string): Promise<void>;
  /** Sends a media file (image/video) to the user with an optional caption */
  sendMedia?(type: 'image' | 'video', path: string, caption?: string): Promise<void>;
  /**
   * Presents content for user review and collects feedback.
   * Returns approval status and optional modification notes.
   * Falls back to simple text confirm on channels that don't support rich review.
   */
  requestReview?(request: ReviewRequest): Promise<ReviewResponse>;
}

interface ReviewRequest {
  /** Content to present for review */
  content: string;
  /** Type hint for rendering */
  contentType: 'script' | 'storyboard' | 'image_prompt' | 'video_prompt' | 'image' | 'video' | 'text';
  /** Question or instruction for the reviewer */
  question: string;
  /** Optional file paths for media preview */
  mediaFiles?: string[];
}

interface ReviewResponse {
  approved: boolean;
  feedback?: string;
}
```

Implementations:

| Channel | Status | Description |
|---------|--------|-------------|
| `CliChannel` | built-in | Reads from stdin / CLI args; writes to stdout. Review requests are rendered as text with y/n/feedback prompt. |
| `WebChannel` | v1 | HTTP/WebSocket server. Supports rich media preview, inline approval buttons, and text feedback. Preferred for mobile use. Supports multiple simultaneous users in a shared conversation (see below). |

Adding a new transport (e.g. Telegram, WeChat) means implementing `Channel` — no changes to Agent Core are required.

#### WebChannel — Multi-User Shared Conversation

WebChannel supports multiple simultaneous users sharing one conversation. All messages (from any user) are visible to all connected clients. Bolt processes them one at a time from a shared FIFO queue.

**Connection model:**
- Any number of WebSocket clients may connect simultaneously
- Each client identifies itself via the `?name=` query param (e.g. `ws://host:3000/?name=Alice`)
- If omitted, the server assigns a default name: `User1`, `User2`, etc. (incrementing counter)
- Duplicate names are allowed without enforcement
- SSE (HTTP mode) remains single-user as before

**Message flow:**
1. Client sends `{ type: "message", content }` over WebSocket
2. Server immediately broadcasts `{ type: "user_message", author, content, queuePosition }` to **all** clients so every user sees the message appear instantly
3. Turn is appended to the shared `turnQueue`
4. Server broadcasts `{ type: "queue_status", depth }` to all clients
5. When AgentCore dequeues the turn via `receive()`, server broadcasts `{ type: "processing", author, content }` so all users see who Bolt is responding to
6. Bolt's final response is broadcast as `{ type: "response", content, replyTo: author }` — all users see it, tagged with whose message triggered it
7. Review requests (`requestReview`) are broadcast to all; first client to reply wins

**Server → Client message types (additions):**
```ts
{ type: 'user_message'; author: string; content: string; queuePosition: number }
{ type: 'processing';   author: string; content: string }
{ type: 'queue_status'; depth: number }
// existing 'response' gains:
{ type: 'response'; content: string; replyTo?: string }
// existing 'status' gains on connect:
{ type: 'status'; userId: string; connectedUsers: number; queueDepth: number }
```

**Agent Core integration:**
- When `UserTurn.author` is set, AgentCore prefixes the LLM message: `[Alice]: What's trending?`
- This lets the model understand multi-user context without changes to the tool/memory layers

### Slash Command Registry

Before a user turn reaches the LLM, `AgentCore` checks whether it starts with `/`. Matching messages are dispatched to `SlashCommandRegistry` instead of the API. Built-in commands: `/help`, `/exit`, `/session`. New commands can be registered without modifying AgentCore. See `docs/design/slash-commands.md`.

### Agent Core
The central loop that drives bolt. At startup it assembles the system prompt from `~/.bolt/AGENT.md` and `.bolt/AGENT.md` (falling back to a built-in default if neither exists). It checks each user turn for slash commands first, then calls the Anthropic API with the assembled context and available tools, processes tool calls, appends results, and loops until the task is complete.

AgentCore holds a `ProgressReporter` and emits `onSessionStart`, `onThinking`, and `onRetry` events. Tool call events (`onToolCall`, `onToolResult`) are emitted by the Tool Bus. Memory events (`onContextInjection`, `onMemoryCompaction`) are emitted by the Memory Manager.

When running in daemon mode (for WebChannel), AgentCore stays alive between conversations, listening for new user turns from the channel.

### ProgressReporter
An interface injected into AgentCore, ToolBus (via ToolContext), and MemoryManager. Emits real-time events at each significant step. `CliProgressReporter` writes formatted lines to stdout (TTY-guarded); `NoopProgressReporter` is used for sub-agents and tests; `WebProgressReporter` emits events over WebSocket. See `docs/design/cli-progress.md`.

### Tool Bus
Registers and dispatches tool calls from the model. Each tool is a standalone module with a JSON schema definition (used by the API) and an `execute` function.

### FFmpeg Runner

A local module that wraps the `ffmpeg` CLI for video post-production operations. It is not exposed to the Anthropic API directly — it is an internal dependency of the `video_merge`, `video_add_audio`, and `video_add_subtitles` tools.

`FfmpegRunner.detect()` resolves the ffmpeg binary at startup (from `config.ffmpeg.path` or system `PATH`). If ffmpeg is absent, a warning is logged and the three video editing tools return a non-retryable `ToolError` when called.

Progress lines emitted by ffmpeg to stderr are parsed and forwarded to the `ProgressReporter` so the user sees real-time frame/speed feedback during long encoding operations.

All file paths passed to the runner must fall within the workspace root — the tool implementations enforce this confinement check before constructing any ffmpeg command.

See `docs/design/video-editing.md` for the full FFmpeg Runner interface and all tool specifications.

### MCP Client

Connects to external MCP (Model Context Protocol) servers registered in `.bolt/config.json`. The `mcp_call` tool dispatches calls through this client.

```ts
interface McpServerConfig {
  name: string;          // e.g. "comfyui"
  url: string;           // e.g. "http://gpu-server:8188/mcp"
  tools?: string[];      // optional whitelist; if omitted, all server tools are available
}

class McpClient {
  /** Discover available tools from all registered servers */
  listTools(): McpToolDefinition[];
  /** Call a tool on the appropriate server */
  call(server: string, tool: string, input: unknown): Promise<unknown>;
}
```

The MCP Client handles:
- Server discovery and health checks at startup
- Tool call routing to the correct server
- Timeout and retry for long-running operations (e.g. image generation)
- Progress polling for async operations (ComfyUI workflow execution)

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
8. For `user_review` calls: the request is forwarded to the active Channel's `requestReview()` method; the user's response is returned as the tool result
9. For `mcp_call` calls: the request is forwarded to the MCP Client, which routes to the appropriate server
9a. For `video_merge`, `video_add_audio`, `video_add_subtitles` calls: the tool builds an ffmpeg command via `FfmpegRunner`; progress events stream to the `ProgressReporter` during encoding
10. Memory Manager checks token budget; triggers compaction (L1 → L3) if needed
11. Loop continues until the model returns a final text response with no tool calls
12. Agent Core calls `channel.send(response)` to deliver the reply

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

### MCP Server Failures
- Connection failures: retryable ToolError with the server name and error message
- Timeout: configurable per-server timeout (default 300s for image/video generation)
- Server unavailable at startup: logged as warning; `mcp_call` to that server returns ToolError

### Sub-agent Crashes
- If a sub-agent process exits with a non-zero code, the parent marks the delegated task as `failed` with the stderr as the error reason
- The parent agent decides whether to retry delegation or surface the failure to the user

### Corrupt State Files
- On startup, if `.bolt/tasks.json` or memory store files cannot be parsed, bolt logs a warning and starts with an empty state rather than crashing
- Corrupt entries are moved to `.bolt/corrupted/` for inspection

### Channel Disconnection
- `WebChannel`: WebSocket clients that disconnect mid-response are silently dropped. If a `user_review` tool call is in-flight when the client disconnects, it returns a retryable `ToolError("client disconnected during review")` so the agent can re-present the review request when the client reconnects. Clients can reconnect and resume the session via the same session ID.
- `CliChannel`: EOF on stdin causes a clean shutdown
