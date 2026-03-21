# bolt

An autonomous AI CLI agent built with TypeScript and the Anthropic SDK.

## Project Overview

bolt is a self-directed AI agent operated from the command line. It can connect to Discord, execute shell commands, edit files, browse the web, manage tasks, and generate content.

## Documentation Index

Read these docs before making decisions in the relevant area:

| Doc | Path | When to read |
|-----|------|--------------|
| Requirements | `docs/requirements/overview.md` | Understanding what bolt must do and what is out of scope |
| Architecture | `docs/design/architecture.md` | System structure, components, and data flow |
| Authentication | `docs/design/authentication.md` | API key vs subscription auth modes, startup validation |
| Tools System | `docs/design/tools-system.md` | Tool interface, Tool Bus, built-in tools, allowlisting, audit log |
| Memory System | `docs/design/memory-system.md` | How context compaction and persistent memory work |
| Task System | `docs/design/task-system.md` | Task model, todo list tools, sub-agent delegation |
| Skills System | `docs/design/skills-system.md` | Skill definition, discovery, invocation, and chaining |
| Code Workflows | `docs/design/code-workflows.md` | Writing code, running tests, code review |
| Content Generation | `docs/design/content-generation.md` | Articles, image prompts, social posts, video scripts |
| Configuration | `docs/design/configuration.md` | All config keys, env vars, `.bolt/config.json` schema |
| Unit Testing | `docs/testing/unit-testing.md` | TDD cycle, test conventions, coverage requirements |
| Dev Workflow | `docs/workflow/development.md` | Setup, branching, adding tools, CI pipeline |
| Agile Process | `docs/workflow/agile.md` | User stories, definition of done, PR checklist, sprint workflow |
| Project Plan | `docs/planning/plan.md` | Sprint breakdown, stories, tasks, dependency graph, v1 release criteria |

## Core Capabilities

- **Tools execution** — model drives tool calls via the Anthropic tool-use API; Tool Bus dispatches and returns results
- **CLI interface** — all interaction happens via the command line
- **Discord integration** — connects to and operates within Discord channels
- **Bash execution** — runs shell commands on the host system
- **File editing** — reads and modifies files on disk
- **Web fetching** — retrieves content from URLs
- **Todo / task management** — creates and updates todo lists, executes them step by step
- **Multi-level memory** — compacts context on overflow, persists history for future retrieval
- **Task serialization** — creates, serializes, and executes tasks; supports pause/resume
- **Sub-agent delegation** — spawns child agents for subtasks; contexts are fully isolated
- **Skills** — loadable, composable capability modules invokable by name from CLI or by the agent
- **Code workflows** — writes code, writes tests, runs tests, performs code review
- **Content generation** — produces social media content: articles, images, short videos

## Tech Stack

- **Language:** TypeScript (strict mode)
- **AI SDK:** Anthropic SDK
- **Test runner:** Vitest
- **Runtime data:** `.bolt/` directory (gitignored)

## Key Constraints

- Sub-agents must not share state with the parent agent — enforce full context isolation
- Compact and persist messages **before** they are dropped from the context window
- All task and memory state must be serializable and survive process restarts
- No `any` types — `"strict": true` is enforced in `tsconfig.json`
- Default model: `claude-opus-4-6`
