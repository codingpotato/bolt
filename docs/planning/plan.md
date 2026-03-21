# Project Plan

## Overview

9 sprints, each with a shippable increment. Every sprint follows the TDD cycle and agile process defined in `docs/workflow/`. Dependencies flow strictly — later sprints build on earlier ones.

```
Sprint 0 — Foundation
Sprint 1 — Auth + Channel + CLI
Sprint 2 — Tool Bus + Core Tools
Sprint 3 — Agent Core Loop
Sprint 4 — Todo & Task System
Sprint 5 — Memory System
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
- [ ] bash({ command }) returns { stdout, stderr, exitCode }
- [ ] Non-zero exit code does not throw — exitCode is returned in result
- [ ] Execution happens in the configured cwd
- [ ] Unit tests mock child_process and do not execute real shell commands
```

**S2-5: file_read, file_write, file_edit tools**
```
As an agent,
I want to read, write, and edit files on disk,
so that I can modify codebases and persist output.

Acceptance Criteria:
- [ ] file_read({ path }) returns { content } or ToolError if file not found
- [ ] file_write({ path, content }) writes/overwrites the file; returns { path }
- [ ] file_edit({ path, oldString, newString }) replaces first occurrence; returns { path, changed }
- [ ] file_edit returns changed: false (not an error) if oldString is not found
- [ ] All paths are resolved relative to ToolContext.cwd
- [ ] Unit tests use in-memory filesystem mock (no real disk I/O)
```

**S2-6: web_fetch tool**
```
As an agent,
I want to GET a URL and receive the response body,
so that I can research topics and fetch external content.

Acceptance Criteria:
- [ ] web_fetch({ url }) returns { body, statusCode, contentType }
- [ ] HTTP 4xx/5xx responses return a ToolError with the status code
- [ ] Network errors return a retryable ToolError
- [ ] Unit tests mock the HTTP client
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
- [ ] Agent Core accepts a Channel and ToolBus at construction
- [ ] On each turn: builds message array, calls Anthropic API, processes response
- [ ] Tool calls in the response are dispatched via ToolBus
- [ ] Tool results are appended to messages and the API is called again
- [ ] Loop terminates when the model returns a text response with no tool calls
- [ ] Final response is delivered via channel.send()
- [ ] Unit tests mock the Anthropic SDK — no real API calls
```

**S3-2: API error handling and retries**
```
As a developer,
I want the Agent Core to retry on transient API failures,
so that network blips do not abort long-running sessions.

Acceptance Criteria:
- [ ] 5xx and network errors are retried up to 3 times with exponential backoff
- [ ] 4xx errors (auth failure, bad request) fail immediately with a clear error
- [ ] Each retry attempt is logged at warn level
- [ ] After 3 failed retries, the error is surfaced to the user via channel.send()
```

**S3-3: Context overflow handling**
```
As an agent,
I want the agent loop to trigger compaction when the context window is nearly full,
so that long sessions do not crash with a context overflow error.

Acceptance Criteria:
- [ ] Agent Core monitors token usage in each API response
- [ ] When usage exceeds memory.compactThreshold, compaction is triggered before the next call
- [ ] After compaction, the API call is retried with the compacted context
- [ ] A context overflow that cannot be resolved by compaction fails with a clear error
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
- [ ] todo_create({ title }) returns { id }
- [ ] todo_update({ id, status?, description? }) updates the item
- [ ] todo_list() returns the current ordered list with ids, titles, and statuses
- [ ] todo_delete({ id }) removes the item; ToolError if not found
- [ ] todo_update is marked sequential: true
- [ ] All todo tools are unit tested with mocked state
```

**S4-2: Task model and serialization**
```
As an agent,
I want tasks to be serialized to .bolt/tasks.json after every mutation,
so that in-progress work survives process restarts.

Acceptance Criteria:
- [ ] Task interface matches docs/design/task-system.md
- [ ] task_create({ title, description }) returns { id }; writes to .bolt/tasks.json immediately
- [ ] task_update({ id, status, result?, error? }) updates and re-serializes
- [ ] task_list() returns all tasks with current status
- [ ] On startup, existing .bolt/tasks.json is loaded and tasks resume from last status
- [ ] Corrupt .bolt/tasks.json is moved to .bolt/corrupted/ and a fresh state is used
- [ ] task_update is marked sequential: true
```

**S4-3: Task execution loop**
```
As an agent,
I want to execute tasks from my task list step by step,
so that I can work through complex multi-step goals.

Acceptance Criteria:
- [ ] Agent can pick the next pending task and mark it in_progress
- [ ] On success, task is marked completed with a result
- [ ] On failure, task is marked failed with an error reason
- [ ] blocked status is set when a task cannot proceed until another completes
- [ ] Execution loop continues until all tasks are completed or failed
```

---

## Sprint 5 — Memory System

**Goal:** The agent can compact its context on overflow and search past sessions.

### Stories

**S5-1: Memory Manager — compaction**
```
As an agent,
I want my context to be compacted before messages are dropped,
so that I never silently lose information during long sessions.

Acceptance Criteria:
- [ ] Memory Manager tracks token count from each API response
- [ ] When count exceeds memory.compactThreshold × context_window, compaction is triggered
- [ ] The memory.keepRecentMessages most recent messages are always retained
- [ ] Evicted messages are summarized by calling the model
- [ ] Summary + raw messages are written to .bolt/memory/ before eviction
- [ ] Active context is replaced with a single summary stub message
- [ ] Unit tests mock the Anthropic API summary call
```

**S5-2: Compact Store — persistence**
```
As an agent,
I want compacted summaries persisted to disk,
so that I can retrieve past context in future sessions.

Acceptance Criteria:
- [ ] CompactEntry interface matches docs/design/memory-system.md
- [ ] Entries are written as JSON files in .bolt/memory/
- [ ] Each entry has id, createdAt, summary, messages, tags
- [ ] Corrupt entry files are skipped with a warning
```

**S5-3: memory_search tool — keyword backend**
```
As an agent,
I want to search my compact memory store by keyword,
so that I can recall relevant context from past sessions.

Acceptance Criteria:
- [ ] memory_search({ query, limit? }) returns matching CompactEntry summaries
- [ ] Default limit is 5; results are ranked by relevance
- [ ] Keyword backend searches summary and tags fields
- [ ] memory_search is registered as a built-in tool
- [ ] Returns empty results (not an error) when no matches found
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
- [ ] Corrupt memory entry files: skipped with a warning, rest of memory loads normally
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
