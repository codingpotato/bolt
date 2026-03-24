# Content Generation Design

## Goals

- Enable bolt to serve as a full-stack content creation assistant for social media bloggers
- Automate the workflow from trend research → content planning → media generation → review
- Support an interactive review loop: present intermediate results for user approval before expensive operations
- Integrate with external media generation services (ComfyUI) via MCP for text-to-image and image-to-video

## Content Types

| Type | Description | Output | Generation |
|------|-------------|--------|------------|
| **Trend report** | Analysis of trending topics with angles and recommendations | Structured Markdown | Agent + web_search |
| **Social post** | Short-form post for Twitter/X, LinkedIn, Xiaohongshu, etc. | Platform-optimised text | Skill |
| **Article** | Long-form written content (blog post, thread, newsletter) | Markdown text | Skill |
| **Video script + storyboard** | Script with shot-by-shot breakdown for short-form video | Structured Markdown (scenes, camera, dialogue) | Skill |
| **Image prompt** | Detailed prompt for text-to-image generation (ComfyUI) | Plain text prompt | Skill |
| **Video prompt** | Motion/animation prompt for image-to-video generation | Plain text prompt | Skill |
| **Generated image** | Image generated from a prompt | Image file (PNG/JPG) | MCP (ComfyUI) |
| **Generated video** | Video generated from image + motion prompt | Video file (MP4) | MCP (ComfyUI) |

## Built-in Skills

| Skill | Description | Key tools used |
|-------|-------------|---------------|
| `analyze-trends` | Search trending topics and produce a structured trend report with content angles | `web_search`, `web_fetch` |
| `write-blog-post` | Draft a long-form Markdown blog post on a given topic | `web_fetch` (optional research) |
| `draft-social-post` | Write a short-form social media post for a given platform and topic | — |
| `generate-video-script` | Write a video script with structured storyboard (scene-by-scene) | `web_fetch` (optional research) |
| `generate-image-prompt` | Create a detailed image generation prompt from a scene description | — |
| `generate-video-prompt` | Create a motion/animation prompt for image-to-video from a scene and image | — |
| `summarize-url` | Fetch a URL and return a structured summary | `web_fetch` |
| `review-code` | Perform a code review on a diff or file | `file_read` |

## Workflow Patterns

### Pattern 1: Autonomous (No User Review Needed)

For low-cost text-only operations where the agent can self-evaluate quality.

```
Topic/brief → skill_run → Draft → Output
```

Examples: social posts, blog posts, trend reports.

### Pattern 2: Interactive Review Loop

For workflows with expensive downstream steps. The agent presents intermediate outputs for user approval before proceeding.

```
                    ┌──────────────────────────────┐
                    │                              │
Topic/brief ──► Generate draft ──► user_review ──┤
                                       │          │
                                  approved?       │
                                   │    │         │
                                  yes   no ───────┘
                                   │    (feedback → revise)
                                   ▼
                           Proceed to next step
```

### Pattern 3: Full Video Production Pipeline

The most complex workflow, combining multiple skills, user review gates, and MCP calls.

```
User: "Make a short video about AI coding trends"
        │
        ▼
  ┌─────────────────────────────────────┐
  │  1. analyze-trends (skill)          │
  │     web_search × N → trend report   │
  │     user_review → approve/adjust    │
  └────────────┬────────────────────────┘
               │
  ┌────────────▼────────────────────────┐
  │  2. generate-video-script (skill)   │
  │     Script + storyboard (N scenes)  │
  │     user_review → approve/adjust    │
  └────────────┬────────────────────────┘
               │
  ┌────────────▼────────────────────────┐
  │  3. generate-image-prompt × N       │
  │     One prompt per scene            │
  │     user_review → approve/adjust    │
  └────────────┬────────────────────────┘
               │
  ┌────────────▼────────────────────────┐
  │  4. mcp_call(comfyui, text2img) × N │
  │     Generate image per scene        │
  │     user_review → approve/redo      │
  └────────────┬────────────────────────┘
               │
  ┌────────────▼────────────────────────┐
  │  5. generate-video-prompt × N       │
  │     Motion prompt per scene         │
  │     user_review → approve/adjust    │
  └────────────┬────────────────────────┘
               │
  ┌────────────▼────────────────────────┐
  │  6. mcp_call(comfyui, img2video) × N│
  │     Generate video per scene        │
  │     user_review → approve/redo      │
  └────────────┬────────────────────────┘
               │
               ▼
         Final output saved to disk
         Notification sent to user
```

