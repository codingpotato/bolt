# Project Plan

## Overview

11 sprints, each with a shippable increment. Every sprint follows the TDD cycle and agile process defined in `docs/workflow/`. Dependencies flow strictly — later sprints build on earlier ones.

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
Sprint 10 — MCP Client + Video Production
Sprint 11 — Polish + Integration
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
I want tasks to be serialized to .bolt/tasks.json after every mutation,
so that in-progress work survives process restarts.

Acceptance Criteria:
- [x] Task interface matches docs/design/task-system.md
- [x] task_create({ title, description }) returns { id }; writes to .bolt/tasks.json immediately
- [x] task_update({ id, status, result?, error? }) updates and re-serializes
- [x] task_list() returns all tasks with current status
- [x] On startup, existing .bolt/tasks.json is loaded and tasks resume from last status
- [x] Corrupt .bolt/tasks.json is moved to .bolt/corrupted/ and a fresh state is used
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

**S5-1: Agent prompt system (AGENT.md)**
```
As a user,
I want to define bolt's identity, rules, and domain knowledge in a Markdown file,
so that I can tailor bolt's behaviour for my project without modifying code.

Acceptance Criteria:
- [x] AgentCore loads ~/.bolt/AGENT.md (user-level) and .bolt/AGENT.md (project-level) at startup
- [x] If both exist, user-level content is prepended and project-level content is appended
- [x] If neither exists, a built-in default system prompt is used
- [x] The assembled prompt is used as the system field in every Anthropic API call for the session
- [x] The prompt is never modified mid-session
- [x] Missing files are not an error — they are silently skipped
- [x] agentPrompt.projectFile and agentPrompt.userFile config keys override the default paths
- [x] Unit tests cover: no files (default), user-level only, project-level only, both files
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

**S5-3: Session Store (L2) — per-turn persistence**
```
As a developer,
I want every turn written to disk immediately,
so that no conversation history is lost on crash or clean exit.

Acceptance Criteria:
- [x] A sessionId (UUID v4) is generated at process startup and passed through AgentCore
- [x] --session <id> CLI flag resumes an existing session (loads prior sessionId)
- [x] SessionEntry interface matches docs/design/memory-system.md (sessionId, seq, ts, taskId?, date, role, content)
- [x] Memory Manager appends a SessionEntry to .bolt/sessions/<session-id>.jsonl on every:
      user turn, assistant response, tool call, and tool result
- [x] Write happens before the next LLM call — a crash mid-turn loses at most one in-flight entry
- [x] Task model gains a sessionIds: string[] field; the current sessionId is appended when a task transitions to in_progress
- [x] Corrupt session files are skipped with a warning during session resume
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

**S5-9: agent_suggest tool and suggestions CLI**
```
As an agent,
I want to propose improvements to my own rules without being able to apply them directly,
so that bolt can improve over time while humans stay in control of its core behaviour.

Acceptance Criteria:
- [x] agent_suggest({ target: 'AGENT.md', scope: 'project'|'user', content, reason }) writes a Suggestion to .bolt/suggestions/<id>.json
- [x] Suggestion schema matches docs/design/agent-prompt.md (id, createdAt, sessionId, taskId?, target, scope, content, reason, status)
- [x] agent_suggest is registered as a built-in tool; it is NOT in the default sub-agent or skill allowlist
- [x] Returns { suggestionId, path }
- [x] bolt suggestions CLI command lists all pending suggestions with id, createdAt, scope, and first line of reason
- [x] bolt suggestions show <id> prints the full content and reason
- [x] bolt suggestions apply <id> appends content to the target AGENT.md (creates the file if absent); sets status to 'applied'
- [x] bolt suggestions reject <id> sets status to 'rejected'
- [x] Applied/rejected suggestions are retained in .bolt/suggestions/ for audit purposes
- [x] Unit tests cover: suggest writes file, apply creates AGENT.md, apply appends to existing AGENT.md, reject updates status
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
I want bolt to discover and load .skill.md files from .bolt/skills/ and ~/.bolt/skills/,
so that users can add custom skills without modifying core code.

Acceptance Criteria:
- [x] .bolt/skills/ is searched first (higher priority than ~/.bolt/skills/)
- [x] Name collision: .bolt/skills/ wins over ~/.bolt/skills/
- [x] Skill frontmatter (name, description, inputSchema, outputSchema, allowedTools?) is parsed
- [x] Body of the .skill.md file becomes the system prompt
- [x] Invalid frontmatter emits a warning and skips the skill
- [x] /skills slash command displays all discovered skills
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
- [ ] Note: analyze-trends skill is NOT included here — it depends on web_search (S7-2) and is implemented in S9-1
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
- [ ] SearchProvider interface: search(query, options) → SearchResult[]
- [ ] SearXNGProvider implements the interface; calls local SearXNG JSON API
- [ ] BraveProvider implements the interface; calls Brave Search API with BOLT_SEARCH_API_KEY
- [ ] SerperProvider implements the interface; calls Serper API with BOLT_SEARCH_API_KEY
- [ ] Provider is selected by config.search.provider (default: "searxng")
- [ ] Provider connection is validated at startup; warning logged if unreachable
- [ ] Unit tests mock HTTP calls for all three providers
```

