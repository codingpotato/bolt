# Project Plan

## Overview

15 sprints, each with a shippable increment. Every sprint follows the TDD cycle and agile process defined in `docs/workflow/`. Dependencies flow strictly — later sprints build on earlier ones.

```
 Sprint 0  — Foundation
 Sprint 1  — Auth + Channel + CLI
 Sprint 2  — Tool Bus + Core Tools
 Sprint 3  — Agent Core Loop
 Sprint 4  — Todo & Task System
 Sprint 5  — Memory System (L2 + L3 + Context Assembly)
 Sprint 6  — Sub-agent + Skills
 Sprint 7  — Web Search + User Review Tools
 Sprint 8  — WebChannel
 Sprint 9  — Content Generation + Trend Analysis
 Sprint 10 — ComfyUI Client + Video Production + Post-Production
 Sprint 11 — Simplified AGENT.md + Dynamic Skills Injection
 Sprint 12 — Enhanced File Tools (search, insert, glob, file_edit improvements)
 Sprint 13 — Video Pipeline Refactor + Subagent Visibility
 Sprint 14 — Sub-agent Internal Progress Streaming
```

---

## Sprint 0 — Project Foundation

**Goal:** Runnable TypeScript project with CI, TDD tooling, and configuration wired up. No features yet — just infrastructure.

### Stories

**S0-1: TypeScript project skeleton**

```
As a developer,
I want a compiling TypeScript project with strict mode enforced,
so that I can start building features without configuration debt.

Acceptance Criteria:
- [x] npm install, npm run build, npm run dev all work
- [x] tsconfig.json has "strict": true
- [x] No `any` types in the codebase
- [x] src/ directory layout matches docs/workflow/development.md project structure
```

**S0-2: Testing infrastructure**

```
As a developer,
I want Vitest configured with per-module coverage thresholds,
so that CI can enforce TDD without manual checks.

Acceptance Criteria:
- [x] npm test runs all *.test.ts files
- [x] npm run test:watch reruns on file change
- [x] npm run test:coverage produces a report and exits non-zero if thresholds are not met
- [x] vitest.config.ts thresholds match docs/testing/unit-testing.md
```

**S0-3: Linting and formatting**

```
As a developer,
I want ESLint and Prettier configured,
so that code style is enforced automatically.

Acceptance Criteria:
- [x] npm run lint passes on a clean repo
- [x] npm run format reformats files without errors
- [x] CI runs lint before tests
```

**S0-4: Pre-commit TDD hook**

```
As a developer,
I want the pre-commit hook installed and working,
so that I cannot accidentally commit source files without tests.

Acceptance Criteria:
- [x] scripts/pre-commit exists and is executable
- [x] Committing a new src/*.ts without a co-located *.test.ts is rejected with a clear message
- [x] Committing an existing file without a test file is allowed
- [x] Committing both a .ts and its .test.ts together is allowed
```

**S0-5: Configuration system**

```
As a developer,
I want a configuration resolver that merges env vars, .bolt/config.json, and defaults,
so that all components get their config from one source of truth.

Acceptance Criteria:
- [x] resolveConfig() returns a typed Config object
- [x] Environment variables override config file values
- [x] Config file values override defaults
- [x] Missing config file is not an error (defaults apply)
- [x] Invalid config values cause a startup error with a descriptive message
- [x] Config schema matches docs/design/configuration.md
```

**S0-5b: Enhanced configuration — full env var coverage + workspace root**

```
As a user,
I want to configure bolt entirely via environment variables or .bolt/config.json,
so that I can run bolt in Docker/containers without any config files,
and have all file operations confined to an explicit workspace root.

Acceptance Criteria:
- [x] BOLT_WORKSPACE_ROOT env var and workspace.root config key added
- [x] Workspace root validated at startup (must exist, be absolute, readable + writable)
- [x] All file operations confined to workspace root (ToolContext.cwd = workspace root)
- [x] All config sections have corresponding env vars:
      BOLT_SEARCH_PROVIDER, BOLT_SEARCH_MAX_RESULTS
      BOLT_COMFYUI_SERVERS (comma-separated URLs)
      BOLT_COMFYUI_TEXT2IMG_WORKFLOW, BOLT_COMFYUI_IMG2VIDEO_WORKFLOW
      BOLT_COMFYUI_POLL_INTERVAL_MS, BOLT_COMFYUI_TIMEOUT_MS, BOLT_COMFYUI_MAX_CONCURRENT
      BOLT_WEB_ENABLED, BOLT_WEB_HOST, BOLT_WEB_PORT, BOLT_WEB_MODE
      BOLT_FFMPEG_PATH
      BOLT_MEMORY_COMPACT_THRESHOLD, BOLT_MEMORY_KEEP_RECENT, BOLT_MEMORY_SEARCH_BACKEND
      BOLT_CLI_PROGRESS, BOLT_CLI_VERBOSE
      BOLT_AGENT_PROJECT_FILE, BOLT_AGENT_USER_FILE
      BOLT_TASKS_MAX_SUBTASK_DEPTH, BOLT_TASKS_MAX_RETRIES
      BOLT_TOOLS_TIMEOUT_MS, BOLT_TOOLS_ALLOWED (comma-separated)
      BOLT_CODE_TEST_FIX_RETRIES
- [x] .env.example template shipped with all supported variables documented
- [x] Config interface updated with workspace.root field
- [x] DEFAULTS updated with workspace.root defaulting to process.cwd()
- [x] applyEnvOverrides() handles all new env var mappings
- [x] validate() checks workspace.root is absolute and exists
- [x] Unit tests cover workspace validation, env var parsing, comma-separated lists
- [x] Design updated in docs/design/configuration.md
```

**S0-6: Audit logger**

```
As a developer,
I want a structured audit logger that writes to .bolt/tool-audit.jsonl,
so that all tool calls can be traced after the fact.

Acceptance Criteria:
- [x] log(tool, input, result) appends a JSON line to .bolt/tool-audit.jsonl
- [x] Each entry has ts, tool, input, result fields
- [x] Credentials are never written (scrubbed before logging)
- [x] .bolt/ directory is created if it does not exist
```

**S0-7: CI pipeline**

```
As a developer,
I want a CI pipeline that enforces all quality gates on every PR,
so that regressions are caught before merging.

Acceptance Criteria:
- [x] CI runs: typecheck → lint → test:coverage → build in order
- [x] Any failing step fails the whole pipeline
- [x] PR template is auto-loaded by GitHub from .github/pull_request_template.md
```

**S0-8: Structured logging system**

```
As a developer,
I want a structured JSON-line logger that writes operational logs to .bolt/bolt.log,
so that I can diagnose issues and trace agent behaviour after the fact.

Acceptance Criteria:
- [x] createLogger(logLevel, logFilePath) returns a Logger with debug/info/warn/error methods
- [x] Each log entry is a JSON line with ts, level, message, and optional meta fields
- [x] Entries below the configured log level are silently dropped
- [x] error-level entries are additionally written to stderr
- [x] .bolt/ directory is created lazily on the first write
- [x] Logger is injected into AgentCore and ToolContext; no component constructs its own logger
- [x] createNoopLogger() is available for tests
- [x] Unit tests cover entry format, level filtering, stderr routing, lazy mkdir, and error resilience
- [x] Design documented in docs/design/logging.md
```

---

## Sprint 1 — Authentication + Channel Interface + CLI Channel

**Goal:** bolt can start, authenticate against Anthropic, and receive/send messages via the CLI.

### Stories

**S1-1: Authentication — API key mode**

```
As a CLI user,
I want to authenticate with an ANTHROPIC_API_KEY environment variable,
so that I can use the Anthropic API without a subscription.

Acceptance Criteria:
- [x] resolveAuth() returns AuthConfig with mode="api-key" when ANTHROPIC_API_KEY is set
- [x] The Anthropic SDK client is constructed with the API key
- [x] The key is never logged or written to disk
- [x] Unit tests mock the environment variable
```

**S1-2: Authentication — subscription mode**

```
As a subscriber,
I want to authenticate with ANTHROPIC_SESSION_TOKEN,
so that I can use bolt without managing an API key.

Acceptance Criteria:
- [x] resolveAuth() returns AuthConfig with mode="subscription" when ANTHROPIC_SESSION_TOKEN is set
- [x] API key mode takes precedence when both env vars are set, with a warning logged
- [x] bolt exits with a clear error when neither credential is set
- [x] Sub-agents receive auth config by value at spawn time, not via process.env
```

**S1-2b: Authentication — local mode**

```
As a local user,
I want to point bolt at a local Anthropic-compatible server via BOLT_LOCAL_ENDPOINT,
so that I can run bolt without any Anthropic API key or subscription.

Acceptance Criteria:
- [x] resolveAuth() returns AuthConfig with mode="local" and localEndpoint set when BOLT_LOCAL_ENDPOINT is set
- [x] The Anthropic SDK client is constructed with baseURL set to localEndpoint
- [x] BOLT_LOCAL_API_KEY is passed as the API key if set; a placeholder is used otherwise (some SDK versions require a non-empty value)
- [x] Local mode is lowest precedence: API Key > Subscription > Local
- [x] bolt exits with a clear error when none of the three env vars is set
- [x] Sub-agents receive localEndpoint by value at spawn time, not via process.env
- [x] Unit tests mock the Anthropic SDK — no real network calls
```

**S1-3: Channel interface and UserTurn type**

```
As a developer,
I want a Channel interface that abstracts all inbound/outbound communication,
so that Agent Core is decoupled from transport details.

Acceptance Criteria:
- [x] Channel interface matches docs/design/architecture.md exactly
- [x] UserTurn type has content: string and metadata?: Record<string, string>
- [x] Interface is exported from src/channels/index.ts
- [x] Unit tests verify the interface contract with a mock implementation
```

