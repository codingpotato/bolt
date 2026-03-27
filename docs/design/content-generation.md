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
  │  4. comfyui_text2img × N            │
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
  │  6. comfyui_img2video × N           │
  │     Generate video per scene        │
  │     user_review → approve/redo      │
  └────────────┬────────────────────────┘
               │
  ┌────────────▼────────────────────────┐
  │  7. video_merge                     │
  │     Concatenate all approved clips  │
  │     → final/raw.mp4                 │
  │     user_review → approve/redo      │
  └────────────┬────────────────────────┘
               │
  ┌────────────▼────────────────────────┐
  │  8. video_add_audio (optional)      │
  │     Mix in background music or      │
  │     voiceover                       │
  │     → final/audio.mp4              │
  │     user_review → approve/redo      │
  └────────────┬────────────────────────┘
               │
  ┌────────────▼────────────────────────┐
  │  9. video_add_subtitles (optional)  │
  │     Generate SRT from storyboard    │
  │     dialogue, embed into video      │
  │     → final/video.mp4              │
  │     user_review → approve           │
  └────────────┬────────────────────────┘
               │
               ▼
         Final video saved to disk
         Channel completion message sent (S10-4)
```

Each step is a separate Task with `dependsOn` linking to the previous step and `requiresApproval: true`. All files are saved to a content project directory (see **Content Project** below); the manifest path is stored in the first task's result so every subsequent task knows exactly where to find its inputs.

This enables:
- Pausing and resuming the workflow across sessions — the agent reads `project.json` to reconstruct state
- Partial re-execution (e.g. redo step 4 for scene 3 only) — only that scene's artifacts are regenerated
- Full audit trail of all generated content — every artifact has a `status` in the manifest

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

## Content Project

Every video production run is a **content project** — a self-contained directory under the user's workspace that holds all intermediate and final files for that run. The project directory is the single source of truth for file locations throughout the workflow.

### Directory Structure

```
<workspace>/
  projects/
    <project-id>/               ← one directory per production run
      project.json              ← manifest: tracks all artifacts and their status
      01-trend-report.md        ← output of analyze-trends
      02-storyboard.json        ← structured storyboard from generate-video-script
      audio/                    ← user-supplied audio files (optional)
      scenes/
        subtitles.srt           ← auto-generated from storyboard dialogue (optional)
        scene-01/
          prompt.md             ← image prompt for scene 1
          image.png             ← generated image for scene 1
          video-prompt.md       ← motion prompt for scene 1
          clip.mp4              ← generated video clip for scene 1
        scene-02/
          ...
      final/
        raw.mp4                 ← merged clips (no extra audio/subs)
        audio.mp4               ← merged + added audio (if step 8 ran)
        video.mp4               ← final deliverable (last completed post-production step)
```

`<project-id>` is a slug derived from the topic and date, e.g. `ai-coding-trends-2026-03-24`. The `projects/` directory lives inside the user's workspace root (not inside `.bolt/`) so the user can browse and manage content directly.

### Project Manifest (`project.json`)

The manifest is written by the agent at project creation and updated after every step. It is the definitive index of all files and their status — the agent reads this file whenever it needs to locate an artifact.

```ts
interface ContentProject {
  id: string;                  // slug, e.g. "ai-coding-trends-2026-03-24"
  title: string;               // human-readable, e.g. "AI Coding Trends"
  topic: string;               // original user request
  createdAt: string;           // ISO 8601
  updatedAt: string;
  dir: string;                 // absolute path to project directory
  taskIds: {                   // maps workflow steps to task IDs
    analyzeTrends?: string;
    generateScript?: string;
    generateImagePrompts?: string;
    generateImages?: string;
    generateVideoPrompts?: string;
    generateVideos?: string;
    mergeClips?: string;
    addAudio?: string;
    addSubtitles?: string;
  };
  artifacts: {
    trendReport?: Artifact;
    storyboard?: Artifact;
    scenes: SceneArtifacts[];
    postProduction?: PostProductionArtifacts;
  };
}

interface Artifact {
  path: string;                // relative to project dir, e.g. "01-trend-report.md"
  status: 'pending' | 'draft' | 'approved' | 'failed';
  approvedAt?: string;
}

interface SceneArtifacts {
  sceneNumber: number;
  imagePrompt?: Artifact;      // scenes/scene-01/prompt.md
  image?: Artifact;            // scenes/scene-01/image.png
  videoPrompt?: Artifact;      // scenes/scene-01/video-prompt.md
  clip?: Artifact;             // scenes/scene-01/clip.mp4
}