**S7-2: web_search tool**
```
As an agent,
I want to search the web by keyword and receive structured results,
so that I can research trending topics and gather information.

Acceptance Criteria:
- [ ] web_search({ query, maxResults?, timeRange?, category? }) returns { results[] }
- [ ] Each result has title, url, snippet, and optional date and source fields
- [ ] maxResults defaults to config.search.maxResults (10)
- [ ] timeRange filters results by recency (day, week, month, year)
- [ ] category supports general, news, images, videos
- [ ] Network/API errors return a retryable ToolError
- [ ] web_search is registered as a built-in tool
- [ ] Unit tests mock the search provider
```

**S7-3: user_review tool**
```
As an agent,
I want to present content for user review and collect approval or feedback,
so that the user can guide creative decisions before expensive operations.

Acceptance Criteria:
- [ ] user_review({ content, contentType, question, mediaFiles? }) returns { approved, feedback? }
- [ ] contentType supports: script, storyboard, image_prompt, video_prompt, image, video, text
- [ ] CliChannel renders content as formatted text; prompts [approve/reject/feedback]:
- [ ] When channel.requestReview is available, delegates to it (enables rich WebChannel UI later)
- [ ] When channel has no requestReview, falls back to ctx.confirm + text display
- [ ] mediaFiles paths are validated to exist before presenting
- [ ] user_review is registered as a built-in tool
- [ ] Unit tests mock the channel interaction
```

---

## Sprint 8 — WebChannel

**Goal:** bolt serves a web chat interface over HTTP/WebSocket, accessible from phone or desktop browser.

### Stories

**S8-1: WebChannel HTTP + WebSocket server**
```
As a blogger,
I want to access bolt via a web browser on my phone,
so that I can control content generation without a terminal.

Acceptance Criteria:
- [ ] WebChannel implements the Channel interface
- [ ] Starts an HTTP server on config.channels.web.port (default 3000)
- [ ] WebSocket mode: persistent connection for bidirectional messaging
- [ ] HTTP mode: POST /chat for user turns, SSE for streaming responses
- [ ] Simple token authentication via BOLT_WEB_TOKEN or config.channels.web.token
- [ ] Server only starts when config.channels.web.enabled is true
- [ ] Only one active (read-write) WebSocket connection is allowed at a time; a second connection is accepted but immediately put into read-only mode — it receives all agent messages and progress events but its send attempts are rejected with a "read-only" error
- [ ] When the active connection closes, the oldest read-only connection is promoted to active
- [ ] Unit tests mock the HTTP server
```

**S8-2: Web chat frontend**
```
As a blogger,
I want a responsive chat UI in my browser,
so that I can interact with bolt from my phone or desktop.

Acceptance Criteria:
- [ ] Single-file HTML (public/index.html) with vanilla JS and responsive CSS
- [ ] Mobile-first design; usable on phones and desktops
- [ ] Message list with user/agent bubbles, auto-scroll
- [ ] Text input with send button
- [ ] WebSocket connection with auto-reconnect
- [ ] Progress indicators for agent thinking and tool execution
- [ ] No build tools required — served directly by the HTTP server
- [ ] Read-only mode: when the connection is not the active one, the input is disabled and a banner reads "Observing — another session is active"
- [ ] When the client is promoted from read-only to active, the banner is removed and input is enabled automatically
```