**S1-4: CliChannel**

```
As a CLI user,
I want to interact with bolt by typing messages in the terminal,
so that I can use bolt locally without any external services.

Acceptance Criteria:
- [x] CliChannel.receive() yields UserTurns from stdin line by line
- [x] CliChannel.send() writes the response to stdout
- [x] EOF on stdin causes receive() to complete (clean shutdown)
- [x] CliChannel implements the Channel interface
```

**S1-5: CLI slash commands**

```
As a CLI user,
I want to type slash commands like /exit and /help,
so that I can control the agent session without consuming API tokens.

Acceptance Criteria:
- [x] User messages starting with / are intercepted by SlashCommandRegistry before reaching the LLM
- [x] /help lists all registered slash commands with descriptions
- [x] /exit terminates the agent loop cleanly (same as Ctrl+D / EOF)
- [x] /session shows the current session ID
- [x] Unknown commands send an error message listing available commands; no crash, no LLM call
- [x] SlashCommand interface: { name, description, execute(args, ctx) }
- [x] SlashContext interface: { send(message), sessionId }
- [x] SlashResult interface: { exit?: boolean }
- [x] New commands can be registered via SlashCommandRegistry.register()
- [x] createSlashCommandRegistry() returns a registry pre-loaded with /help, /exit, /session
- [x] Unit tests cover: /exit breaks loop, /help lists commands, /session shows ID, unknown command error, non-slash message passes through to LLM
- [x] Design documented in docs/design/slash-commands.md
```

---

## Sprint 2 — Tool Bus + Core Tools

**Goal:** The Tool Bus can register, dispatch, and audit tools. All basic tools (file, bash, web) are implemented and tested.

### Stories

**S2-1: Tool interface and Tool Bus**

```
As a developer,
I want a Tool Bus that registers and dispatches tool calls from the model,
so that tools are decoupled from the agent loop.

Acceptance Criteria:
- [x] Tool interface matches docs/design/tools-system.md (name, description, inputSchema, sequential?, execute)
- [x] ToolBus.register() adds a tool; ToolBus.list() returns it
- [x] ToolBus.dispatch() calls execute() and returns the result
- [x] Unknown tool name returns ToolError("unknown tool")
- [x] ToolBus.getAnthropicDefinitions() returns correct schema format for Anthropic API
- [x] Tool input is validated against inputSchema before execute() is called
```

**S2-2: Tool allowlisting**

```
As a developer,
I want the Tool Bus to enforce allowlists per agent scope,
so that sub-agents and skills cannot use tools outside their permitted set.

Acceptance Criteria:
- [x] ToolContext.allowedTools restricts which tools are dispatched
- [x] Dispatch of a non-allowed tool returns ToolError
- [x] Allowlist intersection applies when both agent and skill allowlists are set
- [x] undefined allowedTools means all registered tools are permitted
```

**S2-3: ToolError and audit logging**

```
As a developer,
I want tools to signal failure via ToolError and have all calls logged,
so that failures are recoverable and the audit trail is complete.

Acceptance Criteria:
- [x] ToolError(message, retryable) is serialized as tool_result with is_error: true
- [x] Every dispatch (success or failure) is written to tool-audit.jsonl
- [x] Concurrent tool calls run in parallel unless tool.sequential is true
- [x] Sequential tools run one at a time
```

**S2-4: bash tool**

```
As an agent,
I want to run shell commands and get stdout/stderr/exitCode back,
so that I can interact with the host system.

Acceptance Criteria:
- [x] bash({ command }) returns { stdout, stderr, exitCode }
- [x] Non-zero exit code does not throw — exitCode is returned in result
- [x] Execution happens in the configured cwd
- [x] Unit tests mock child_process and do not execute real shell commands
```

**S2-5: file_read, file_write, file_edit tools**

```
As an agent,
I want to read, write, and edit files on disk,
so that I can modify codebases and persist output.

Acceptance Criteria:
- [x] file_read({ path }) returns { content } or ToolError if file not found
- [x] file_write({ path, content }) writes/overwrites the file; returns { path }
- [x] file_edit({ path, oldString, newString }) replaces first occurrence; returns { path, changed }
- [x] file_edit returns changed: false (not an error) if oldString is not found
- [x] All paths are resolved relative to ToolContext.cwd
- [x] Unit tests use in-memory filesystem mock (no real disk I/O)
```

**S2-6: web_fetch tool**

```
As an agent,
I want to GET a URL and receive the response body,
so that I can research topics and fetch external content.

Acceptance Criteria:
- [x] web_fetch({ url }) returns { body, statusCode, contentType }
- [x] HTTP 4xx/5xx responses return a ToolError with the status code
- [x] Network errors return a retryable ToolError
- [x] Unit tests mock the HTTP client
```

**S2-7: Workspace safety — file confinement and dangerous bash confirmation**

```
As a user,
I want bolt to be confined to the workspace directory and to ask before running dangerous commands,
so that it cannot accidentally damage my system.

Acceptance Criteria:
- [x] file_read, file_write, file_edit reject any path that resolves outside ToolContext.cwd with a non-retryable ToolError
- [x] Rejected cases include: absolute paths outside workspace, ../.. traversal, and the workspace root itself
- [x] ToolContext gains an optional confirm?: (message: string) => Promise<boolean> callback
- [x] bash tool detects dangerous patterns (rm -r, sudo, su, | sh/bash, mkfs, dd of=, block device writes, killall, pkill, shred) and calls ctx.confirm before executing
- [x] When ctx.confirm is absent, dangerous commands are auto-denied with a non-retryable ToolError
- [x] When ctx.confirm returns false, the command is denied with a non-retryable ToolError
- [x] CliChannel.question() uses the active readline interface to prompt and return a single-line answer
- [x] CLI entry point wires confirm via channel.question(); accepts "y" or "yes"
- [x] Design documented in docs/design/workspace.md
- [x] Unit tests cover: workspace confinement (all three file tools), dangerous detection, confirm absent/false/true
```

---

## Sprint 3 — Agent Core Loop

**Goal:** bolt can have a full conversation with Claude via the Anthropic API, calling tools and looping until done.

### Stories

**S3-1: Anthropic API integration**

```
As a developer,
I want the Agent Core to call the Anthropic API with the current context and tools,
so that the model can respond with text and tool calls.

Acceptance Criteria:
- [x] Agent Core accepts a Channel and ToolBus at construction
- [x] On each turn: builds message array, calls Anthropic API, processes response
- [x] Tool calls in the response are dispatched via ToolBus
- [x] Tool results are appended to messages and the API is called again
- [x] Loop terminates when the model returns a text response with no tool calls
- [x] Final response is delivered via channel.send()
- [x] Unit tests mock the Anthropic SDK — no real API calls
```

**S3-2: API error handling and retries**

```
As a developer,
I want the Agent Core to retry on transient API failures,
so that network blips do not abort long-running sessions.

Acceptance Criteria:
- [x] 5xx and network errors are retried up to 3 times with exponential backoff
- [x] 4xx errors (auth failure, bad request) fail immediately with a clear error
- [x] Each retry attempt is logged at warn level
- [x] After 3 failed retries, the error is surfaced to the user via channel.send()
```

**S3-3: Context overflow handling**

```
As an agent,
I want the agent loop to trigger compaction when the context window is nearly full,
so that long sessions do not crash with a context overflow error.

Acceptance Criteria:
- [x] Agent Core monitors token usage in each API response
- [x] When usage exceeds memory.compactThreshold, compaction is triggered before the next call
- [x] After compaction, the API call is retried with the compacted context
- [x] A context overflow that cannot be resolved by compaction fails with a clear error
```

---

## Sprint 4 — Todo & Task System

**Goal:** The agent can manage a todo list and structured tasks, with full serialization, dependencies, and approval gates.

### Stories

**S4-1: Todo tools**

```
As an agent,
I want to create, update, list, and delete todo items,
so that I can track my immediate work items during a session.

Acceptance Criteria:
- [x] todo_create({ title }) returns { id }
- [x] todo_update({ id, status?, description? }) updates the item
- [x] todo_list() returns the current ordered list with ids, titles, and statuses
- [x] todo_delete({ id }) removes the item; ToolError if not found
- [x] todo_update is marked sequential: true
- [x] All todo tools are unit tested with mocked state
```

**S4-2: Task model and serialization**

```
As an agent,
I want tasks to be serialized after every mutation,
so that in-progress work survives process restarts.

Acceptance Criteria:
- [x] Task interface matches docs/design/task-system.md
- [x] task_create({ title, description, projectId? }) returns { id }
      - if projectId is provided: writes to projects/<project-id>/tasks.json immediately
      - otherwise: writes to .bolt/tasks.json (global tasks)
- [x] task_update({ id, status, result?, error? }) updates and re-serializes to the same file
- [x] task_list() returns all tasks (global + all active projects) with current status
- [x] On startup: .bolt/tasks.json is loaded, then projects/<id>/tasks.json is loaded for every
      project in .bolt/projects.json with non-terminal status
- [x] Corrupt task file is moved to .bolt/corrupted/ and a fresh state is used for that scope
- [x] task_update is marked sequential: true
```

**S4-3: Task execution loop**

```
As an agent,
I want to execute tasks from my task list step by step,
so that I can work through complex multi-step goals.

Acceptance Criteria:
- [x] Agent can pick the next pending task and mark it in_progress
- [x] On success, task is marked completed with a result
- [x] On failure, task is marked failed with an error reason
- [x] blocked status is set when a task cannot proceed until another completes
- [x] Execution loop continues until all tasks are completed or failed
```

**S4-4: Task dependencies**

