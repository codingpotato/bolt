# Skills System Design

## Goals

- Let users extend bolt's capabilities without touching core agent code
- Provide a standard way to package reusable, composable agent behaviors
- Allow skills to be invoked from the CLI, by the agent during task execution, or chained together

## What Is a Skill

A skill is a named, self-contained capability module. It consists of:

1. **A system prompt** — describes what the skill does and how the agent should behave when running it
2. **An input schema** — typed parameters the caller must provide
3. **An output schema** — typed result the skill produces
4. **Optional tools** — a subset of bolt's tools the skill is permitted to use

```ts
interface Skill {
  name: string;                  // kebab-case identifier, e.g. "write-blog-post"
  description: string;           // one-line summary shown in `bolt skills list`
  systemPrompt: string;          // injected as the system turn when the skill runs
  inputSchema: JSONSchema;       // validated before execution
  outputSchema: JSONSchema;      // validated after execution
  /**
   * Subset of tools this skill is permitted to use.
   * If omitted, the agent-level allowlist applies unchanged.
   * If set, the effective allowlist is the intersection of this list and the
   * agent-level allowlist (most restrictive wins).
   */
  allowedTools?: string[];
}
```

## Skill File Format

Skills are defined as `.skill.md` files. The frontmatter carries metadata; the body is the system prompt.

```markdown
---
name: write-blog-post
description: Draft a long-form blog post on a given topic
input:
  topic:
    type: string
    description: The subject to write about
  tone:
    type: string
    enum: [professional, casual, technical]
    default: professional
output:
  post:
    type: string
    description: The finished blog post in Markdown
allowedTools:
  - web_fetch
  - web_search
---

You are a skilled content writer. Given a topic and tone, write a complete,
well-structured blog post in Markdown. Use the web_search and web_fetch tools
to research the topic before writing if needed.
```

## Skill Discovery

bolt loads skills from two locations. A name collision in the workspace tier silently shadows the built-in definition.

| Priority | Location | Purpose |
|----------|----------|---------|
| 1 (highest) | `<workspace>/.bolt/skills/` | Project-local skills — the agent can write new `.skill.md` files here at runtime and use them immediately |
| 2 (lowest) | `BUILTIN_SKILLS_DIR` | Skills shipped with bolt — read-only, always available |

**Workspace skills are loaded fresh on every `skill_run` call.** Built-in skills are loaded once at startup. This means the agent can create a skill with `file_write`, then call it in the same session without restarting.

### Built-in skill path resolution

`src/assets.ts` exports `BUILTIN_SKILLS_DIR` anchored to `__dirname`:

```ts
// src/assets.ts
import { join } from 'path';
export const BUILTIN_AGENT_MD      = join(__dirname, 'AGENT.md');
export const BUILTIN_SKILLS_DIR    = join(__dirname, 'skills');
export const BUILTIN_WORKFLOWS_DIR = join(__dirname, 'workflows');
```

Because `package.json` sets `"type": "commonjs"`, `__dirname` resolves correctly in both phases without any environment flags or runtime checks:

| Phase | Entry point | `__dirname` in `assets.ts` | Resolved path |
|-------|-------------|---------------------------|---------------|
| Dev (`npm run dev`) | `tsx src/cli/index.ts` | `<repo>/src` | `src/skills/` |
| Prod (`npm start`) | `node dist/cli/index.js` | `<repo>/dist` | `dist/skills/` |

The build step (`tsc && node scripts/copy-assets.js`) copies `src/skills/*.skill.md → dist/skills/` so the path is always valid at runtime.

## Invocation

### From the CLI (interactive session)

```
/run-skill write-blog-post --topic TypeScript --tone technical
```

### By the agent during task execution

The agent can call the `skill_run` tool:

```json
{
  "tool": "skill_run",
  "input": {
    "name": "write-blog-post",
    "args": { "topic": "TypeScript generics", "tone": "technical" }
  }
}
```

### Chained skills (task definition)

```ts
const steps = [
  { skill: 'research-topic', args: { topic: 'LLM agents' } },
  { skill: 'write-blog-post', args: { tone: 'technical' } },  // receives prior output
];
```

## Execution Flow

