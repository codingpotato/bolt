# Agent Prompt System Design

## Goals

- Give users a human-readable, versionable file to define bolt's identity, rules, and domain knowledge
- Support project-level and user-level prompt files with clear precedence
- Allow the agent to propose improvements to its own rules without being able to apply them unilaterally

---

## AGENT.md Files

bolt loads up to two `AGENT.md` files at startup and concatenates them into the system prompt:

| File | Scope | Priority |
|------|-------|----------|
| `~/.bolt/AGENT.md` | User-level — personal defaults, style preferences, cross-project rules | Lower |
| `.bolt/AGENT.md` | Project-level — project-specific rules, domain knowledge, tool preferences | Higher |

Both files are optional. If neither exists, bolt falls back to a built-in default system prompt.

**Concatenation order:** user-level content first, then project-level. Because project-level appears later, it can explicitly override or extend user-level rules.

### Built-in Default

If no user/project `AGENT.md` files are found, bolt reads the built-in default from `src/AGENT.md` (dev) or `dist/AGENT.md` (prod). `src/assets.ts` exports `BUILTIN_AGENT_MD` as the resolved path using the same `__dirname` anchor as `BUILTIN_SKILLS_DIR` and `BUILTIN_WORKFLOWS_DIR`. `copy-assets.js` copies it to `dist/` on build.

Keeping the default in a file (rather than a hardcoded TypeScript string) means developers can read and edit it as plain Markdown without touching code.

The current content of `src/AGENT.md`:

```
You are bolt, an autonomous AI agent operated from the command line.

You operate in two modes:
- Simple chat: respond directly to the user's message.
- Task-driven: for complex or multi-step goals, break work into tasks using
  task_create, execute them step by step, and track outcomes.

Prefer task-driven mode for anything that involves more than one non-trivial step.
Always persist important decisions and learned facts using memory_write.
```

### What to put in AGENT.md

- Agent identity and purpose ("You are a TypeScript engineering assistant...")
- Behavioral rules ("Always write tests before implementation")
- Communication style ("Be concise; use bullet points for lists")
- Domain knowledge ("This project uses Prisma for database access")
- Tool preferences ("Prefer file_edit over file_write for small changes")
- Task discipline ("For any goal requiring more than 2 steps, create tasks first")

---

## System Prompt Construction

At startup, AgentCore assembles the system prompt in this order:

```
1. ~/.bolt/AGENT.md content      (if exists)
2. .bolt/AGENT.md content        (if exists)
3. BUILTIN_AGENT_MD              (src/AGENT.md in dev, dist/AGENT.md in prod — always exists)
```

The assembled prompt is used as the `system` field in every Anthropic API call for the session. It is never modified mid-session.

---

## Self-Improvement: agent_suggest Tool

The agent cannot directly edit `AGENT.md`. Instead, it uses `agent_suggest` to propose a change. Proposals are written to `.bolt/suggestions/` and require explicit human approval before taking effect.

### Why the agent cannot self-edit

- `AGENT.md` is the human's voice — it defines the agent's authoritative rules including safety constraints
- Free self-modification would allow a confused or misbehaving agent to rewrite its own rules
- The proposal flow keeps humans in the loop for any change to core identity and behavior

### agent_suggest tool

```ts
interface AgentSuggestInput {
  target: 'AGENT.md';           // only AGENT.md is supported for now
  scope: 'project' | 'user';   // which file to propose editing
  content: string;              // the proposed content to append to the target file
  reason: string;               // why the agent thinks this change is warranted
}

interface AgentSuggestResult {
  suggestionId: string;         // ID of the created proposal
  path: string;                 // path to the proposal file
}
```

Proposals are written to `.bolt/suggestions/<id>.json`:

```ts
interface Suggestion {
  id: string;
  createdAt: string;
  sessionId: string;
  taskId?: string;
  target: 'AGENT.md';
  scope: 'project' | 'user';
  content: string;
  reason: string;
  status: 'pending' | 'applied' | 'rejected';
}
```

### Human review CLI

```
bolt suggestions          — list all pending proposals
bolt suggestions show <id> — show the full proposal content and reason
bolt suggestions apply <id> — append the proposal content to the target AGENT.md
bolt suggestions reject <id> — mark the proposal as rejected
```

`apply` appends `content` to the target file (`.bolt/AGENT.md` or `~/.bolt/AGENT.md`), creating it if it does not exist. The change takes effect on the next bolt startup.

### When should the agent call agent_suggest?

The agent should call `agent_suggest` when it has observed a consistent pattern across multiple interactions that would be better encoded as a standing rule — not for one-off preferences. Examples:

- The user has corrected the same behavior 3+ times
- The agent discovers a project convention not documented anywhere
- A task repeatedly fails because of a missing rule

For ephemeral or session-specific observations, `memory_write` is the right tool. `agent_suggest` is reserved for changes that belong in the permanent rulebook.

---

## Relationship to Memory

| Mechanism | Controlled by | Lifetime | Priority |
|-----------|--------------|---------|----------|
| `AGENT.md` | Human | Permanent until edited | Highest — defines rules |
| `memory_write` (L3) | Agent freely | Persistent, searchable | Informs context; can be overridden by rules |
| `agent_suggest` | Agent proposes, human applies | Permanent after approval | Becomes part of AGENT.md on apply |

The system prompt (`AGENT.md`) always takes precedence over L3 memory. If a rule in `AGENT.md` conflicts with something in L3 memory, the rule wins.

---

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `agentPrompt.projectFile` | `.bolt/AGENT.md` | Path to the project-level agent prompt file |
| `agentPrompt.userFile` | `~/.bolt/AGENT.md` | Path to the user-level agent prompt file |
| `agentPrompt.suggestionsPath` | `.bolt/suggestions` | Directory for pending suggestion files |