```
As an agent,
I want tasks to declare dependencies on other tasks,
so that I can build ordered execution pipelines (e.g. video production).

Acceptance Criteria:
- [x] task_create accepts optional dependsOn: string[] parameter
- [x] Tasks created with dependsOn start in 'waiting' status; tasks without deps start in 'pending'
- [x] When all dependencies are 'completed', task transitions waiting → pending (eligible to start)
- [x] If any dependency is 'failed', dependent task is auto-failed (cascade)
- [x] Circular dependencies are detected at creation time and rejected with ToolError
- [x] task_list output includes dependsOn field and shows 'waiting' status
- [x] Unit tests cover: linear chain, fan-in, cascade failure, circular detection
```

**S4-5: Task approval gates**

```
As an agent,
I want tasks to require user approval before completing,
so that users can review creative output before expensive downstream work begins.

Acceptance Criteria:
- [x] task_create accepts optional requiresApproval: boolean (default false)
- [x] When requiresApproval is true, agent must call user_review before marking task completed
- [x] task_update to 'awaiting_approval' status is valid only when requiresApproval is true
- [x] If user rejects (provides feedback), task returns to 'in_progress' for revision
- [x] If user approves, task transitions to 'completed'
- [x] task_list output includes requiresApproval and shows 'awaiting_approval' status
- [x] Unit tests cover: approval flow, rejection with feedback, direct complete (no approval needed)
```

---

## Sprint 5 — Memory System

**Goal:** Every turn is persisted immediately. The agent automatically recalls prior work on the current task. Compacted history and agent notes are searchable across sessions.

### Stories

**S5-1: Agent prompt system (AGENT.md)** ✅

```
As a user,
I want to define bolt's identity, rules, and domain knowledge in a Markdown file,
so that I can tailor bolt's behaviour for my project without modifying code.

Acceptance Criteria:
- [x] On first startup, bolt copies the built-in AGENT.md to .bolt/AGENT.md if it does not exist
- [x] On subsequent startups, .bolt/AGENT.md is loaded as-is
- [x] The loaded prompt is used as the system field in every Anthropic API call for the session
- [x] The prompt is never modified mid-session
- [x] The built-in AGENT.md is shipped with bolt (src/AGENT.md in dev, dist/AGENT.md in prod)
- [x] agentPrompt.projectFile config key overrides the default path
- [x] Unit tests cover: first run (copies built-in), subsequent run (loads existing), custom path
```

**S5-2: ProgressReporter interface and CliProgressReporter**

```
As a CLI user,
I want to see what the agent is doing at each significant step in real time,
so that I can follow progress without waiting for the final response.

Acceptance Criteria:
- [x] ProgressReporter interface matches docs/design/cli-progress.md
      (onSessionStart, onThinking, onToolCall, onToolResult, onTaskStatusChange,
       onContextInjection, onMemoryCompaction, onRetry)
- [x] NoopProgressReporter implements all methods as no-ops; used by sub-agents and tests
- [x] CliProgressReporter writes formatted output matching the examples in docs/design/cli-progress.md
- [x] CliProgressReporter only writes when process.stdout.isTTY is true or --verbose is passed
- [x] --quiet flag suppresses all progress output even on a TTY
- [x] CliProgressReporter summarises tool inputs per the table in docs/design/cli-progress.md
      (bash shows command, file tools show path, web_fetch shows URL, default truncates JSON)
- [x] CliProgressReporter manages the "Thinking…" line (replaces CliChannel's current implementation)
- [x] ProgressReporter is added to ToolContext; AgentCore, ToolBus, and MemoryManager accept it
- [x] AgentCore emits: onSessionStart (startup), onThinking (before each API call), onRetry
- [x] ToolBus emits: onToolCall (before dispatch), onToolResult (after dispatch)
- [x] Unit tests cover: TTY mode shows output, non-TTY suppresses output, --quiet suppresses output,
      input summarisation for each built-in tool, NoopProgressReporter emits nothing
```

**S5-3: Session Store (L2) — per-turn persistence with daily rotation**

```
As a developer,
I want every turn written to disk immediately with daily log rotation,
so that no conversation history is lost on crash or clean exit, and log files remain bounded
for a 7×24 continuously running agent.

Acceptance Criteria:
- [x] A sessionId (UUID v4) is generated at process startup and passed through AgentCore
- [x] --session <id> CLI flag resumes an existing session (queries L2 by sessionId)
- [x] SessionEntry interface matches docs/design/memory-system.md (sessionId, seq, ts, taskId?, date, role, content)
- [x] Memory Manager appends a SessionEntry to .bolt/sessions/YYYY-MM-DD.jsonl (UTC date) on every:
      user turn, assistant response, tool call, and tool result
- [x] The date file is determined at write time from the current UTC date — a new file is opened
      automatically at midnight without restarting the process
- [x] Write happens before the next LLM call — a crash mid-turn loses at most one in-flight entry
- [x] Task model gains a sessionIds: string[] field; the current sessionId is appended when a task transitions to in_progress
- [x] Session resume (--session <id>) scans date files in reverse chronological order to find entries
      matching the given sessionId
- [x] Corrupt session files: partial entries at end of file are truncated; valid entries before the
      corruption are loaded normally
- [x] Unit tests use an in-memory filesystem mock; no real disk I/O
```

**S5-4: Long-term memory store (L3) — persistence**

```
As an agent,
I want compacted summaries and agent notes persisted to disk,
so that I can retrieve cross-session knowledge in future runs.

Acceptance Criteria:
- [x] CompactEntry interface matches docs/design/memory-system.md (id, type, sessionId, taskId?, createdAt, date, summary, messages?, tags)
- [x] Entries are written as JSON files in .bolt/memory/<id>.json
- [x] On startup, all .bolt/memory/ files are loaded; corrupt files are skipped with a warning
- [x] Corrupt entry files are moved to .bolt/corrupted/ and do not block startup
```

**S5-5: Memory Manager — context assembly and task history injection**

```
As an agent,
I want prior work on my current task automatically included in my context,
so that I can resume a task across sessions without manually searching for history.

Acceptance Criteria:
- [x] Memory Manager assembles the LLM message array on each turn: system prompt → task history → L1 active context
- [x] When a task is active, Memory Manager reads .bolt/sessions/ for entries tagged with the current taskId
- [x] The last memory.taskHistoryMessages entries (across all prior sessions for the task) are injected as a read-only context block
- [x] Injected history is capped at memory.taskHistoryTokenBudget tokens; oldest entries are dropped if over budget
- [x] The compaction threshold check uses only L1 token count, not injected history tokens
- [x] When --session <id> is used with no active task, the last memory.keepRecentMessages entries from the resumed session are injected
- [x] When no task is active and no --session flag is given, and memory.injectRecentChat is true (default), the last memory.keepRecentMessages entries from the most recent prior session are injected (chat continuity)
- [x] When no task is active, no --session flag, and memory.injectRecentChat is false, no history is injected
- [x] Unit tests cover: task with prior sessions (injection + token budget), session resume, chat continuity injection, chat continuity disabled, first-ever session (no injection)
```

**S5-6: Memory Manager — compaction (L1 → L3)**

```
As an agent,
I want my active context compacted before messages are dropped,
so that I never silently lose information during long sessions.

Acceptance Criteria:
- [x] Memory Manager tracks L1 token count from each API response (excluding injected history)
- [x] When L1 count exceeds memory.compactThreshold × context_window, compaction is triggered
- [x] The memory.keepRecentMessages most recent messages are always retained in L1
- [x] Evicted messages are summarised by calling the model
- [x] A CompactEntry (type: 'compaction') is written to .bolt/memory/ before eviction; entry includes sessionId, taskId, summary, raw messages, tags, date
- [x] Active context (L1) is replaced with a single summary stub message
- [x] Unit tests mock the Anthropic API summary call
```

**S5-7: memory_search tool — keyword backend**

```
As an agent,
I want to search my long-term memory by keyword,
so that I can recall relevant facts and summaries from past sessions.

Acceptance Criteria:
- [x] memory_search({ query, limit?, taskId?, dateFrom?, dateTo? }) returns matching L3 entries
- [x] Default limit is 5; results are ranked by relevance (BM25-style over summary and tags)
- [x] taskId filter restricts results to entries from a specific task
- [x] dateFrom / dateTo filters restrict results by the date field (YYYY-MM-DD)
- [x] memory_search is registered as a built-in tool
- [x] Returns empty results (not an error) when no matches found
- [x] Unit tests cover: keyword match, taskId filter, date filter, empty results
```

**S5-8: memory_write tool**

```
As an agent,
I want to explicitly write facts and notes to long-term memory,
so that I can persist cross-task knowledge that would not otherwise be compacted.

Acceptance Criteria:
- [x] memory_write({ content, tags? }) creates a CompactEntry with type: 'agent_note' in .bolt/memory/
- [x] Entry carries the current sessionId and taskId (if active)
- [x] Returns { id } of the created entry
- [x] memory_write is registered as a built-in tool
- [x] Unit tests verify entry is written with correct fields
```

---

## Sprint 6 — Sub-agent Runner + Skills System

**Goal:** The agent can delegate tasks to isolated child agents and invoke skills.

### Stories

**S6-1: Sub-agent runner**

```
As an agent,
I want to spawn isolated child agent processes for subtasks,
so that delegated work cannot corrupt my context.

Acceptance Criteria:
- [x] subagent_run({ prompt, allowedTools? }) spawns a child process
- [x] Child has no access to parent message history, memory, or tasks
- [x] Auth config is passed by value at spawn time (not from child process.env)
- [x] Child result is returned as a structured response to the parent
- [x] Non-zero exit code from child marks the delegated task as failed with stderr
- [x] allowedTools in subagent_run are intersected with parent allowedTools
```

**S6-2: Skill file loader**