**S8-3: Rich review UI in WebChannel**
```
As a blogger,
I want to review content with approve/reject buttons and see image/video previews,
so that I can make creative decisions from my phone.

Acceptance Criteria:
- [ ] WebChannel.requestReview() sends a rich message with content, media previews, and action buttons
- [ ] Approve button sends { approved: true } back to the agent
- [ ] Reject button shows a text input for feedback, then sends { approved: false, feedback }
- [ ] Image files are served via static file endpoint and displayed inline
- [ ] Video files are served via static file endpoint and playable inline
- [ ] Markdown content is rendered as formatted HTML
- [ ] WebChannel.sendMedia() sends image/video with optional caption
```

**S8-4: WebChannel daemon mode**
```
As a blogger,
I want bolt to stay running as a background service,
so that I can connect to it from my phone at any time.

Acceptance Criteria:
- [ ] bolt serve CLI command starts bolt in daemon mode with WebChannel
- [ ] Agent stays alive between conversations, listening for new WebSocket connections
- [ ] Only one connection may send commands at a time; additional connections are read-only observers (see S8-1)
- [ ] Graceful shutdown on SIGTERM/SIGINT
- [ ] Session state is preserved between conversations
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
- [ ] analyze-trends skill accepts { topic?, platforms?, timeRange? } input
- [ ] Uses web_search to find trending content across platforms
- [ ] Uses web_fetch to deep-read top results for details
- [ ] Returns structured report: { trends[], recommendedAngles[], topPosts[] }
- [ ] Each trend has title, platform, engagement metrics (if available), and content angle
- [ ] Skill has unit tests with mocked web_search and web_fetch
```

**S9-2: Content generation skills**
```
As a blogger,
I want bolt to generate blog posts, social posts, and video scripts,
so that I can produce content at scale.

Acceptance Criteria:
- [ ] write-blog-post produces well-structured Markdown given topic + tone
- [ ] draft-social-post produces platform-appropriate copy (Twitter, LinkedIn, Xiaohongshu, etc.)
- [ ] generate-video-script produces a structured Storyboard (title, summary, scenes[])
- [ ] Each scene includes: description, dialogue, camera, duration, imagePromptHint, transitionTo
- [ ] generate-image-prompt creates prompts optimised for target model (SDXL, Flux, etc.)
- [ ] generate-video-prompt creates motion prompts for image-to-video generation
- [ ] Skills can optionally use web_search and web_fetch to research before writing
- [ ] Skills can be chained: summarize-url output feeds into write-blog-post
```

**S9-3: Code review skill**
```
As a developer,
I want bolt to review code and return a structured report,
so that I can get automated feedback on my code.

Acceptance Criteria:
- [ ] review-code skill accepts { path?, diff? } input
- [ ] Returns CodeReviewResult: { summary, issues[], approved }
- [ ] Each issue has severity ("error"|"warning"|"suggestion"), file, line?, message
- [ ] Uses file_read to read source files if path is provided
- [ ] Skill has unit tests with mocked sub-agent execution
```

**S9-4: Automated test-and-fix workflow**
```
As an agent,
I want to run a test suite, read failures, attempt fixes, and retry,
so that I can autonomously fix broken tests.

Acceptance Criteria:
- [ ] Agent runs bash({ command: "npm test" }) and interprets output
- [ ] On test failure: reads error output, identifies failing file/assertion
- [ ] Applies a targeted fix via file_edit or file_write
- [ ] Retries the test run; max retries from codeWorkflows.testFixRetries (default 3)
- [ ] Reports final pass/fail status after exhausting retries
```

---

## Sprint 10 — MCP Client + Video Production

**Goal:** bolt can connect to external MCP servers and orchestrate the full video production pipeline.

### Stories

**S10-1: MCP Client**
```
As a developer,
I want bolt to connect to external MCP servers,
so that it can integrate with services like ComfyUI for media generation.

Acceptance Criteria:
- [ ] McpClient reads server configs from config.mcp.servers[]
- [ ] McpClient.listTools() discovers tools from all registered servers
- [ ] McpClient.call(server, tool, input) routes to the correct server
- [ ] Connection health check at startup; unreachable servers logged as warning
- [ ] Per-server timeout from config (default 300000ms for long-running operations)
- [ ] Retry with backoff on transient connection failures
- [ ] Unit tests mock the MCP protocol
```

**S10-2: mcp_call tool**
```
As an agent,
I want to call tools on external MCP servers,
so that I can generate images and videos via ComfyUI.

Acceptance Criteria:
- [ ] mcp_call({ server, tool, args }) dispatches to McpClient
- [ ] Returns { result, durationMs }
- [ ] Server not found → ToolError (non-retryable)
- [ ] Tool not found on server → ToolError (non-retryable)
- [ ] Timeout → ToolError (retryable)
- [ ] mcp_call is registered as a built-in tool
- [ ] Progress events emitted during long-running MCP calls
- [ ] Unit tests mock the MCP client
```

