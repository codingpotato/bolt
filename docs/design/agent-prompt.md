# Agent Prompt System Design

## Goals

- Give users a single, human-readable, versionable file to customize bolt's identity, rules, and domain knowledge
- Dynamically inject the skills catalog so the agent always knows available capabilities
- Dynamically inject a tools reference so the agent has a concise "when to use" guide for every registered tool
- Track system prompt size and warn when it consumes too much context budget
- Hot-reload AGENT.md changes without restarting
- Inherit safety and communication rules into sub-agents

---

## AGENT.md

bolt uses a **single** `AGENT.md` file per workspace, located at `.bolt/AGENT.md`.

### Initialization

On first startup in a workspace, bolt copies the built-in `AGENT.md` into `.bolt/AGENT.md`. The file is **never overwritten** automatically — it belongs to the user to edit.

| File                | Scope             | Purpose                                                        |
| ------------------- | ----------------- | -------------------------------------------------------------- |
| `.bolt/AGENT.md`    | Workspace-level   | User-customized prompt; committed to the project repo          |
| Built-in `AGENT.md` | Shipped with bolt | Base content copied on first run; source of truth for defaults |

If `.bolt/AGENT.md` already exists, it is loaded as-is. If it is missing, the built-in default is copied from `src/AGENT.md` (dev) or `dist/AGENT.md` (prod) before loading. `src/assets.ts` exports `BUILTIN_AGENT_MD` as the resolved path using the same `__dirname` anchor as `BUILTIN_SKILLS_DIR` and `BUILTIN_WORKFLOWS_DIR`. `copy-assets.js` copies it to `dist/` on build.

Keeping the default in a file (rather than a hardcoded TypeScript string) means developers can read and edit it as plain Markdown without touching code.

### What to put in AGENT.md

- Agent identity and purpose ("You are a TypeScript engineering assistant...")
- Behavioral rules ("Always write tests before implementation")
- Communication style ("Be concise; use bullet points for lists")
- Domain knowledge ("This project uses Prisma for database access")
- Tool preferences ("Prefer file_edit over file_write for small changes")
- Task discipline ("For any goal requiring more than 2 steps, create tasks first")

---

## System Prompt Construction

At startup, bolt assembles the system prompt in **three steps**:

### Step 1: Load AGENT.md

```
If .bolt/AGENT.md exists:
  → read .bolt/AGENT.md
Else:
  → copy BUILTIN_AGENT_MD → .bolt/AGENT.md
  → read .bolt/AGENT.md
```

The built-in prompt is **always** the content that ends up in `.bolt/AGENT.md` on first run. Users edit this file directly to customize behavior.

### Step 2: Append dynamic skills catalog

After loading AGENT.md, bolt appends a `## Available Skills` section generated from the skills discovered at startup. This section lists every available skill with its name and description, so the agent always knows what capabilities are installed — including custom skills added to `.bolt/skills/` or `~/.bolt/skills/`.

### Step 3: Append dynamic tools reference

After the skills catalog, bolt appends a `## Available Tools` section generated from the ToolBus registry. Each tool is listed with its name and one-line description. This replaces the hardcoded tools reference table in `src/AGENT.md`, eliminating the maintenance burden of keeping the prompt and tool descriptions in sync.

The `tools` parameter sent in the Anthropic API call provides the model with detailed input schemas, but the system prompt reference gives the model a quick "when to use which tool" guide for tool selection.

### Final assembled prompt structure

```
[.bolt/AGENT.md content]

---

## Available Skills

The following skills are available via the `skill_run` tool:

| Skill | Description |
|-------|-------------|
| `analyze-trends` | Search trending topics, identify viral patterns, return a structured report |
| `write-blog-post` | Draft a long-form Markdown blog post for a given topic and tone |
...

---

## Available Tools

| Tool | Use for |
|------|---------|
| `file_read` | Read any file within the workspace |
| `file_write` | Create or overwrite a file within the workspace |
| `bash` | Run shell commands — git, npm, ffprobe, etc. |
...
```

### Token size tracking

After assembly, bolt estimates the token count of the system prompt (using a simple word-to-token heuristic: ~1.3 tokens per word for English). If the estimate exceeds a configurable threshold (`agentPrompt.maxTokens`, default 8000), a warning is logged at startup. This helps users catch accidentally oversized AGENT.md files before they consume significant context budget.

### Hot-reload

bolt watches `.bolt/AGENT.md` for changes using `fs.watch`. When the file changes, the system prompt is reassembled and the new prompt is used for the next API call. A progress event notifies the user that the prompt has been reloaded. Hot-reload is enabled by default in TTY mode and can be disabled with `--no-watch-prompt` or by setting `agentPrompt.watchForChanges` to `false`.

The assembled prompt is used as the `system` field in every Anthropic API call for the session. It is never modified mid-session except by hot-reload when the source file changes.

---

## Sub-Agent System Prompt Inheritance

Sub-agents spawned via `subagent_run` are fully context-isolated from the parent — they have no access to the parent's message history, memory, or tasks. However, they **do** inherit a subset of the parent's system prompt rules.

### Inherited rules

The following sections from the assembled system prompt are passed to sub-agents:

- Safety Rules
- Communication Style
- Operating Modes

These are extracted by parsing the assembled prompt for the `## Safety Rules`, `## Communication Style`, and `## Operating Modes` section headers. If a section is not found, it is silently skipped.

### Sub-agent system prompt construction

```
[Inherited rules from parent — Safety, Communication, Operating Modes]

[Sub-agent's own system prompt — from skill_run or the delegation prompt]
```

This ensures sub-agents follow the same safety constraints and communication style as the parent, while keeping task context fully isolated.

### Why inherit rules?

Without rule inheritance, sub-agents operate with no safety constraints or communication guidelines. A sub-agent tasked with "run npm test and fix failures" might not know about workspace confinement, dangerous command restrictions, or the project's code style conventions. Inheriting rules closes this gap without leaking task-specific context.

---

## Relationship to Memory

| Mechanism           | Controlled by | Lifetime               | Priority                                    |
| ------------------- | ------------- | ---------------------- | ------------------------------------------- |
| `AGENT.md`          | Human         | Permanent until edited | Highest — defines rules                     |
| `memory_write` (L3) | Agent freely  | Persistent, searchable | Informs context; can be overridden by rules |

The system prompt (`AGENT.md`) always takes precedence over L3 memory. If a rule in `AGENT.md` conflicts with something in L3 memory, the rule wins.

---

## Configuration

| Key                           | Default          | Description                                        |
| ----------------------------- | ---------------- | -------------------------------------------------- |
| `agentPrompt.projectFile`     | `.bolt/AGENT.md` | Path to the workspace agent prompt file            |
| `agentPrompt.maxTokens`       | `8000`           | Warning threshold for assembled system prompt size |
| `agentPrompt.watchForChanges` | `true`           | Enable hot-reload when AGENT.md files change       |

### Environment Variables

| Variable                   | Default          | Description                                        |
| -------------------------- | ---------------- | -------------------------------------------------- |
| `BOLT_AGENT_PROJECT_FILE`  | `.bolt/AGENT.md` | Path to the workspace agent prompt file            |
| `BOLT_AGENT_MAX_TOKENS`    | `8000`           | Warning threshold for assembled system prompt size |
| `BOLT_AGENT_WATCH_CHANGES` | `true`           | Enable hot-reload when AGENT.md files change       |
