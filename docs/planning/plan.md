# Project Plan

## Overview

9 sprints, each with a shippable increment. Every sprint follows the TDD cycle and agile process defined in `docs/workflow/`. Dependencies flow strictly — later sprints build on earlier ones.

```
Sprint 0 — Foundation
Sprint 1 — Auth + Channel + CLI
Sprint 2 — Tool Bus + Core Tools
Sprint 3 — Agent Core Loop
Sprint 4 — Todo & Task System
Sprint 5 — Memory System (L2 + L3 + Context Assembly)
Sprint 6 — Sub-agent + Skills
Sprint 7 — Discord Channel
Sprint 8 — Code Workflows + Content Generation
Sprint 9 — Polish + Integration
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

**Goal:** The agent can manage a todo list and structured tasks, with full serialization.

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
- [x] NoopProgressReporter implements all methods as no-ops; used by sub-agents, Discord, and tests
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
- [ ] Memory Manager tracks L1 token count from each API response (excluding injected history)
- [ ] When L1 count exceeds memory.compactThreshold × context_window, compaction is triggered
- [ ] The memory.keepRecentMessages most recent messages are always retained in L1
- [ ] Evicted messages are summarised by calling the model
- [ ] A CompactEntry (type: 'compaction') is written to .bolt/memory/ before eviction; entry includes sessionId, taskId, summary, raw messages, tags, date
- [ ] Active context (L1) is replaced with a single summary stub message
- [ ] Unit tests mock the Anthropic API summary call
```

**S5-7: memory_search tool — keyword backend**
```
As an agent,
I want to search my long-term memory by keyword,
so that I can recall relevant facts and summaries from past sessions.

Acceptance Criteria:
- [ ] memory_search({ query, limit?, taskId?, dateFrom?, dateTo? }) returns matching L3 entries
- [ ] Default limit is 5; results are ranked by relevance (BM25-style over summary and tags)
- [ ] taskId filter restricts results to entries from a specific task
- [ ] dateFrom / dateTo filters restrict results by the date field (YYYY-MM-DD)
- [ ] memory_search is registered as a built-in tool
- [ ] Returns empty results (not an error) when no matches found
- [ ] Unit tests cover: keyword match, taskId filter, date filter, empty results
```

**S5-8: memory_write tool**
```
As an agent,
I want to explicitly write facts and notes to long-term memory,
so that I can persist cross-task knowledge that would not otherwise be compacted.

Acceptance Criteria:
- [ ] memory_write({ content, tags? }) creates a CompactEntry with type: 'agent_note' in .bolt/memory/
- [ ] Entry carries the current sessionId and taskId (if active)
- [ ] Returns { id } of the created entry
- [ ] memory_write is registered as a built-in tool
- [ ] Unit tests verify entry is written with correct fields
```

**S5-9: agent_suggest tool and suggestions CLI**
```
As an agent,
I want to propose improvements to my own rules without being able to apply them directly,
so that bolt can improve over time while humans stay in control of its core behaviour.

Acceptance Criteria:
- [ ] agent_suggest({ target: 'AGENT.md', scope: 'project'|'user', content, reason }) writes a Suggestion to .bolt/suggestions/<id>.json
- [ ] Suggestion schema matches docs/design/agent-prompt.md (id, createdAt, sessionId, taskId?, target, scope, content, reason, status)
- [ ] agent_suggest is registered as a built-in tool; it is NOT in the default sub-agent or skill allowlist
- [ ] Returns { suggestionId, path }
- [ ] bolt suggestions CLI command lists all pending suggestions with id, createdAt, scope, and first line of reason
- [ ] bolt suggestions show <id> prints the full content and reason
- [ ] bolt suggestions apply <id> appends content to the target AGENT.md (creates the file if absent); sets status to 'applied'
- [ ] bolt suggestions reject <id> sets status to 'rejected'
- [ ] Applied/rejected suggestions are retained in .bolt/suggestions/ for audit purposes
- [ ] Unit tests cover: suggest writes file, apply creates AGENT.md, apply appends to existing AGENT.md, reject updates status
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
- [ ] subagent_run({ prompt, allowedTools? }) spawns a child process
- [ ] Child has no access to parent message history, memory, or tasks
- [ ] Auth config is passed by value at spawn time (not from child process.env)
- [ ] Child result is returned as a structured response to the parent
- [ ] Non-zero exit code from child marks the delegated task as failed with stderr
- [ ] allowedTools in subagent_run are intersected with parent allowedTools
```

**S6-2: Skill file loader**
```
As a developer,
I want bolt to discover and load .skill.md files from .bolt/skills/ and ~/.bolt/skills/,
so that users can add custom skills without modifying core code.

Acceptance Criteria:
- [ ] .bolt/skills/ is searched first (higher priority than ~/.bolt/skills/)
- [ ] Name collision: .bolt/skills/ wins over ~/.bolt/skills/
- [ ] Skill frontmatter (name, description, inputSchema, outputSchema, allowedTools?) is parsed
- [ ] Body of the .skill.md file becomes the system prompt
- [ ] Invalid frontmatter emits a warning and skips the skill
- [ ] bolt skills list CLI command displays all discovered skills
```