```
As a developer,
I want bolt to discover and load .skill.md files from three locations in priority order,
so that users can add custom skills without modifying core code and built-in skills are always available.

Acceptance Criteria:
- [x] Skills are loaded from three locations in priority order:
      1. .bolt/skills/         (project-local, highest priority)
      2. ~/.bolt/skills/       (user-global)
      3. BUILTIN_SKILLS_DIR    (bolt built-ins from src/skills/ or dist/skills/)
- [x] Name collision: higher-priority tier silently shadows lower-priority definition
- [x] BUILTIN_SKILLS_DIR is exported from src/assets.ts as join(__dirname, 'skills'),
      resolving to src/skills/ in dev (tsx) and dist/skills/ in prod (node dist/) automatically
- [x] Skill frontmatter (name, description, inputSchema, outputSchema, allowedTools?) is parsed
- [x] Body of the .skill.md file becomes the system prompt
- [x] Invalid frontmatter emits a warning and skips the skill
- [x] /skills slash command displays all discovered skills with their source tier
```

**S6-3: skill_run tool and execution flow**

```
As an agent,
I want to invoke a named skill with typed arguments,
so that I can use composable capabilities during task execution.

Acceptance Criteria:
- [x] skill_run({ name, args }) validates args against inputSchema; ToolError on invalid args
- [x] Skill runs as an isolated sub-agent with skill.systemPrompt as system turn
- [x] Effective tool allowlist is intersection of skill.allowedTools and agent allowedTools
- [x] Result is validated against outputSchema; ToolError on invalid output
- [x] skill_run can be invoked from the interactive session via /run-skill slash command
```

**S6-4: Built-in skills**

```
As a developer,
I want the built-in skills shipped with bolt,
so that common capabilities are available without user configuration.

Acceptance Criteria:
- [x] write-blog-post skill is discoverable and invokable
- [x] review-code skill returns a CodeReviewResult (summary, issues[], approved)
- [x] generate-image-prompt skill returns a plain text prompt
- [x] generate-video-script skill returns a structured storyboard (script + scenes)
- [x] generate-video-prompt skill returns a motion/animation prompt
- [x] summarize-url skill fetches a URL and returns a structured summary
- [x] draft-social-post skill returns a short-form post for a given platform
- [x] Each skill has an input schema, output schema, and system prompt
- [x] Each skill has unit tests that mock the sub-agent execution
- [x] Note: analyze-trends skill is NOT included here — it depends on web_search (S7-2) and is implemented in S9-1
```

---

## Sprint 7 — Web Search + User Review Tools

**Goal:** The agent can search the web for trend research and present content for interactive user review.

### Stories

**S7-1: Web search provider abstraction**

```
As a developer,
I want a pluggable search provider interface,
so that bolt can switch between SearXNG (development) and paid APIs (production).

Acceptance Criteria:
- [x] SearchProvider interface: search(query, options) → SearchResult[]
- [x] SearXNGProvider implements the interface; calls local SearXNG JSON API
- [x] BraveProvider implements the interface; calls Brave Search API with BOLT_SEARCH_API_KEY
- [x] SerperProvider implements the interface; calls Serper API with BOLT_SEARCH_API_KEY
- [x] Provider is selected by config.search.provider (default: "searxng")
- [x] Provider connection is validated at startup; warning logged if unreachable
- [x] Unit tests mock HTTP calls for all three providers
```

**S7-2: web_search tool**

```
As an agent,
I want to search the web by keyword and receive structured results,
so that I can research trending topics and gather information.

Acceptance Criteria:
- [x] web_search({ query, maxResults?, timeRange?, category? }) returns { results[] }
- [x] Each result has title, url, snippet, and optional date and source fields
- [x] maxResults defaults to config.search.maxResults (10)
- [x] timeRange filters results by recency (day, week, month, year)
- [x] category supports general, news, images, videos
- [x] Network/API errors return a retryable ToolError
- [x] web_search is registered as a built-in tool
- [x] Unit tests mock the search provider
```

**S7-3: user_review tool**

```
As an agent,
I want to present content for user review and collect approval or feedback,
so that the user can guide creative decisions before expensive operations.

Acceptance Criteria:
- [x] user_review({ content, contentType, question, mediaFiles? }) returns { approved, feedback? }
- [x] contentType supports: script, storyboard, image_prompt, video_prompt, image, video, text
- [x] CliChannel renders content as formatted text; prompts [approve/reject/feedback]:
- [x] When channel.requestReview is available, delegates to it (enables rich WebChannel UI later)
- [x] When channel has no requestReview, falls back to ctx.confirm + text display
- [x] mediaFiles paths are validated to exist before presenting
- [x] user_review is registered as a built-in tool
- [x] Unit tests mock the channel interaction
```

---

## Sprint 8 — WebChannel ✅

**Goal:** bolt serves a web chat interface over HTTP/WebSocket, accessible from phone or desktop browser.

### Stories

**S8-1: WebChannel HTTP + WebSocket server**

```
As a blogger,
I want to access bolt via a web browser on my phone,
so that I can control content generation without a terminal.

Acceptance Criteria:
- [x] WebChannel implements the Channel interface
- [x] Starts an HTTP server on config.channels.web.port (default 3000)
- [x] WebSocket mode: persistent connection for bidirectional messaging
- [x] HTTP mode: POST /chat for user turns, SSE for streaming responses
- [x] Simple token authentication via BOLT_WEB_TOKEN or config.channels.web.token
- [x] Server only starts when config.channels.web.enabled is true
- [x] Any number of WebSocket connections may connect simultaneously; all can send messages
- [x] Unit tests mock the HTTP server
```

**S8-2: Web chat frontend**

```
As a blogger,
I want a responsive chat UI in my browser,
so that I can interact with bolt from my phone or desktop.

Acceptance Criteria:
- [x] Single-file HTML (public/index.html) with vanilla JS and responsive CSS
- [x] Mobile-first design; usable on phones and desktops
- [x] Message list with user/agent bubbles, auto-scroll
- [x] Text input with send button
- [x] WebSocket connection with auto-reconnect
- [x] Progress indicators for agent thinking and tool execution
- [x] No build tools required — served directly by the HTTP server
- [x] All connected users see all messages (user messages and Bolt responses) in real time
- [x] Each message bubble shows the author name
```

**S8-3: Rich review UI in WebChannel**

```
As a blogger,
I want to review content with approve/reject buttons and see image/video previews,
so that I can make creative decisions from my phone.

Acceptance Criteria:
- [x] WebChannel.requestReview() sends a rich message with content, media previews, and action buttons
- [x] Approve button sends { approved: true } back to the agent
- [x] Reject button shows a text input for feedback, then sends { approved: false, feedback }
- [x] Image files are served via static file endpoint and displayed inline
- [x] Video files are served via static file endpoint and playable inline
- [x] Markdown content is rendered as formatted HTML
- [x] WebChannel.sendMedia() sends image/video with optional caption
```

**S8-4: WebChannel daemon mode**

```
As a blogger,
I want bolt to stay running as a background service,
so that I can connect to it from my phone at any time.

Acceptance Criteria:
- [x] bolt serve CLI command starts bolt in daemon mode with WebChannel
- [x] Agent stays alive between conversations, listening for new WebSocket connections
- [x] All connections can send messages; Bolt processes them sequentially from a shared queue
- [x] Graceful shutdown on SIGTERM/SIGINT
- [x] Session state is preserved between conversations
```

**S8-5: Multi-user shared conversation**

```
As a team of bloggers,
I want multiple people to send messages to bolt from their own devices,
so that we can collaborate on content creation in real time.

Acceptance Criteria:
- [x] Each WebSocket client identifies itself via ?name= query param; defaults to User1, User2, … (server-assigned counter)
- [x] Duplicate names are allowed without enforcement
- [x] UserTurn gains an optional author field; WebChannel populates it from the connection's name
- [x] When a user sends a message, server immediately broadcasts { type: "user_message", author, content, queuePosition } to all clients before Bolt processes it
- [x] Turns are appended to the shared turnQueue (FIFO); Bolt processes one at a time
- [x] Server broadcasts { type: "queue_status", depth } whenever the queue length changes
- [x] When Bolt dequeues a turn, server broadcasts { type: "processing", author, content } to all clients
- [x] Bolt's response is broadcast as { type: "response", content, replyTo: author } so all users see whose message was answered
- [x] Review requests (requestReview) are broadcast to all clients; first reply wins
- [x] AgentCore prefixes the LLM message with [Author]: when author is set
- [x] Frontend: username prompt on load if ?name= is absent; input is always enabled (no read-only mode)
- [x] Frontend: three distinct bubble styles — own messages (right, highlighted), others' messages (left, muted), Bolt responses (left, distinct color)
- [x] Frontend: queue indicator shows depth and "Processing Alice's message…" status
- [x] On connect, server sends { type: "status", userId, connectedUsers, queueDepth }
- [x] SSE / HTTP mode remains single-user and is unchanged
- [x] Unit tests cover: multi-client broadcast, queue ordering, author prefix in LLM message
```

---

## Sprint 9 — Content Generation + Trend Analysis

**Goal:** The agent can research trends, generate content for social media platforms, and produce video storyboards with structured output.

### Stories

**S9-1: analyze-trends skill**

```
As a blogger,
I want bolt to search and analyse trending topics,
so that I can create content based on what is currently popular.

Acceptance Criteria:
- [x] analyze-trends skill accepts { topic?, platforms?, timeRange? } input
- [x] Uses web_search to find trending content across platforms
- [x] Uses web_fetch to deep-read top results for details
- [x] Returns structured report: { trends[], recommendedAngles[], topPosts[] }
- [x] Each trend has title, platform, engagement metrics (if available), and content angle
- [x] Skill has unit tests with mocked web_search and web_fetch
```

**S9-2: Content generation skills**

