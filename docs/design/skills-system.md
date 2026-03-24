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

bolt loads skills from two locations (in priority order):

| Priority | Location | Purpose |
|----------|----------|---------|
| 1 | `.bolt/skills/` | Project-local skills (gitignored by default) |
| 2 | `~/.bolt/skills/` | User-global skills |

Built-in skills ship with bolt under `src/skills/`.

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
| `generate-video-script` | Write a short-form video script with structured storyboard (scene-by-scene breakdown including camera, dialogue, transitions) | `web_fetch`, `web_search` |
| `generate-image-prompt` | Create a detailed image generation prompt optimised for the target model (e.g. SDXL, Flux) from a scene description | — |
| `generate-video-prompt` | Create a motion/animation prompt for image-to-video generation from a scene description and source image | — |

### Code Workflows

| Skill | Description | Allowed Tools |
|-------|-------------|---------------|
| `review-code` | Perform a code review on a diff or file; returns structured report | `file_read` |

## Adding a Custom Skill

1. Create `.bolt/skills/<skill-name>.skill.md` using the file format above
2. Run `/skills` inside a bolt session to verify it is discovered
3. Invoke with `/run-skill <skill-name> --<arg> <value>`

No code changes required.
