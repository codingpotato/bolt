# Requirements

bolt is an autonomous AI CLI agent built with TypeScript and the Anthropic SDK. It operates independently from the command line and can complete complex, multi-step tasks by combining tools, memory, skills, and sub-agent delegation.

## Functional Requirements

### Interface
- Operated entirely via the command line
- Can connect to and interact with Discord channels
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
  - **memory_search** — query the compact memory store
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

### Memory System
- Maintain in-context memory during a session
- Compact messages when approaching context window limits
- Persist compacted history for future retrieval and querying

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