```
As a blogger,
I want bolt to generate blog posts, social posts, and video scripts,
so that I can produce content at scale.

Acceptance Criteria:
- [x] write-blog-post produces well-structured Markdown given topic + tone
- [x] draft-social-post produces platform-appropriate copy (Twitter, LinkedIn, Xiaohongshu, etc.)
- [x] generate-video-script produces a structured Storyboard (title, summary, scenes[])
- [x] Each scene includes: description, dialogue, camera, duration, imagePromptHint, characterIds, transitionTo
- [x] generate-image-prompt creates prompts optimised for the Z-SNR image turbo model (4-component structure: subject, environment, style, composition)
- [x] generate-video-prompt creates motion prompts for image-to-video generation
- [x] Skills can optionally use web_search and web_fetch to research before writing
- [x] Skills can be chained: summarize-url output feeds into write-blog-post
```

**S9-3: Code review skill**

```
As a developer,
I want bolt to review code and return a structured report,
so that I can get automated feedback on my code.

Acceptance Criteria:
- [x] review-code skill accepts { path?, diff? } input
- [x] Returns CodeReviewResult: { summary, issues[], approved }
- [x] Each issue has severity ("error"|"warning"|"suggestion"), file, line?, message
- [x] Uses file_read to read source files if path is provided
- [x] Skill has unit tests with mocked sub-agent execution
```

**S9-4: Automated test-and-fix workflow**

```
As an agent,
I want to run a test suite, read failures, attempt fixes, and retry,
so that I can autonomously fix broken tests.

Acceptance Criteria:
- [x] Agent runs bash({ command: "npm test" }) and interprets output
- [x] On test failure: reads error output, identifies failing file/assertion
- [x] Applies a targeted fix via file_edit or file_write
- [x] Retries the test run; max retries from codeWorkflows.testFixRetries (default 3)
- [x] Reports final pass/fail status after exhausting retries
```

---

## Sprint 10 — ComfyUI Client + Video Production + Post-Production

**Goal:** bolt can generate images and videos via a pool of ComfyUI servers, orchestrate the full video production pipeline, and assemble a final video with merged clips, audio, and subtitles using FFmpeg.

### Stories

**S10-1: ComfyUI Pool** ✅

```
As a developer,
I want a ComfyUIPool module that manages a pool of ComfyUI servers,
so that image and video generation is load-balanced and fault-tolerant.

Acceptance Criteria:
- [x] ComfyUIPool reads server configs from config.comfyui.servers[]
- [x] ComfyUIPool.init() pings each server's GET /system_stats at startup; unreachable servers are excluded with a warning logged
- [x] ComfyUIPool.selectServer() queries GET /queue on each active server and selects the one with lowest queue_remaining / weight score
- [x] Falls back to round-robin if all servers fail the queue query
- [x] ComfyUIPool.uploadImage(localPath, server) POSTs to /upload/image and returns the server filename
- [x] ComfyUIPool.queueWorkflow(workflow, server) POSTs to /prompt and returns the promptId
- [x] ComfyUIPool.pollResult(promptId, server, timeoutMs) polls GET /history/{id} every config.comfyui.pollIntervalMs until completed or timeout
- [x] ComfyUIPool.downloadOutput(file, server, localPath) downloads from GET /view and writes to localPath
- [x] patchWorkflow(workflow, patch) deep-merges a parameter patch into a workflow JSON before submission
- [x] Workflow template files are loaded from config.comfyui.workflows.{text2img,img2video}
- [x] ComfyUIPool.resolveWorkflow(name) checks .bolt/workflows/<name>.json first (user override),
      then BUILTIN_WORKFLOWS_DIR/<name>.json (bolt built-in); ToolError if neither exists
- [x] ComfyUIPool.loadWorkflow(name) loads both the workflow JSON and its companion .patchmap.json
- [x] WorkflowPatchmap schema: { outputNode, imageNode?, imageField?, params: Record<string, Array<{nodeId, field}>> }
- [x] BUILTIN_WORKFLOWS_DIR is exported from src/assets.ts alongside BUILTIN_SKILLS_DIR;
      resolves to src/workflows/ in dev and dist/workflows/ in prod via __dirname anchor
- [x] scripts/copy-assets.js copies all src/workflows/*.json (workflows + patchmaps) → dist/workflows/ on build
- [x] All paths passed to uploadImage/downloadOutput are validated within workspace root
- [x] Unit tests mock HTTP calls to ComfyUI servers
- [x] Design documented in docs/design/comfyui-client.md
```

**S10-2: comfyui_text2img and comfyui_img2video tools** ✅

```
As an agent,
I want built-in tools to generate images and video clips via ComfyUI,
so that I can produce media assets during the video production pipeline.

Acceptance Criteria:
- [x] comfyui_text2img({ prompt, width?, height?, steps?, seed?, outputPath })
      returns { outputPath, seed, durationMs }
      — uses image_z_image_turbo workflow; no negativePrompt (workflow uses ConditioningZeroOut)
      — patches: 57:27.text, 57:13.{width,height}, 57:3.{steps,seed}; output from node "9"
- [x] comfyui_img2video({ imagePath, prompt, negativePrompt?, width?, height?, frames?, fps?, seed?, outputPath })
      returns { outputPath, durationMs }
      — uses video_ltx2_3_i2v workflow (LTX-Video 2.3 22B)
      — uploads imagePath to server; patches 269.image with returned filename
      — patches: 267:266.value (prompt → Gemma enhancer), 267:247.text (negative),
        267:257.value (width), 267:258.value (height), 267:225.value (frames),
        267:260.value (fps), 267:216.noise_seed + 267:237.noise_seed (seed)
      — output from node "75"
- [x] Both tools call ComfyUIPool.selectServer(), load workflow+patchmap, build patch, queue, poll, download, write outputPath
- [x] comfyui_img2video uploads the source image to the selected server before queuing
- [x] Both tools emit poll-cycle progress events to ProgressReporter
- [x] No ComfyUI servers configured → non-retryable ToolError
- [x] Workflow file not found → non-retryable ToolError
- [x] All servers unreachable → retryable ToolError
- [x] Poll timeout → retryable ToolError
- [x] Both tools enforce workspace confinement on all path arguments
- [x] Both tools are registered as built-in tools
- [x] Unit tests mock ComfyUIPool
```

**S10-3: Video production workflow** ✅

```
As a blogger,
I want bolt to orchestrate the full video production pipeline,
so that I can go from a topic to finished video clips with human-in-the-loop review.

Acceptance Criteria:
- [x] Agent creates a content project directory projects/<project-id>/ with project.json manifest and tasks.json at workflow start
- [x] project.json manifest schema matches docs/design/content-generation.md (ContentProject interface — no taskIds field)
- [x] Project is registered in .bolt/projects.json on creation
- [x] Agent creates a task DAG for video production (analyze → script → image prompts → images → video prompts → videos)
      using task_create with projectId; tasks are serialized to projects/<project-id>/tasks.json
- [x] Each task has dependsOn linking to previous step; each task has requiresApproval: true
- [x] First task result stores { projectId, manifestPath } as JSON so all downstream tasks can locate the manifest
- [x] Each task reads project.json via file_read to find input artifacts; writes outputs to the scene directory
- [x] Manifest artifact status is updated to 'draft' after generation, 'approved' after user_review approval
- [x] comfyui_text2img generates images saved to projects/<id>/scenes/scene-<NN>/image.png
- [x] comfyui_img2video generates video clips saved to projects/<id>/scenes/scene-<NN>/clip.mp4
- [x] User can reject and request changes at any gate; agent revises and re-presents; manifest status reflects rejections
- [x] Integration test covers the full pipeline with mocked ComfyUIPool and channel

Review Fixes:
- [x] createProject() detects existing project directories and disambiguates ID with -2, -3, etc.
- [x] updateArtifactStatus() clears approvedAt when status changes from approved
- [x] updateArtifactStatus() returns boolean indicating success/failure
- [x] getProjectFilePath() validates path containment to prevent directory traversal
- [x] Test "detects circular dependencies" renamed to accurately reflect it tests DAG shapes
- [x] Test assertions parse JSON result instead of substring matching
- [x] Added tests for comfyui_text2img/comfyui_img2video optional parameters
- [x] Added tests for tool-bus summariseResult and validateRequired branches
```

**S10-4: Task completion notification via channel** ✅

```
As a user,
I want bolt to tell me when a long-running task finishes,
so that I know the result without having to watch the screen.

Acceptance Criteria:
- [x] When a task completes (success or failure), AgentCore sends a completion message through the active channel
- [x] CliChannel: prints a formatted completion line to stdout, e.g. "✓ Task completed: <title>" or "✗ Task failed: <title> — <reason>"
- [x] WebChannel: broadcasts a { type: "task_complete", title, status, result? } WebSocket event to all connected clients
- [x] Completion message is sent regardless of whether the agent is still in an active conversation turn
- [x] Unit tests cover CliChannel and WebChannel completion message paths
```

**S10-5: Content project tools + comfyUI workspace fix** ✅

```
As an agent,
I want built-in tools to create and manage content project manifests,
so that I can set up the project directory and track artifact status
without using raw file_write / bash calls, and so that all generated
files land inside the workspace.

Acceptance Criteria:
- [x] content_project_create({ topic, title? }) wraps ContentProjectManager.createProject()
      and returns { projectId, manifestPath, tasksPath, projectDir }
      - creates projects/<id>/ with scenes/ and final/ subdirectories
      - writes initial project.json (no taskIds field — tasks live in tasks.json)
      - creates empty projects/<id>/tasks.json
      - registers project in .bolt/projects.json (appends { projectId, status: 'active', dir })
- [x] content_project_read({ projectId }) wraps ContentProjectManager.readProject()
      and returns the full ContentProject manifest; ToolError if not found
- [x] content_project_update_artifact({ projectId, artifactPath, status }) wraps
      ContentProjectManager.updateArtifactStatus(); returns { updated: boolean }
- [x] All three tools are marked sequential: true (shared manifest state)
- [x] All three tools are registered as built-in tools
- [x] All three tools are documented in docs/design/tools-system.md and
      docs/design/content-generation.md (Content Project Tools section)
- [x] Unit tests cover: create project (directory + manifest + tasks.json + projects.json written),
      read project (returns manifest, error when missing),
      update artifact status (approved/failed/not-found)
- [x] comfyui_text2img: outputPath is resolved against ctx.cwd; path containment check
      rejects any path outside workspace with non-retryable ToolError before pool.downloadOutput
- [x] comfyui_img2video: outputPath and imagePath are both resolved against ctx.cwd;
      containment check applied to both before any pool operation
- [x] Unit tests for both comfyUI tools cover: path within workspace (allowed),
      absolute path outside workspace (rejected), traversal path (rejected)
```