**S6-3: skill_run tool and execution flow**
```
As an agent,
I want to invoke a named skill with typed arguments,
so that I can use composable capabilities during task execution.

Acceptance Criteria:
- [ ] skill_run({ name, args }) validates args against inputSchema; ToolError on invalid args
- [ ] Skill runs as an isolated sub-agent with skill.systemPrompt as system turn
- [ ] Effective tool allowlist is intersection of skill.allowedTools and agent allowedTools
- [ ] Result is validated against outputSchema; ToolError on invalid output
- [ ] skill_run can be called from CLI: bolt run-skill <name> --<arg> <value>
```

**S6-4: Built-in skills**
```
As a developer,
I want the six built-in skills shipped with bolt,
so that common capabilities are available without user configuration.

Acceptance Criteria:
- [ ] write-blog-post skill is discoverable and invokable
- [ ] review-code skill returns a CodeReviewResult (summary, issues[], approved)
- [ ] generate-image-prompt skill returns a plain text prompt
- [ ] generate-video-script skill returns a script + shot list in Markdown
- [ ] summarize-url skill fetches a URL and returns a structured summary
- [ ] draft-social-post skill returns a short-form post for a given platform
- [ ] Each skill has an input schema, output schema, and system prompt
- [ ] Each skill has unit tests that mock the sub-agent execution
```

---

## Sprint 7 — Discord Channel

**Goal:** bolt can receive messages from Discord and reply in the same channel.

### Stories

**S7-1: DiscordChannel implementation**
```
As a Discord user,
I want to send messages to bolt in a Discord channel and receive replies,
so that I can use bolt without opening a terminal.

Acceptance Criteria:
- [ ] DiscordChannel implements the Channel interface
- [ ] Connects to the configured DISCORD_CHANNEL_ID channel using DISCORD_BOT_TOKEN
- [ ] Incoming messages in the channel are yielded as UserTurns (metadata includes userId, channelId)
- [ ] channel.send() posts the agent response back to the same channel
- [ ] Unit tests mock the Discord client — no real network calls
```

**S7-2: Discord Gateway reconnection**
```
As a Discord user,
I want bolt to automatically reconnect to Discord after a disconnection,
so that temporary network issues do not require a manual restart.

Acceptance Criteria:
- [ ] Gateway disconnection triggers reconnect with exponential backoff
- [ ] Reconnect is attempted up to 5 times before giving up
- [ ] Reconnect attempts and failures are logged
- [ ] Messages received during a disconnection are not silently dropped
```

---

## Sprint 8 — Code Workflows + Content Generation

**Goal:** The agent can write code, run tests, review code, and produce content — all as skills.

### Stories

**S8-1: Code review skill**
```
As a developer,
I want bolt to review a file or diff and return a structured report,
so that I can get automated feedback on my code.

Acceptance Criteria:
- [ ] review-code skill accepts { path?, diff? } input
- [ ] Returns CodeReviewResult: { summary, issues[], approved }
- [ ] Each issue has severity ("error"|"warning"|"suggestion"), file, line?, message
- [ ] Uses file_read to read source files if path is provided
- [ ] Skill has unit tests with mocked sub-agent execution
```

**S8-2: Automated test-and-fix workflow**
```
As an agent,
I want to run a test suite, read failures, attempt fixes, and retry up to the configured limit,
so that I can autonomously fix broken tests.

Acceptance Criteria:
- [ ] Agent runs bash({ command: "npm test" }) and interprets output
- [ ] On test failure: reads error output, identifies failing file/assertion
- [ ] Applies a targeted fix via file_edit or file_write
- [ ] Retries the test run; max retries from codeWorkflows.testFixRetries (default 3)
- [ ] Reports final pass/fail status after exhausting retries
```

**S8-3: Content generation skills**
```
As a content creator,
I want bolt to generate blog posts, image prompts, video scripts, and social posts,
so that I can produce content at scale.

Acceptance Criteria:
- [ ] write-blog-post produces well-structured Markdown given topic + tone
- [ ] generate-image-prompt produces a detailed, usable image generation prompt
- [ ] generate-video-script produces a script + shot list for short-form video
- [ ] draft-social-post produces platform-appropriate copy (Twitter, LinkedIn, etc.)
- [ ] Skills can optionally use web_fetch to research the topic before writing
- [ ] Skills can be chained: summarize-url output feeds into write-blog-post
```

---

## Sprint 9 — Polish + Integration

**Goal:** Error recovery paths are hardened, end-to-end flows work, and the system is ready for v1 release.

### Stories

**S9-1: End-to-end CLI session test**
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

**S9-2: State recovery from corrupt files**
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

**S9-3: Embedding memory search backend (optional)**
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

**S9-4: README and getting-started documentation**
```
As a new user,
I want clear setup instructions in the README,
so that I can get bolt running in under 5 minutes.

Acceptance Criteria:
- [x] README covers: prerequisites, install, auth setup, first run
- [ ] Includes example of running a skill from the CLI
- [ ] Includes example of connecting to Discord
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
│                       S7   S8
│                    (Discord)(Workflows
│                             + Content)
│                         │    │
│                         └────┘
│                              │
└─────────────────────────────►S9 (Polish)
```

---

## Release Criteria (v1)

All of the following must be true before tagging v1:

- [ ] All Sprint 0–8 stories are complete and meet their acceptance criteria
- [ ] CI pipeline is green on `main`
- [ ] Coverage thresholds met across all modules
- [ ] No `any` types (`tsc --noEmit` passes)
- [ ] E2E test passes (S9-1)
- [ ] State recovery paths tested (S9-2)
- [ ] README is complete (S9-4)
- [ ] WebChannel is documented as planned but not implemented
