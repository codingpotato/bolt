# Requirements

bolt is an autonomous AI CLI agent built with TypeScript and the Anthropic SDK. It operates independently from the command line and can complete complex, multi-step tasks by combining tools, memory, skills, and sub-agent delegation.

## Core Design Principle: Task-Driven

**bolt operates in two modes:**

| Mode | Description |
|------|-------------|
| **Simple chat** | The user sends a message; bolt responds directly. No task is created. History is persisted and conversation continuity is maintained across sessions automatically. |
| **Task-driven** | The primary mode for structured, autonomous work. bolt breaks goals into tasks, executes them step by step, and tracks outcomes. Tasks survive process restarts, can be delegated to sub-agents, and carry their full session history. |

Tasks are the primary building block for non-trivial work, but simple chat is a first-class mode and bolt must not force users to create a task before receiving a response.

The task-driven principle shapes the heavier subsystems:
- **Memory** is organized around tasks for structured work — prior context for a task is automatically injected when the task is resumed
- **Sub-agents** are spawned to execute specific tasks — they receive a task description, not a raw prompt
- **Skills** are invoked within the context of a task — their results are recorded against the task
- **Session continuity for chat** is maintained by automatically injecting recent prior session history when no task is active

## Functional Requirements

### Interface
- Operated entirely via the command line
- Can connect to and interact with Discord channels
- **Slash commands** — CLI directives starting with `/` are intercepted before the LLM: `/exit` terminates the session, `/help` lists commands, `/session` shows the current session ID. New commands can be registered without modifying core code.
- **Planned:** web interface via `WebChannel` (HTTP/WebSocket) — not in v1 scope

### Tools Execution
- The agent must be able to call tools during its reasoning loop using the Anthropic tool-use API
- Tools are registered with a JSON schema; the model decides when and how to call them
- Tool results are fed back into the conversation and the loop continues until the model stops calling tools
- The following built-in tools are required:
  - **bash** — execute a shell command and capture stdout/stderr
  - **file_read** — read a file from disk
  - **file_write** — write or overwrite a file on disk
  - **file_edit** — apply a targeted string replacement to a file
  - **web_fetch** — fetch a URL and return the response body
  - **todo_create / todo_update / todo_list / todo_delete** — manage the todo list
  - **task_create / task_update / task_list** — manage serialized tasks
  - **skill_run** — invoke a named skill as an isolated sub-agent
  - **subagent_run** — delegate a free-form task to an isolated child agent
  - **memory_search** — query the long-term memory store (L3) by keyword or embedding
  - **memory_write** — explicitly write a fact or note to the long-term memory store (L3)
- New tools can be registered at runtime without restarting the agent
- Tools may be restricted per skill or sub-agent (allowlist model)
- All tool calls and their results must be logged for auditability

### Skills System
- Support loadable, composable skills that extend agent capabilities
- Skills are discrete, reusable capability modules (e.g. "write a blog post", "review a PR", "generate a diagram")
- Skills can be invoked by name from the CLI or by the agent itself during task execution
- Skills can be chained — the output of one skill feeds into the next
- Skills are defined as structured prompts with typed inputs and outputs
- User-defined skills can be added without modifying core agent code

### Task & Todo Management

**Todo list** — a flat, ordered checklist of immediate work items for the current session:
- Create, update, list, and delete todo items
- Execute work step by step according to the todo list

**Tasks** — structured, serializable work items with full lifecycle tracking:
- Create tasks with titles, descriptions, status, and optional subtasks
- Serialize task state to disk so sessions can be paused, resumed, or handed off after a crash
- Delegate subtasks to sub-agents; parent/child contexts are fully isolated
- Task results are persisted alongside status for auditability

### CLI Progress Output

The CLI must surface significant agent steps in real time so the user can follow what the agent is doing without waiting for the final response.

Events that must be shown:
- Session start or resume (with context injection summary)
- Model thinking (spinner while generating)
- Each tool call — name and a brief input summary
- Each tool result — success or error with a one-line summary
- Task status changes (created → in_progress → completed / failed)
- Memory compaction (how many messages were evicted)
- API retries (attempt number and reason)

Progress output is suppressed in non-TTY environments (pipes, CI) unless `--verbose` is passed. The `--quiet` flag suppresses it even on a TTY. A `ProgressReporter` interface decouples progress emission from the channel and agent loop — the CLI implementation writes to stdout; sub-agents and Discord use a no-op implementation.

### Agent Prompt System

bolt loads one or two `AGENT.md` files at startup and uses them as the system prompt:

- `~/.bolt/AGENT.md` — user-level defaults (personal style, cross-project rules)
- `.bolt/AGENT.md` — project-level rules (domain knowledge, project conventions)

Both files are optional; bolt falls back to a built-in default if neither exists. Project-level content is appended after user-level content, so it can override user-level rules.

The agent **cannot directly edit** `AGENT.md`. It may propose changes via the `agent_suggest` tool, which writes a proposal to `.bolt/suggestions/` for human review. A human applies proposals via the `bolt suggestions apply <id>` CLI command.

### Memory System

bolt uses a three-level memory architecture:

| Level | Name | Storage | Written | Purpose |
|-------|------|---------|---------|---------|
| L1 | Active context | In-process array | Always | Current session messages sent to the LLM |
| L2 | Session store | `.bolt/sessions/<id>.jsonl` | Every turn, immediately | Durable raw log of all turns; survives crashes |
| L3 | Long-term memory | `.bolt/memory/*.json` | Compaction + `memory_write` | Summarised history and agent-written facts; searchable across sessions |

Key requirements:
- Every user input, tool call, tool result, and assistant response must be persisted to L2 **before** the next turn — no data loss on crash
- Every L2 entry carries a `sessionId` and an optional `taskId`
- When the agent works on a task, the last N messages from prior sessions on that same task are automatically injected into the LLM context — no explicit search needed
- L3 is queried explicitly via `memory_search`; it is not auto-injected on every turn
- The agent can proactively write facts to L3 via `memory_write`
- Compaction (L1 → L3) is triggered when the active context approaches the token limit

### Code Workflows
- Write code, write tests, run tests, perform code review

### Content Generation
- Generate social media content: articles, images, short videos

### Authentication

bolt must support three mutually exclusive authentication modes:

| Mode | Description |
|------|-------------|
| **API Key** | User provides an `ANTHROPIC_API_KEY` environment variable; requests are authenticated via the standard Anthropic API |
| **Anthropic Subscription** | User is authenticated via an Anthropic account session (e.g. Claude.ai subscription); no API key required |
| **Local** | User points bolt at a local OpenAI-compatible inference server (llama.cpp, Ollama, etc.) via `BOLT_LOCAL_ENDPOINT`; no API key required |

- The active mode must be configurable at startup (env var, config file, or CLI flag)
- If none is configured, bolt must fail fast with a clear error message indicating how to set up authentication
- Credentials must never be logged or written to the audit log
- In local mode, no credential is required; the endpoint URL is the only required value

## Non-Functional Requirements

- **Language:** TypeScript
- **AI SDK:** Anthropic SDK
- **Isolation:** Sub-agents must not share or pollute parent agent context
- **Durability:** All task and memory state must survive process restarts
- **Extensibility:** New skills and tools can be added without modifying core agent code

## Out of Scope (v1)

- Web interface (planned for a future version as `WebChannel`)
- Multi-user / auth system
- Billing or quota management