interface PostProductionArtifacts {
  subtitles?: Artifact;        // scenes/subtitles.srt  (auto-generated from storyboard)
  rawVideo?: Artifact;         // final/raw.mp4  (merged clips, no extra audio/subs)
  audioVideo?: Artifact;       // final/audio.mp4 (merged + audio track)
  finalVideo?: Artifact;       // final/video.mp4 (last completed post-production step)
}
```

### How the Agent Finds Files

The task result for the project-creation task stores the manifest path as JSON:

```json
{ "projectId": "ai-coding-trends-2026-03-24", "manifestPath": "projects/ai-coding-trends-2026-03-24/project.json" }
```

Every subsequent task reads `project.json` with `file_read` to locate the files it needs. There is no reliance on remembering paths across task boundaries — the manifest is the lookup table.

Example: the `generate-images` task reads the manifest to find all approved `imagePrompt` artifacts, generates images for each, saves them to the scene directory, and updates each scene's `image` artifact status in the manifest.

### File Naming Conventions

| Artifact | Path | Notes |
|----------|------|-------|
| Trend report | `01-trend-report.md` | Markdown, numbered for sort order |
| Storyboard | `02-storyboard.json` | Structured JSON matching `Storyboard` schema |
| Image prompt | `scenes/scene-<NN>/prompt.md` | Zero-padded scene number |
| Generated image | `scenes/scene-<NN>/image.png` | PNG from ComfyUI |
| Video prompt | `scenes/scene-<NN>/video-prompt.md` | Motion prompt for img2video |
| Video clip | `scenes/scene-<NN>/clip.mp4` | MP4 from ComfyUI |
| Auto subtitles | `scenes/subtitles.srt` | SRT generated from storyboard dialogue |
| User audio | `audio/<filename>` | Copied from user-supplied path |
| Merged raw video | `final/raw.mp4` | Clips concatenated, no extra audio/subs |
| Video + audio | `final/audio.mp4` | After `video_add_audio` step |
| Final video | `final/video.mp4` | Last completed post-production step |

## ComfyUI Tool Integration

Image and video generation are handled by two built-in tools backed by the `ComfyUIPool` local module. See `docs/design/comfyui-client.md` for the full pool interface, load balancing strategy, and workflow template format.

### comfyui_text2img

```ts
// Tool call
comfyui_text2img({
  prompt: "detailed image prompt...",
  width?: 1024,
  height?: 1024,
  steps?: 20,
  seed?: 42,
  outputPath: "projects/ai-coding-trends-2026-03-24/scenes/scene-01/image.png"
})

// Tool result
{
  outputPath: "/abs/path/to/projects/.../scenes/scene-01/image.png",
  seed: 42,
  durationMs: 45000
}
// then: updates project.json scene[0].image.status = 'draft'
```

The tool selects the least-loaded ComfyUI server, patches the `text2img` workflow template, queues it, polls for completion, downloads the output image, and writes it to `outputPath`.

### comfyui_img2video

```ts
// Tool call
comfyui_img2video({
  imagePath: "projects/ai-coding-trends-2026-03-24/scenes/scene-01/image.png",
  prompt: "slow zoom in, subtle parallax...",
  frames: 121,   // ≈5s at 24fps; default when omitted
  fps: 24,
  outputPath: "projects/ai-coding-trends-2026-03-24/scenes/scene-01/clip.mp4"
})

// Tool result
{
  outputPath: "/abs/path/to/projects/.../scenes/scene-01/clip.mp4",
  durationMs: 120000
}
// then: updates project.json scene[0].clip.status = 'draft'
```

The tool uploads the source image to the selected ComfyUI server (`POST /upload/image`), patches the `video_ltx2_3_i2v` workflow (LTX-Video 2.3 22B) with the server filename and parameters, queues it, polls for completion, and downloads the output clip. The workflow internally enhances the prompt via a Gemma-based `TextGenerateLTX2Prompt` node.

## Tool Usage Summary

| Tool | Usage in content generation |
|------|----------------------------|
| `web_search` | Trend research, topic exploration, competitor analysis |
| `web_fetch` | Deep-read specific articles/pages for research |
| `file_read` | Read `project.json` manifest to locate artifacts; read prompts/storyboard for downstream steps |
| `file_write` | Save all artifacts (trend report, storyboard, prompts, images, videos, updated manifest) |
| `user_review` | Present drafts/storyboards/prompts/media for user approval; update manifest status on result |
| `comfyui_text2img` | Generate an image from a prompt via ComfyUI; writes output to the scene directory |
| `comfyui_img2video` | Generate a video clip from an image + motion prompt via ComfyUI; writes output to the scene directory |
| `skill_run` | Invoke content generation skills (analyze-trends, generate-video-script, etc.) |
| `task_create` | Set up the task DAG; first task result stores manifest path for all downstream tasks |
| `task_update` | Track progress; task result JSON references project ID and manifest path |
| `video_merge` | Concatenate approved scene clips into `final/raw.mp4` |
| `video_add_audio` | Mix background music or voiceover into the merged video |
| `video_add_subtitles` | Embed SRT subtitle track (soft or hard) into the final video |

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