**S10-6: FFmpeg Runner** ✅

```
As a developer,
I want a local FFmpeg wrapper that bolt's video tools can use,
so that post-production operations run reliably on the host machine.

Acceptance Criteria:
- [x] FfmpegRunner.detect() resolves the ffmpeg binary from config.ffmpeg.path or system PATH
- [x] Missing ffmpeg logs a startup warning; bolt does not exit
- [x] FfmpegRunner.run(args, opts) spawns ffmpeg, streams stderr, and resolves FfmpegResult on exit code 0
- [x] Progress lines from ffmpeg stderr are parsed and forwarded to ProgressReporter (frame, speed, time)
- [x] Non-zero exit code rejects with FfmpegError carrying stderr and exitCode
- [x] SIGKILL/SIGTERM exit is treated as retryable; other non-zero exits are non-retryable
- [x] All paths passed to the runner are validated to be within context.cwd (workspace confinement)
- [x] config.ffmpeg.path, videoCodec, crf, preset, audioCodec, audioBitrate are respected
- [x] Unit tests mock child_process.spawn
```

**S10-7: Video editing tools (video_merge, video_add_audio, video_add_subtitles)** ✅

```
As an agent,
I want tools to merge video clips and add audio and subtitles using FFmpeg,
so that I can assemble a final deliverable video from scene clips.

Acceptance Criteria:
- [x] video_merge({ clips, outputPath, reencode? }) concatenates ≥ 2 clips via ffmpeg concat demuxer
- [x] video_merge falls back to re-encode pass if stream-copy fails due to mismatched codecs/resolution
- [x] video_add_audio({ videoPath, audioPath, outputPath, mode, audioVolume, originalVolume, fitToVideo })
      supports replace mode (discard original audio) and mix mode (amix filter)
- [x] video_add_subtitles({ videoPath, subtitlesPath, outputPath, mode, language, fontSize, fontColor })
      supports soft (mov_text embedded track) and hard (subtitles filter burned in) modes
- [x] .vtt subtitle files are converted to .srt in a temp file before hard-burn (ffmpeg compatibility)
- [x] All three tools enforce workspace confinement on every path argument
- [x] Missing ffmpeg returns non-retryable ToolError from all three tools
- [x] Progress events are emitted to ProgressReporter during encoding
- [x] All three tools are registered as built-in tools
- [x] Unit tests mock FfmpegRunner
```

**S10-8: Post-production workflow integration**

```
As a blogger,
I want bolt to automatically merge my scene clips and optionally add audio and subtitles,
so that I get a polished final video without running FFmpeg commands manually.

Acceptance Criteria:
- [x] After S10-3 video generation completes, agent creates post-production tasks in the existing DAG:
      mergeClips → addAudio (optional) → addSubtitles (optional)
- [x] mergeClips task calls video_merge with all approved clips, saves to final/raw.mp4, updates manifest
- [x] If user has provided an audio file, addAudio task calls video_add_audio; result saved to final/audio.mp4
- [x] If storyboard contains dialogue, agent generates scenes/subtitles.srt from storyboard dialogue and
      scene durations, then calls video_add_subtitles; result saved to final/video.mp4
- [x] The last completed post-production step's output is linked as final/video.mp4 in the manifest
- [x] Each post-production task has requiresApproval: true; user can reject and trigger a redo
- [x] project.json manifest postProduction fields are updated after each step
- [x] Integration test covers merge + audio + subtitles with mocked FfmpegRunner and channel
```

**S10-9: `produce-video` orchestrator skill** ✅

```
As a blogger,
I want to say "make a video about X" and have bolt handle the entire pipeline,
so that I don't need to manually invoke each production step.

Acceptance Criteria:
- [x] produce-video.skill.md created in src/skills/ with:
      - input schema: { topic, title?, targetPlatform?, audioFile?, projectId? }
      - output schema: { projectId, manifestPath, finalVideoPath }
      - allowedTools: content_project_create, content_project_read,
        content_project_update_artifact, task_create, task_update, task_list,
        skill_run, user_review, file_read, file_write
- [x] Skill system prompt encodes the full pipeline sequence:
      1. If projectId is provided, read project.json and resume from last incomplete step
      2. Else call content_project_create to initialize the project
      3. Create the full task DAG (analyzeTrends → generateScript → generateImagePrompts
         → generateImages → generateVideoPrompts → generateVideos → mergeClips
         → addAudio (if audioFile provided) → addSubtitles (if storyboard has dialogue))
      4. Store { projectId, manifestPath } in the analyzeTrends task result
      5. For each task: invoke the matching sub-skill, present via user_review,
         call content_project_update_artifact on approval, then mark task completed
      6. Return { projectId, manifestPath, finalVideoPath } on full completion
- [x] produce-video is listed in the Built-in Skills table in docs/design/skills-system.md
- [x] Skill is discoverable via /skills and invocable via /run-skill produce-video
- [x] Unit tests verify skill metadata (name, input/output schema, allowedTools, system prompt)
      and invocation via skill_run returns a structured project reference
- [x] Resume flow: when projectId input is provided, skill reads project.json,
      identifies the first task without status 'completed', and continues from there
      without recreating the project or the DAG
```

---

## Sprint 11 — Simplified AGENT.md + Dynamic Skills Injection

**Goal:** AGENT.md simplified to a single workspace file initialized from built-in default. Skills and tools catalogs dynamically injected into system prompt. Hardcoded tables removed. Token size tracking, hot-reload, and sub-agent rule inheritance added.

### Stories

**S11-1: Simplified AGENT.md — single workspace file + dynamic skills and tools injection**

```
As a user,
I want a single AGENT.md file in my workspace that is initialized from the built-in
default and automatically includes catalogs of available skills and tools,
so that I have one clear place to customize bolt and the agent always knows
what skills and tools are available — including custom skills I add.

Acceptance Criteria:
- [x] Remove user-level AGENT.md (~/.bolt/AGENT.md) — only workspace .bolt/AGENT.md exists
- [x] loadAgentPrompt() simplified: reads .bolt/AGENT.md, copies built-in if missing
- [x] Built-in AGENT.md content is always the base — user edits .bolt/AGENT.md directly
- [x] Dynamic skills catalog appended to system prompt at startup from loaded Skill[] array
- [x] Dynamic tools reference appended to system prompt at startup from ToolBus registry
- [x] Hardcoded skills table removed from src/AGENT.md
- [x] Hardcoded tools reference table removed from src/AGENT.md
- [x] Skills section lists all discovered skills (built-in + user + project) with name + description
- [x] Tools section lists all registered tools with name + one-line use-case summary
- [x] Config removed: agentPrompt.userFile, BOLT_AGENT_USER_FILE env var
- [x] Works identically in dev (npm run dev) and prod (npm start / npm run build)
- [x] Unit tests cover: first run copies built-in, subsequent run loads existing,
      skills catalog appended, tools reference appended, custom path via config
- [x] Design updated in docs/design/agent-prompt.md
- [x] Configuration docs updated in docs/design/configuration.md
```

**S11-1b: Token size tracking for system prompt**

```
As a user,
I want bolt to warn me when my AGENT.md is too large,
so that I don't accidentally consume most of the context window with instructions.

Acceptance Criteria:
- [x] After system prompt assembly, bolt estimates token count (~1.3 tokens per word)
- [x] If estimate exceeds agentPrompt.maxTokens (default 8000), a warning is logged at startup
- [x] Warning message includes estimated token count and threshold
- [x] BOLT_AGENT_MAX_TOKENS env var overrides the default threshold
- [x] agentPrompt.maxTokens config key in .bolt/config.json overrides the default
- [x] Unit tests cover: under threshold (no warning), over threshold (warning logged),
      custom threshold via config, custom threshold via env var
```

**S11-1c: Hot-reload for AGENT.md**

```
As a user,
I want bolt to pick up changes to my AGENT.md without restarting,
so that I can iterate on my prompt during a session.

Acceptance Criteria:
- [x] bolt watches .bolt/AGENT.md for changes using fs.watch
- [x] On file change, system prompt is reassembled (load + skills + tools)
- [x] New prompt is used for the next API call
- [x] A progress event notifies the user that the prompt has been reloaded
- [x] Hot-reload is enabled by default in TTY mode
- [x] --no-watch-prompt CLI flag disables hot-reload
- [x] agentPrompt.watchForChanges config key disables hot-reload
- [x] BOLT_AGENT_WATCH_CHANGES env var overrides the config key
- [x] File watcher is cleaned up on shutdown
- [x] Unit tests cover: file change triggers reload, watcher cleanup,
      disabled via flag, disabled via config, disabled via env var
```

**S11-1d: Sub-agent system prompt rule inheritance**