```
Caller invokes skill(name, args)
        │
        ▼
Load skill definition from disk
        │
        ▼
Validate args against inputSchema
        │
        ▼
Spawn isolated agent run:
  - system prompt = skill.systemPrompt
  - available tools = skill.allowedTools
  - initial user message = serialized args
        │
        ▼
Agent loop executes until done
        │
        ▼
Validate result against outputSchema
        │
        ▼
Return result to caller
```

## Built-in Skills

### Content Research & Analysis

| Skill | Description | Allowed Tools |
|-------|-------------|---------------|
| `analyze-trends` | Search trending topics on social media, analyse viral patterns, produce a structured trend report with content angles and recommendations | `web_search`, `web_fetch` |
| `summarize-url` | Fetch a URL and return a structured summary | `web_fetch` |

### Text Content Generation

| Skill | Description | Allowed Tools |
|-------|-------------|---------------|
| `write-blog-post` | Draft a long-form Markdown blog post given topic + tone | `web_fetch`, `web_search` |
| `draft-social-post` | Write a short-form social media post for a given platform and topic | — |

### Video Production

| Skill | Description | Allowed Tools |
|-------|-------------|---------------|
| `plan-video-production` | **Planning only** — creates the content project directory, builds the full 9-step task DAG with `dependsOn` and `requiresApproval`, and returns a human-readable plan summary. Does NOT generate any content and does NOT call `user_review`. Accepts `projectId` to rebuild the DAG for a partially-completed run. | `content_project_create`, `content_project_read`, `task_create`, `task_list`, `file_read`, `file_write` |
| `generate-video-script` | Write a short-form video script with structured storyboard (scene-by-scene breakdown including camera, dialogue, transitions) | `web_fetch`, `web_search` |
| `generate-image-prompt` | Create a detailed image generation prompt optimised for the target model (e.g. SDXL, Flux) from a scene description | — |
| `generate-video-prompt` | Create a motion/animation prompt for image-to-video generation from a scene description | — |

> **Why `plan-video-production` is a skill but the execution is not:**
>
> Skills run as isolated subagents with piped stdio — they cannot interact with the user during execution. `user_review` called inside a subagent cannot reach the terminal or WebChannel. Any skill that needs to present content and wait for human approval must be refactored so the review gate happens at the **main agent level**, not inside the subagent.
>
> `plan-video-production` is safe as a subagent because it is purely deterministic: given inputs, it creates files and tasks and returns structured output — no interactive steps. The 9 execution steps with their approval gates run entirely in the main agent, which has full channel access.

### Code Workflows

| Skill | Description | Allowed Tools |
|-------|-------------|---------------|
| `review-code` | Perform a code review on a diff or file; returns structured report | `file_read` |

## Subagent Progress Visibility

When the agent calls `skill_run`, it spawns a child process. Without feedback, the user sees no activity while the subagent runs — which can feel like a freeze, especially for longer tasks like trend analysis or script generation.

The `skill_run` tool emits two progress events via `ProgressReporter`:

1. **On spawn:** `"Subagent starting: <skill-name> — <skill.description>"`
2. **On completion:** `"Subagent done: <skill-name> (<duration>ms)"`

These appear as progress lines in the CLI and as status messages in WebChannel, giving the user a clear signal that work is happening and what kind of work.

Example output during video production:

```
⟳ Subagent starting: analyze-trends — Search trending topics on social media...
⟳ Subagent done: analyze-trends (8240ms)
⟳ Subagent starting: generate-video-script — Write a short-form video script with structured storyboard
⟳ Subagent done: generate-video-script (12400ms)
⟳ Subagent starting: generate-image-prompt — Create a detailed image generation prompt...
⟳ Subagent done: generate-image-prompt (1800ms)
```

For skills that run in a loop (e.g. `generate-image-prompt` called once per scene), the per-call events give the user visibility into which scene is being processed.

---

## Adding a Custom Skill

**Manually (human):**

1. Create `<workspace>/.bolt/skills/<skill-name>.skill.md` using the file format above
2. Run `/skills` inside a bolt session to verify it is discovered
3. Invoke with `/run-skill <skill-name> --<arg> <value>`

**By the agent at runtime:**

The agent can create a workspace skill using `file_write` and immediately invoke it with `skill_run` — no restart required. Workspace skills are re-read from disk on every `skill_run` call, so a freshly written file is picked up automatically.

No code changes required in either case.