Each step is a separate Task with `dependsOn` linking to the previous step and `requiresApproval: true`. This enables:
- Pausing and resuming the workflow across sessions
- Partial re-execution (e.g. redo step 4 for scene 3 only)
- Full audit trail of all generated content

## Storyboard Schema

The `generate-video-script` skill outputs a structured storyboard:

```ts
interface Storyboard {
  title: string;
  summary: string;
  targetPlatform: string;        // e.g. "tiktok", "youtube-shorts", "reels"
  estimatedDuration: string;     // e.g. "30s", "60s"
  scenes: Scene[];
}

interface Scene {
  sceneNumber: number;
  description: string;           // what happens in this scene
  dialogue?: string;             // voiceover or on-screen text
  camera: string;                // camera movement/angle description
  duration: string;              // e.g. "5s"
  imagePromptHint: string;       // brief hint for image prompt generation
  transitionTo?: string;         // transition to next scene (cut, fade, etc.)
}
```

## MCP Integration (ComfyUI)

Image and video generation are handled by an external ComfyUI MCP server (separate project).

### File Path Mapping

ComfyUI runs on a separate machine (GPU server) and returns paths on its own filesystem. The ComfyUI MCP Server is responsible for making generated files accessible to bolt:

- The MCP server copies completed files to a shared location accessible from bolt's machine (e.g. via NFS, scp, or HTTP download), or
- The MCP server returns an HTTP URL and bolt downloads the file using `web_fetch`

Either way, the ComfyUI MCP server's tool response must include a path or URL that bolt can use to store the file locally. bolt saves incoming media to `.bolt/media/<filename>` (within its workspace) before passing paths to subsequent tools or `user_review`. The workflow agent is responsible for calling `file_write` or a download helper to land the file locally before referencing it downstream.

### text2img

```ts
// mcp_call input
{
  server: "comfyui",
  tool: "text2img",
  args: {
    prompt: "detailed image prompt...",
    negativePrompt?: "...",
    width?: 1024,
    height?: 1024,
    steps?: 20,
    seed?: 42
  }
}

// mcp_call result (MCP server returns a URL or network path)
{
  result: {
    downloadUrl: "http://gpu-server:8188/output/img_001.png",  // fetched by bolt → .bolt/media/img_001.png
    seed: 42,
    durationMs: 45000
  }
}
```

### img2video

```ts
// mcp_call input
{
  server: "comfyui",
  tool: "img2video",
  args: {
    imagePath: "/output/img_001.png",
    motionPrompt: "slow zoom in, subtle parallax...",
    duration?: 5,
    fps?: 24
  }
}

// mcp_call result (MCP server returns a URL or network path)
{
  result: {
    downloadUrl: "http://gpu-server:8188/output/vid_001.mp4",  // fetched by bolt → .bolt/media/vid_001.mp4
    durationMs: 120000
  }
}
```

## Tool Usage Summary

| Tool | Usage in content generation |
|------|----------------------------|
| `web_search` | Trend research, topic exploration, competitor analysis |
| `web_fetch` | Deep-read specific articles/pages found via search |
| `user_review` | Present drafts/storyboards/prompts/media for user approval |
| `mcp_call` | Generate images (text2img) and videos (img2video) via ComfyUI |
| `file_write` | Save generated content, prompts, and final media to disk |
| `skill_run` | Invoke content generation skills (analyze-trends, generate-video-script, etc.) |
| `task_create` | Set up the task DAG for multi-step workflows |
| `task_update` | Track progress through the workflow |

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
