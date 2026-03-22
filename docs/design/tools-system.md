# Tools System Design

## Overview

bolt's tool system bridges the Anthropic model's tool-use API and the host environment. The model emits tool calls; the Tool Bus dispatches them to registered handler functions and returns results back into the conversation.

## Tool Interface

Every tool must implement this interface:

```ts
interface Tool<TInput = unknown, TOutput = unknown> {
  /** Unique snake_case name sent to and received from the model */
  name: string;
  /** One-line description shown to the model */
  description: string;
  /** JSON Schema for input — used to generate the Anthropic tool definition */
  inputSchema: JSONSchema;
  /**
   * If true, the Tool Bus will not run this tool concurrently with other
   * sequential tools. Use for tools that mutate shared state (e.g. todo_update).
   * Defaults to false.
   */
  sequential?: boolean;
  /** Execute the tool and return a result or throw a ToolError */
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

interface ToolContext {
  /** Absolute working directory for the current session */
  cwd: string;
  /** Audit logger — every tool call is recorded to .bolt/tool-audit.jsonl */
  log: ToolLogger;
  /** Structured logger — operational/debug output written to .bolt/bolt.log */
  logger: Logger;
  /** Allowlisted tool names for the current agent scope (undefined = all allowed) */
  allowedTools?: string[];
  /** Progress reporter — emits real-time events to the CLI (no-op for sub-agents/Discord) */
  progress: ProgressReporter;
}
```

## Tool Bus

The Tool Bus is the central registry and dispatcher.

```ts
class ToolBus {
  register(tool: Tool): void;
  unregister(name: string): void;
  list(): Tool[];                         // returns tools visible in current scope
  getAnthropicDefinitions(): ToolDefinition[];  // schema format for the API call
  dispatch(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}
```

**Execution loop integration:**

```
Model response includes tool_use blocks
        │
        ▼
For each tool_use block (may run in parallel):
  ToolBus.dispatch(call, context)
        │
   ┌────┴─────┐
 found     not found
   │           │
execute     return ToolError("unknown tool")
   │
append tool_result to messages
        │
        ▼
Call model again with updated messages
```

## Built-in Tools

| Tool | Description |
|------|-------------|
| `bash` | Run a shell command; returns `{ stdout, stderr, exitCode }` |
| `file_read` | Read a file; returns `{ content }` |
| `file_write` | Write/overwrite a file; returns `{ path }` |
| `file_edit` | Replace a substring in a file; returns `{ path, changed }` |
| `web_fetch` | GET a URL; returns `{ body, statusCode, contentType }` |
| `todo_create` | Add a todo item; returns `{ id }` |
| `todo_update` | Update status or description of a todo item |
| `todo_list` | Return the current ordered todo list |
| `todo_delete` | Remove a todo item by id |
| `task_create` | Create a serialized task; returns `{ id }` |
| `task_update` | Update task status or result |
| `task_list` | Return all tasks with their current status |
| `skill_run` | Run a named skill as an isolated sub-agent; returns skill output |
| `subagent_run` | Delegate a free-form prompt to an isolated child agent |
| `memory_search` | Query the long-term memory store (L3); returns matching summaries |
| `memory_write` | Write a fact or note to the long-term memory store (L3) |
| `agent_suggest` | Propose an addition to `AGENT.md`; writes to `.bolt/suggestions/` for human review |

## Tool Registration

Built-in tools are registered at agent startup. Additional tools can be registered at runtime:

```ts
agent.tools.register({
  name: 'send_discord_message',
  description: 'Send a message to the configured Discord channel',
  inputSchema: {
    type: 'object',
    properties: {
      content: { type: 'string' }
    },
    required: ['content']
  },
  execute: async ({ content }, ctx) => {
    await discordClient.send(content);
    return { sent: true };
  }
});
```

## Tool Allowlisting

Each agent scope (top-level, skill, sub-agent) carries an optional `allowedTools` set. The Tool Bus filters its list and rejects dispatch calls for tools outside the allowlist.

```ts
// Sub-agent that can only read files and search memory
const result = await subagentRun(prompt, {
  allowedTools: ['file_read', 'memory_search']
});
```

**Allowlist precedence when multiple scopes apply:**

The Tool Bus enforces the **intersection** of all active allowlists — the most restrictive set wins.

```
Agent-level allowlist:  ['bash', 'file_read', 'file_write', 'web_fetch']
Skill-level allowlist:  ['web_fetch', 'file_write']
                                  ↓ intersection
Effective allowlist:    ['web_fetch', 'file_write']
```

If a skill omits `allowedTools` (defaults to all tools), the agent-level allowlist applies unchanged. If the agent-level allowlist is also absent, all registered tools are available.

## Error Handling

Tools signal failure by throwing a `ToolError`:

```ts
class ToolError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean = false
  ) { super(message); }
}
```

The Tool Bus catches `ToolError`, serializes it as a `tool_result` with `is_error: true`, and returns it to the model so it can decide how to proceed.

## Audit Logging

Every tool call and result is appended to `.bolt/tool-audit.jsonl`:

```jsonc
{ "ts": "2026-03-21T10:00:00Z", "tool": "bash", "input": { "command": "ls" }, "result": { "stdout": "...", "exitCode": 0 } }
{ "ts": "2026-03-21T10:00:01Z", "tool": "file_write", "input": { "path": "out.md", "content": "..." }, "result": { "path": "out.md" } }
```

## Parallelism

When the model returns multiple `tool_use` blocks in one response, the Tool Bus runs them concurrently with `Promise.all`, unless a tool declares `{ sequential: true }` (e.g. tools that mutate shared state like `todo_update`).