```
As a developer,
I want sub-agents to inherit safety and communication rules from the parent,
so that delegated work follows the same constraints without leaking task context.

Acceptance Criteria:
- [ ] Sub-agent system prompt includes inherited sections from parent's assembled prompt:
      ## Safety Rules, ## Communication Style, ## Operating Modes
- [ ] Sections are extracted by parsing section headers (## Safety Rules, etc.)
- [ ] Missing sections are silently skipped
- [ ] Inherited rules are prepended to the sub-agent's own system prompt
- [ ] Works for both subagent_run (free-form delegation) and skill_run (skill-specific prompts)
- [ ] Unit tests cover: all three sections inherited, partial inheritance (some missing),
      no sections found (sub-agent prompt unchanged)
```

**S11-2: End-to-end CLI session test**

```
As a developer,
I want an end-to-end test that runs a full agent session via CliChannel,
so that integration across all components is verified.

Acceptance Criteria:
- [ ] E2E test sends a multi-step task prompt via CliChannel
- [ ] Agent calls multiple tools, manages a todo list, and returns a final answer
- [ ] Test mocks only the Anthropic API and filesystem — all other components run real code
- [ ] Test completes deterministically with no real network calls
```

**S11-3: State recovery from corrupt files**

```
As a developer,
I want bolt to recover gracefully from corrupt state files,
so that a crash mid-write does not permanently break a user's installation.

Acceptance Criteria:
- [ ] Corrupt .bolt/tasks.json or projects/<id>/tasks.json: moved to .bolt/corrupted/<timestamp>-tasks.json, fresh state used for that scope
- [ ] Corrupt .bolt/sessions/YYYY-MM-DD.jsonl: partial entries at end of file are truncated; valid entries before the corruption are loaded normally
- [ ] Corrupt .bolt/memory/<id>.json entries: moved to .bolt/corrupted/ and skipped with a warning; rest of memory loads normally
- [ ] Corrupt .bolt/config.json: exits with a descriptive error (not a silent default)
- [ ] All recovery paths are unit tested with injected corrupt fixtures
```

**S11-4: Embedding memory search backend (optional)**

```
As a power user,
I want to switch memory search to an embedding-based backend,
so that semantically similar past context is retrieved even without exact keyword matches.

Acceptance Criteria:
- [ ] Setting memory.searchBackend = "embedding" in config activates the embedding backend
- [ ] Embedding calls use the configured model and count against the token budget
- [ ] Falls back to keyword search if embedding call fails
- [ ] Backend is interchangeable with no changes to memory_search tool interface
```

**S11-5: README and getting-started documentation**

```
As a new user,
I want clear setup instructions in the README,
so that I can get bolt running in under 5 minutes.

Acceptance Criteria:
- [x] README covers: prerequisites, install, auth setup, first run
- [ ] Includes example of running a skill from the CLI
- [ ] Includes example of using WebChannel from a phone
- [ ] Includes example of connecting bolt to ComfyUI servers
- [x] Links to docs/ for deeper reference
```

---

## Sprint 12 — Enhanced File Tools

**Goal:** The agent can efficiently search file contents, insert text at specific lines, discover files by pattern, and edit files with better error feedback. These tools close the gap between bolt's file capabilities and Claude Code best practices.

### Stories

**S12-1: file_search tool**

```
As an agent,
I want to search file contents by pattern and receive structured matches,
so that I can find relevant code without reading entire files into context.

Acceptance Criteria:
- [x] file_search({ pattern, regex?, path?, include?, caseSensitive?, maxResults? })
      returns { matches: [{ file, line, content }], totalCount }
- [x] pattern defaults to regex mode; regex: false treats it as a literal string
- [x] path scopes the search to a specific file or directory (default: cwd)
- [x] include applies a glob filter (e.g. "*.ts") to limit which files are scanned
- [x] Results are sorted by file path then line number, truncated to maxResults (default: 50)
- [x] totalCount reflects the full match count even when results are truncated
- [x] Matching line content is truncated to 500 chars per match
- [x] All paths are confined to the workspace root
- [x] No matches found returns empty results (not an error)
- [x] file_search is registered as a built-in tool
- [x] Unit tests use in-memory filesystem mock; cover: regex match, literal match,
      glob filter, case sensitivity, maxResults truncation, scoped path, empty results
- [x] Design documented in docs/design/tools-system.md
```

**S12-2: glob tool**

```
As an agent,
I want to find files by name pattern,
so that I can discover files without reading their content.

Acceptance Criteria:
- [x] glob({ pattern, path? }) returns { paths: string[] }
- [x] pattern supports standard glob syntax: "**/*.ts", "src/**/*.test.ts", etc.
- [x] path scopes the search root (default: cwd)
- [x] Results are workspace-relative paths, sorted by modification time
- [x] All results are confined to the workspace root
- [x] No matches found returns empty array (not an error)
- [x] glob is registered as a built-in tool
- [x] Unit tests use in-memory filesystem mock; cover: recursive glob,
      extension filter, scoped path, empty results
```

**S12-3: file_insert tool**

```
As an agent,
I want to insert content at a specific line number in a file,
so that I can add imports, functions, or config blocks without matching existing text.

Acceptance Criteria:
- [x] file_insert({ path, content, line? }) returns { path }
- [x] line is 1-indexed; line: 1 inserts at the top of the file
- [x] line: 0 or omitted appends after the last line
- [x] line beyond EOF length is treated as append
- [x] File is created if it does not exist (same behavior as file_write)
- [x] Parent directories are created automatically (same as file_write)
- [x] All paths are confined to the workspace root
- [x] file_insert is registered as a built-in tool
- [x] Unit tests use in-memory filesystem mock; cover: insert at top,
      insert in middle, append, beyond EOF, new file creation
```

**S12-4: file_edit improvements — replaceAll and contextual errors**

```
As an agent,
I want file_edit to replace all occurrences and give helpful feedback when a match fails,
so that I can make bulk changes and self-correct failed edits without wasting turns.

Acceptance Criteria:
- [x] file_edit gains an optional replaceAll parameter (default: false)
- [x] When replaceAll is true, all occurrences of oldString are replaced
- [x] Output gains a replacements field: number of replacements performed
- [x] When oldString is not found, a ToolError is returned (not changed: false)
      with a message that includes:
      - The 3 closest matching substrings found in the file (by similarity)
      - Surrounding context (±2 lines) for each close match
      - This helps the LLM self-correct its search string on the next attempt
- [x] Backward compatibility: existing callers without replaceAll get first-occurrence behavior
- [x] Unit tests cover: replaceAll with multiple matches, replaceAll with no matches,
      contextual error message format, single replacement (existing behavior)
```

**S12-5: file_read improvements — offset and limit**

```
As an agent,
I want to read a large file in chunks,
so that I can work with files that exceed the 20,000 character limit.

Acceptance Criteria:
- [x] file_read gains optional offset (character offset, default: 0) and limit (max chars, default: 20,000)
- [x] Output gains totalSize field: full file length in characters
- [x] When content is truncated, totalSize > content.length so the agent knows more is available
- [x] Agent can read subsequent chunks by calling file_read with offset = previous offset + limit
- [x] Backward compatibility: callers without offset/limit get existing behavior
- [x] Unit tests cover: full file read, chunked read with offset/limit,
      offset beyond EOF returns empty content, totalSize accuracy
```

---

## Sprint 13 — Video Pipeline Refactor + Subagent Visibility

**Goal:** Fix the fundamental architectural mismatch in the video production pipeline — `produce-video` ran as an isolated subagent but required `user_review` interaction, which subagents cannot perform. Replace it with a `plan-video-production` planning skill and move all interactive execution to the main agent. Also surface subagent activity to the user via progress events.

### Stories

**S13-1: `plan-video-production` skill (replaces produce-video orchestrator)**

```
As a blogger,
I want bolt to set up a video production project and task plan before asking me anything,
so that I can review and approve the full plan before any content is generated.

Acceptance Criteria:
- [x] plan-video-production.skill.md created in resources/skills/ with:
      - input schema: { topic, title?, targetPlatform?, audioFile?, projectId? }
      - output schema: { projectId, manifestPath, planSummary, tasks[] }
      - allowedTools: content_project_create, content_project_read, task_create, task_list,
        file_read, file_write
      - NO user_review, NO skill_run, NO comfyui_*, NO video_* tools in allowedTools
- [x] Skill creates the content project via content_project_create
- [x] Skill creates the full task DAG (analyzeTrends → generateScript → generateImagePrompts
      → generateImages → generateVideoPrompts → generateVideos → mergeClips
      → addAudio (if audioFile) → addSubtitles (if needed))
      with dependsOn and requiresApproval: true on every task
- [x] Skill builds a planSummary string listing each step with its approval gate description
- [x] Skill returns { projectId, manifestPath, planSummary, tasks }
- [x] When projectId is provided: reads project.json, calls task_list, returns existing
      projectId + manifestPath + planSummary (for resumption context) without recreating
- [x] produce-video.skill.md removed from src/skills/
- [x] docs/design/skills-system.md updated: plan-video-production in Built-in Skills table
- [x] docs/design/content-generation.md updated: two-phase orchestration model documented
- [x] Unit tests verify skill metadata, task DAG shape, planSummary content, and resume behavior
```

**S13-2: Video pipeline execution in AGENT.md**

```
As a blogger,
I want bolt to guide me through each video production step with a clear review at every stage,
so that I can approve or adjust before anything expensive runs.

Acceptance Criteria:
- [x] resources/AGENT.md updated with explicit Video Execution Protocol:
      - Phase 1: call plan-video-production, present planSummary via user_review
      - Phase 2: execute each task in the DAG as the main agent (not inside a skill)
      - Exact skill/tool to call for each of the 9 task types
      - Correct input parameter names for each generation skill:
          generate-image-prompt expects { sceneDescription }
          generate-video-prompt expects { sceneDescription }
      - user_review call after each generation step with appropriate contentType
      - Revision loop: reject → revise → re-present → approve before moving on
      - Critical gate rules: never start images before prompts approved, etc.
- [x] Skill routing rule for video updated: "run plan-video-production, then execute yourself"
- [x] Content Generation Workflow section updated to show two-phase model
- [x] No change to generation skills (analyze-trends, generate-video-script, etc.)
- [x] Integration test: mock plan-video-production output → main agent executes steps,
      calls user_review between each, updates task status correctly
```

