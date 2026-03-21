# Content Generation Design

## Goals

- Enable bolt to autonomously produce social media content: articles, images, and short videos
- Expose content generation as composable skills so it can be triggered from the CLI, by the agent, or chained into larger workflows

## Content Types

| Type | Description | Output |
|------|-------------|--------|
| **Article** | Long-form written content (blog post, thread, newsletter) | Markdown text |
| **Image prompt** | Detailed prompt suitable for an image generation model | Plain text prompt |
| **Short video script** | Script + shot list for short-form video (e.g. Reels, TikTok) | Structured Markdown |
| **Social post** | Short-form post for Twitter/X, LinkedIn, etc. | Plain text |

## Built-in Skills

| Skill | Description |
|-------|-------------|
| `write-blog-post` | Draft a long-form Markdown blog post on a given topic |
| `generate-image-prompt` | Create a detailed image generation prompt from a description |
| `generate-video-script` | Write a short-form video script and shot list (Reels, TikTok, YouTube Shorts) |
| `draft-social-post` | Write a short-form social media post for a given platform and topic |

## Workflow

Content generation follows the standard skill execution flow:

```
Caller provides topic / brief
        │
        ▼
skill_run invoked with typed args
        │
        ▼
Isolated agent run with content-specific system prompt
        │
  ┌─────┴──────┐
  │  Optional  │
  │ web_fetch  │  ← research phase, if skill allows it
  └─────┬──────┘
        │
        ▼
Draft produced and validated against outputSchema
        │
        ▼
Result returned to caller
```

## Chaining Example

Research a topic and then write a blog post:

```bash
bolt run-skill summarize-url --url "https://example.com/paper" \
  | bolt run-skill write-blog-post --tone technical
```

Or in a task definition:

```ts
const steps = [
  { skill: 'summarize-url', args: { url: 'https://example.com/paper' } },
  { skill: 'write-blog-post', args: { tone: 'technical' } },
];
```

## Tool Usage

| Tool | Usage |
|------|-------|
| `web_fetch` | Research topics before writing (if the skill's `allowedTools` permits) |
| `file_write` | Persist generated content to disk if requested |
