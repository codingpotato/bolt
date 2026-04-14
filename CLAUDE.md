# bolt

An autonomous AI agent for social media content creators, built with TypeScript and the Anthropic SDK.

## Project Overview

bolt is an AI agent designed for social media bloggers. It automates the content creation workflow: trend research, content planning, interactive review, and media generation (text-to-image and image-to-video via ComfyUI MCP). It operates via CLI and a web chat interface (WebChannel) accessible from a phone.

## Documentation Index

Read these docs before making decisions in the relevant area:

| Doc                | Path                                | When to read                                                                                            |
| ------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Requirements       | `docs/requirements/overview.md`     | Understanding what bolt must do and what is out of scope                                                |
| Architecture       | `docs/design/architecture.md`       | System structure, components, and data flow                                                             |
| Authentication     | `docs/design/authentication.md`     | API key vs subscription auth modes, startup validation                                                  |
| Tools System       | `docs/design/tools-system.md`       | Tool interface, Tool Bus, built-in tools, allowlisting, audit log                                       |
| Workspace Safety   | `docs/design/workspace.md`          | File confinement to workspace root, dangerous bash command confirmation                                 |
| Slash Commands     | `docs/design/slash-commands.md`     | /exit, /help, /session — CLI directives intercepted before the LLM                                      |
| Agent Prompt       | `docs/design/agent-prompt.md`       | AGENT.md loading, system prompt construction, hot-reload                                                |
| CLI Progress       | `docs/design/cli-progress.md`       | ProgressReporter interface, CliProgressReporter output format, TTY guard                                |
| Memory System      | `docs/design/memory-system.md`      | How context compaction and persistent memory work                                                       |
| Task System        | `docs/design/task-system.md`        | Task model, dependencies, approval gates, todo list tools, sub-agent delegation                         |
| Skills System      | `docs/design/skills-system.md`      | Skill definition, discovery, invocation, and chaining                                                   |
| Code Workflows     | `docs/design/code-workflows.md`     | Writing code, running tests, code review                                                                |
| Content Generation | `docs/design/content-generation.md` | Trend analysis, social posts, video production pipeline, MCP integration                                |
| TTS Narration      | `docs/design/tts-narration.md`      | OmniVoice TTS, NarrationVoice interface, character speech vs narration distinction, comfyui_tts tool    |
| Video Editing      | `docs/design/video-editing.md`      | FFmpeg Runner, video_merge / video_add_audio / video_add_subtitles tools, post-production workflow      |
| ComfyUI Client     | `docs/design/comfyui-client.md`     | ComfyUIPool, server pool load balancing, workflow templates, comfyui_text2img / comfyui_img2video tools |
| Configuration      | `docs/design/configuration.md`      | All config keys, env vars, `.bolt/config.json` schema                                                   |
| Logging            | `docs/design/logging.md`            | Structured logger, log levels, `.bolt/bolt.log` format, LLM request logging                             |
| Unit Testing       | `docs/testing/unit-testing.md`      | TDD cycle, test conventions, coverage requirements                                                      |
| Dev Workflow       | `docs/workflow/development.md`      | Setup, branching, adding tools, CI pipeline                                                             |
| Agile Process      | `docs/workflow/agile.md`            | User stories, definition of done, PR checklist, sprint workflow                                         |
| Project Plan       | `docs/planning/plan.md`             | Sprint breakdown, stories, tasks, dependency graph, v1 release criteria                                 |
| Deploy: serve      | `docs/deploy/serve.md`              | Running bolt serve as a daemon, systemd/launchd, reverse proxy, token auth                              |

## Tech Stack

- **Language:** TypeScript (strict mode)
- **AI SDK:** Anthropic SDK
- **Test runner:** Vitest
- **Runtime data:** `.bolt/` directory (gitignored)

## PR and Code Review Process

- **Never commit directly to `main`** — always work on a `feat/<story-id>-<name>` or `fix/<name>` branch
- **Never push to `main`** — a hook will block it; open a PR via `gh pr create` instead
- **Before committing:** run `npm run typecheck && npm run lint && npm test`
- **Commit message format:** `<type>(<scope>): <story-id> <description>`
  - Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`
  - Example: `feat(tools): S2-4 bash tool`
- **Each story gets one branch** — branch name must include the story ID (e.g. `feat/s0-5-config-system`)
- **After merge:** mark the story complete in `docs/planning/plan.md` and delete the branch

## Key Constraints

- Sub-agents must not share state with the parent agent — enforce full context isolation
- Compact and persist messages **before** they are dropped from the context window
- All task and memory state must be serializable and survive process restarts
- No `any` types — `"strict": true` is enforced in `tsconfig.json`
- Default model: `claude-opus-4-6`