**S13-3: Subagent progress visibility**

```
As a user,
I want to see when bolt spawns a subagent and what it is doing,
so that I know work is happening and can understand the workflow.

Acceptance Criteria:
- [x] skill_run tool emits a progress event immediately before spawning:
      "[subagent] Starting: <skill-name> — <skill.description>"
- [x] skill_run tool emits a progress event on completion:
      "[subagent] Done: <skill-name> (<durationMs>ms)"
- [x] CliChannel renders these as a distinct progress line (e.g. "⟳ Subagent: ...")
- [x] WebChannel broadcasts these as { type: "subagent_status", skill, subagentStatus, durationMs? }
      events to all connected clients
- [ ] Frontend displays subagent status with a distinct visual style (muted, indented)
- [x] On subagent failure, emits "[subagent] Failed: <skill-name> — <error message>"
- [x] Progress events are emitted even when skill result is an error
- [x] Unit tests: skill_run emits correct events on start, success, and failure
- [x] docs/design/skills-system.md Subagent Progress Visibility section verified/updated
```

---

## Dependency Graph

```
Sprint 0 (Foundation)
│
├─► S1 (Auth + Channel + CLI)
│         │
│         └─► S3 (Agent Core) ◄─── S2 (Tool Bus + Tools)
│                   │
│         ┌─────────┼──────────┐
│         ▼         ▼          ▼
│        S4        S5         S6
│      (Tasks)  (Memory)   (Sub-agent
│         │        │         + Skills)
│         └────────┴─────┐    │
│                        ▼    ▼
│                S7 (Web Search + User Review)
│                        │
│                ┌───────┼────────┐
│                ▼                ▼
│         S8 (WebChannel)   S9 (Content + Trends)
│                │                │
│                └───────┬────────┘
│                        ▼
│          S10 (ComfyUI Client + Video Production + Post-Production)
│              S10-1..3: ComfyUI Pool + tools + production workflow
│              S10-4: channel task completion notification
│              S10-5: content project tools + comfyUI workspace fix
│              S10-6..8: FFmpeg Runner + video editing tools
│              S10-9: produce-video orchestrator skill [superseded by S13]
│                        │
└───────────────────────►S11 (Simplified AGENT.md + Skills/Tools Injection)
                           │    S11-1:  AGENT.md simplification + dynamic catalogs
                           │    S11-1b: Token size tracking
                           │    S11-1c: Hot-reload for AGENT.md
                           │    S11-1d: Sub-agent rule inheritance
                           │    S11-2:  E2E CLI session test
                           │    S11-3:  State recovery
                           │    S11-4:  Embedding memory (optional)
                           │    S11-5:  README docs
                           │
                           ├──► S12 (Enhanced File Tools)
                           │          S12-1: file_search
                           │          S12-2: glob
                           │          S12-3: file_insert
                           │          S12-4: file_edit improvements
                           │          S12-5: file_read improvements
                           │
                           └──► S13 (Video Pipeline Refactor + Subagent Visibility)
                           │          S13-1: plan-video-production skill
                           │          S13-2: Video execution protocol in AGENT.md
                           │          S13-3: Subagent progress events
                           │
                           └──► S14 (Sub-agent Internal Progress Streaming)
                                       S14-1: StderrProgressReporter + protocol extension
                                       S14-2: runSubagent stderr forwarding
                                       S14-3: ProgressReporter onSubagent* forwarded methods
```

Sprint 12 depends on S2 (Tool Bus + Core Tools) since it extends the existing file tools.
Sprint 13 depends on S10 (video tools must exist) and S11 (dynamic skills injection).
Sprint 14 depends on S6 (sub-agent runner) and S13-3 (outer subagent progress events).
All are placed after S11 so they do not block the v1 release.

---

## Sprint 14 — Sub-agent Internal Progress Streaming

**Goal:** Surface the tool calls and LLM interactions happening *inside* a sub-agent to the parent's CLI and WebChannel. Currently, users see only a start/end bracket around a silent black box. This sprint streams sub-agent internal progress back to the parent via stderr so every tool call is visible in real time.

### Stories

**S14-1: StderrProgressReporter and protocol extension**

```
As a user,
I want to see the tool calls and thinking steps happening inside a sub-agent,
so that I know what bolt is doing during long sub-agent runs.

Acceptance Criteria:
- [ ] StderrProgressReporter implemented in src/progress/stderr-progress.ts:
      - Implements ProgressReporter
      - onThinking, onToolCall, onToolResult, onRetry write JSON to stderr:
            PROGRESS:{"event":"onThinking"}
            PROGRESS:{"event":"onToolCall","name":"...","input":...}
            PROGRESS:{"event":"onToolResult","name":"...","success":...,"summary":"..."}
            PROGRESS:{"event":"onRetry","attempt":...,"maxAttempts":...,"reason":"..."}
      - All other methods (onSessionStart, onLlmCall, onLlmResponse, onTaskStatusChange,
        onContextInjection, onMemoryCompaction, onSubagent*) are no-ops
- [ ] src/cli/subagent.ts replaces NoopProgressReporter with StderrProgressReporter
- [ ] Unit tests for StderrProgressReporter verify each forwarded event's JSON format
      and that suppressed events write nothing to stderr
```

**S14-2: runSubagent stderr forwarding**

```
As a developer,
I want runSubagent to parse PROGRESS: lines from child stderr in real time
and re-emit them on the parent's ProgressReporter,
so that forwarded events reach the CLI and WebChannel without buffering.

Acceptance Criteria:
- [ ] runSubagent signature gains optional parameters: progress?: ProgressReporter, skillName?: string
- [ ] SubagentRunner type updated to include progress and skillName
- [ ] Child stderr is read line-by-line in real time (readline on the child.stderr stream)
- [ ] Lines starting with "PROGRESS:" are parsed and dispatched:
        onThinking    → ctx.progress.onSubagentThinking(skillName)
        onToolCall    → ctx.progress.onSubagentToolCall(skillName, name, input)
        onToolResult  → ctx.progress.onSubagentToolResult(skillName, name, success, summary)
        onRetry       → ctx.progress.onSubagentRetry(skillName, attempt, maxAttempts, reason)
- [ ] Malformed PROGRESS: lines (invalid JSON) are logged as warnings and skipped
- [ ] Non-PROGRESS: lines continue to go to logger.debug as before
- [ ] On non-zero exit, full (non-PROGRESS) stderr is still captured for the error message
- [ ] skill_run passes ctx.progress and skill.name to runSubagent
- [ ] Unit tests mock child process stderr to verify forwarding, malformed-line handling,
      and that non-zero exit still works correctly
```

**S14-3: ProgressReporter interface — onSubagent* forwarded methods**

```
As a developer,
I want the ProgressReporter interface to expose the four forwarded sub-agent events,
so that CLI and WebChannel implementations can render them distinctly.

Acceptance Criteria:
- [ ] ProgressReporter interface in src/progress/progress.ts gains four methods:
        onSubagentThinking(skill: string): void
        onSubagentToolCall(skill: string, name: string, input: unknown): void
        onSubagentToolResult(skill: string, name: string, success: boolean, summary: string): void
        onSubagentRetry(skill: string, attempt: number, maxAttempts: number, reason: string): void
- [ ] NoopProgressReporter implements all four as no-ops
- [ ] CliProgressReporter renders forwarded events with two-space indent:
        onSubagentThinking  → "  ⟳ Thinking…"
        onSubagentToolCall  → "  ⚙  <name>\n     <summarised input>"
        onSubagentToolResult → "     ✓ <summary>" or "     ✗ <summary>"
        onSubagentRetry     → "  ⚠  retrying (attempt/max): reason"
- [ ] WebChannelProgressReporter broadcasts forwarded events as:
        { type: "subagent_progress", event: "thinking"|"tool_call"|"tool_result"|"retry",
          skill: string, ...event fields }
- [ ] All existing ProgressReporter implementors (NoopProgressReporter,
      CliProgressReporter, WebChannelProgressReporter) compile without errors
- [ ] Unit tests for CliProgressReporter cover all four forwarded event rendering cases
- [ ] Unit tests for WebChannelProgressReporter verify subagent_progress message shape
- [ ] docs/design/cli-progress.md verified as matching implementation
```

---

## Release Criteria (v1)

All of the following must be true before tagging v1:

- [ ] All Sprint 0–14 stories are complete and meet their acceptance criteria
- [ ] CI pipeline is green on `main`
- [ ] Coverage thresholds met across all modules
- [ ] No `any` types (`tsc --noEmit` passes)
- [ ] E2E test passes (S11-1)
- [ ] State recovery paths tested (S11-2)
- [ ] README is complete (S11-4)
- [ ] WebChannel is functional and tested on mobile
- [ ] At least one full video production pipeline tested end-to-end (with mocked ComfyUIPool)
- [ ] Post-production pipeline tested end-to-end: merge + audio + subtitles (with mocked FfmpegRunner)
- [ ] file_search is the most-called tool in E2E tests (validates utility)
- [ ] file_edit contextual error messages help the LLM self-correct in ≥ 80% of failed edit attempts (measured in E2E)
- [x] Video pipeline refactored: plan-video-production skill + main-agent execution (S13-1, S13-2)
- [x] All 9 video review gates confirmed reachable by the user in E2E test (S13-2)
- [x] Subagent progress events visible in CLI and WebChannel (S13-3)
- [ ] Sub-agent internal progress (tool calls, thinking) visible in CLI and WebChannel (S14)