**S10-3: Video production workflow**
```
As a blogger,
I want bolt to orchestrate the full video production pipeline,
so that I can go from a topic to finished video clips with human-in-the-loop review.

Acceptance Criteria:
- [ ] Agent creates a content project directory projects/<project-id>/ with project.json manifest at workflow start
- [ ] project.json manifest schema matches docs/design/content-generation.md (ContentProject interface)
- [ ] Agent creates a task DAG for video production (analyze → script → image prompts → images → video prompts → videos)
- [ ] Each task has dependsOn linking to previous step; each task has requiresApproval: true
- [ ] First task result stores { projectId, manifestPath } as JSON so all downstream tasks can locate the project
- [ ] Each task reads project.json via file_read to find input artifacts; writes outputs to the scene directory
- [ ] Manifest artifact status is updated to 'draft' after generation, 'approved' after user_review approval
- [ ] mcp_call(comfyui, text2img) generates images; downloaded to projects/<id>/scenes/scene-<NN>/image.png
- [ ] mcp_call(comfyui, img2video) generates video clips; downloaded to projects/<id>/scenes/scene-<NN>/clip.mp4
- [ ] User can reject and request changes at any gate; agent revises and re-presents; manifest status reflects rejections
- [ ] Integration test covers the full pipeline with mocked MCP and channel
```

**S10-4: Notification system**
```
As a blogger,
I want to be notified when long-running tasks complete,
so that I don't have to watch the screen while images/videos generate.

Acceptance Criteria:
- [ ] System notification on macOS (osascript) and Linux (notify-send) when a task completes
- [ ] Notification includes task title and status
- [ ] Provider selected by config.notifications.provider (default: "system")
- [ ] "none" provider disables notifications
- [ ] WebChannel sends real-time progress via WebSocket (no extra notification needed)
- [ ] Unit tests mock system commands
```

---

## Sprint 11 — Polish + Integration

**Goal:** Error recovery paths are hardened, end-to-end flows work, and the system is ready for v1 release.

### Stories

**S11-1: End-to-end CLI session test**
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

**S11-2: State recovery from corrupt files**
```
As a developer,
I want bolt to recover gracefully from corrupt state files,
so that a crash mid-write does not permanently break a user's installation.

Acceptance Criteria:
- [ ] Corrupt .bolt/tasks.json: moved to .bolt/corrupted/<timestamp>-tasks.json, fresh state used
- [ ] Corrupt .bolt/sessions/<id>.jsonl: partial entries at end of file are truncated; valid entries before the corruption are loaded normally
- [ ] Corrupt .bolt/memory/<id>.json entries: moved to .bolt/corrupted/ and skipped with a warning; rest of memory loads normally
- [ ] Corrupt .bolt/config.json: exits with a descriptive error (not a silent default)
- [ ] All recovery paths are unit tested with injected corrupt fixtures
```

**S11-3: Embedding memory search backend (optional)**
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

**S11-4: README and getting-started documentation**
```
As a new user,
I want clear setup instructions in the README,
so that I can get bolt running in under 5 minutes.

Acceptance Criteria:
- [x] README covers: prerequisites, install, auth setup, first run
- [ ] Includes example of running a skill from the CLI
- [ ] Includes example of using WebChannel from a phone
- [ ] Includes example of connecting to ComfyUI via MCP
- [x] Links to docs/ for deeper reference
```

---

## Dependency Graph

```
S0 (Foundation)
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
│                S10 (MCP + Video Production)
│                        │
└───────────────────────►S11 (Polish)
```

---

## Release Criteria (v1)

All of the following must be true before tagging v1:

- [ ] All Sprint 0–10 stories are complete and meet their acceptance criteria
- [ ] CI pipeline is green on `main`
- [ ] Coverage thresholds met across all modules
- [ ] No `any` types (`tsc --noEmit` passes)
- [ ] E2E test passes (S11-1)
- [ ] State recovery paths tested (S11-2)
- [ ] README is complete (S11-4)
- [ ] WebChannel is functional and tested on mobile
- [ ] At least one full video production pipeline tested end-to-end (with mocked ComfyUI)
