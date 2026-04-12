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
| `plan-video-production` | **Planner only** — creates the content project directory, builds the full 9-step task DAG with dependencies and approval gates, and returns a human-readable plan summary. No generation, no `user_review`. The main agent executes the DAG. | `content_project_create`, `task_create`, `task_list`, `file_read`, `file_write` |
| `analyze-trends` | Search trending topics and produce a structured trend report with content angles | `web_search`, `web_fetch` |
| `write-blog-post` | Draft a long-form Markdown blog post on a given topic | `web_fetch` (optional research) |
| `draft-social-post` | Write a short-form social media post for a given platform and topic | — |
| `generate-video-script` | Write a video script with structured storyboard (scene-by-scene) | `web_fetch` (optional research) |
| `generate-image-prompt` | Create a detailed image generation prompt from a scene description | — |
| `generate-video-prompt` | Create a motion/animation prompt for image-to-video from a scene and image | — |
| `summarize-url` | Fetch a URL and return a structured summary | `web_fetch` |
| `review-code` | Perform a code review on a diff or file | `file_read` |

### Video Pipeline Orchestration: Two-Phase Model

The video production pipeline uses a **two-phase model** that separates planning (subagent-safe) from execution (main agent only). This separation exists because skills run as isolated subagents with piped stdio — they cannot present content to the user or collect approval during execution.

#### Phase 1: `plan-video-production` skill (subagent)

The planner is a pure input → output skill: it creates the content project and task DAG, then returns a structured plan for the main agent to present and execute.

```
Input:
  topic:           string   — original user request / content brief
  title?:          string   — human-readable project title (defaults to topic)
  targetPlatform?: string   — "tiktok" | "youtube-shorts" | "reels" | "linkedin" (default: "tiktok")
  audioFile?:      string   — workspace-relative path to a background audio file (optional)
  projectId?:      string   — existing project ID to rebuild the DAG for resuming a run

Output:
  projectId:       string   — slug ID of the content project
  manifestPath:    string   — relative path to project.json
  planSummary:     string   — human-readable plan for the user to approve
  tasks:           object[] — task list with IDs, titles, and dependencies
```

**What the planner does NOT decide:**

Resolution and character design are **not** decided during planning. The planner's job is purely structural: create the project directory and task DAG. Resolution and characters are creative decisions made by the `generate-video-script` skill, which has the context needed to make them correctly (targetPlatform, topic, trend data).

**What the skill does:**

1. Calls `content_project_create({ topic, title })` → creates `projects/<id>/` with `project.json` and `tasks.json`
2. Creates the full task DAG via `task_create` (all pipeline steps, with `dependsOn` and `requiresApproval: true`):
   - `analyzeTrends` → `generateScript` → `generateImagePrompts` → `generateImages` → `generateVideoPrompts` → `generateVideos` → `mergeClips` → (optional `addAudio`) → (optional `addSubtitles`)
3. Builds a human-readable `planSummary` describing each step and its approval gate
4. Returns `{ projectId, manifestPath, planSummary, tasks }`

The skill does NOT call `user_review`, does NOT generate any content, and does NOT call `comfyui_text2img` or `comfyui_img2video`. It is a pure setup operation.

#### Phase 2: Main agent execution

After receiving the plan, the main agent:

1. Presents `planSummary` to the user via `user_review` — NO task execution starts until approved
2. If the user requests changes, re-runs `plan-video-production` with updated parameters
3. Walks through the task DAG step by step, calling the appropriate skill or tool for each task
4. After each generation step, calls `user_review` at the main agent level (never inside a subagent)
5. On approval: updates artifact status to `"approved"` and marks the task `completed`
6. On rejection: revises based on feedback and re-presents before proceeding

**Why the main agent executes instead of a skill:**

Skills run as isolated subagents with `stdio: ['pipe', 'pipe', 'pipe']`. A `user_review` call inside a subagent cannot reach the user's terminal or WebChannel — stdin is the serialized payload, not the user's keyboard. Placing review gates inside a skill means they are silently skipped or auto-approved, defeating the purpose of human-in-the-loop control.

The rule is: **any step that requires user interaction must execute at the main agent level, not inside a skill subagent.**

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

The most complex workflow, combining a planning skill, main-agent execution, per-step generation skills, and user review gates at every stage.

```
User: "Make a short video about AI coding trends"
        │
        ▼
  ┌─────────────────────────────────────┐  ← SUBAGENT (plan-video-production skill)
  │  plan-video-production              │
  │  Creates project + task DAG         │
  │  Returns planSummary + task list    │
  └────────────┬────────────────────────┘
               │ returns { projectId, planSummary, tasks }
               ▼
  [MAIN AGENT]  user_review(planSummary) → approve/adjust

  ┌─────────────────────────────────────┐  ← SUBAGENT (analyze-trends skill)
  │  1. analyze-trends                  │
  │     web_search × N → trend report   │
  └────────────┬────────────────────────┘
               │ returns trend report
               ▼
  [MAIN AGENT]  save → user_review → approve/adjust

  ┌─────────────────────────────────────┐  ← SUBAGENT (generate-video-script skill)
  │  2. generate-video-script           │
  │     Script + storyboard (N scenes)  │
  └────────────┬────────────────────────┘
               │ returns storyboard JSON
               ▼
  [MAIN AGENT]  save → user_review → approve/adjust

  ┌─────────────────────────────────────┐  ← SUBAGENT × N (generate-image-prompt skill)
  │  3. generate-image-prompt × N       │
  │     One prompt per scene            │
  └────────────┬────────────────────────┘
               │ returns prompts (all N scenes)
               ▼
  [MAIN AGENT]  save → user_review (show all prompts) → approve/adjust

  [MAIN AGENT]  4. comfyui_text2img × N  ← tool called directly by main agent
               → user_review (show all images) → approve/redo

  ┌─────────────────────────────────────┐  ← SUBAGENT × N (generate-video-prompt skill)
  │  5. generate-video-prompt × N       │
  │     Motion prompt per scene         │
  └────────────┬────────────────────────┘
               │ returns motion prompts (all N scenes)
               ▼
  [MAIN AGENT]  save → user_review (show all prompts) → approve/adjust

  [MAIN AGENT]  6. comfyui_img2video × N ← tool called directly by main agent
               → user_review (show all clips) → approve/redo

  [MAIN AGENT]  7. video_merge → final/raw.mp4
               → user_review → approve/redo

  [MAIN AGENT]  8. video_add_audio (optional) → final/audio.mp4
               → user_review → approve/redo

  [MAIN AGENT]  9. video_add_subtitles (optional) → final/video.mp4
               → user_review → approve

               ▼
         Final video saved to disk
         Channel completion message sent
```

**Key principle:** All `user_review` calls happen at the main agent level. Generation skills (`analyze-trends`, `generate-video-script`, `generate-image-prompt`, `generate-video-prompt`) run as subagents but only return data — they never call `user_review` themselves. The main agent presents their output and collects approval.

Each step is a separate Task with `dependsOn` linking to the previous step and `requiresApproval: true`. All files are saved to a content project directory (see **Content Project** below); the manifest path is stored in the first task's result so every subsequent task knows exactly where to find its inputs.

This enables:
- Pausing and resuming the workflow across sessions — the agent reads `project.json` to reconstruct state
- Partial re-execution (e.g. redo step 4 for scene 3 only) — only that scene's artifacts are regenerated
- Full audit trail of all generated content — every artifact has a `status` in the manifest

## Storyboard Schema

The `generate-video-script` skill outputs the storyboard as `02-storyboard.json`. The storyboard is the **complete production design document** — it contains all creative and technical decisions needed by downstream generation steps. This is why resolution and characters live here, not in `project.json`.

```ts
interface Storyboard {
  title: string;
  summary: string;
  /** Target platform: "tiktok" | "youtube-shorts" | "reels" | "youtube" | "linkedin" */
  targetPlatform: string;
  /**
   * Target video resolution — derived from targetPlatform by the scriptwriting skill.
   * ALL comfyui_text2img and comfyui_img2video calls in this project must use
   * these exact dimensions. Reading this from the storyboard is the single source
   * of truth; never hardcode or guess resolution elsewhere.
   *
   * Canonical values:
   *   tiktok / reels / youtube-shorts → { width: 1080, height: 1920 }  (9:16 portrait)
   *   youtube                         → { width: 1920, height: 1080 }  (16:9 landscape)
   *   linkedin                        → { width: 1080, height: 1080 }  (1:1 square)
   */
  resolution: { width: number; height: number };
  estimatedDuration: string;     // e.g. "30s", "60s"
  /**
   * All characters who appear in the video.
   * Empty array for narration-only or b-roll videos with no on-screen people.
   * Each character is referenced by ID from Scene.characterIds.
   */
  characters: Character[];
  scenes: Scene[];
}

interface Character {
  /** Short slug used to reference this character from scenes, e.g. "host", "guest-sarah" */
  id: string;
  /** Display name, e.g. "Sarah Chen" */
  name: string;
  /** Approximate age in years */
  age: number;
  /** e.g. "female", "male", "non-binary" */
  gender: string;
  /** Nationality or ethnic background, e.g. "Chinese-American", "British" */
  nationality: string;
  /**
   * Overall physical appearance for image generation.
   * Describe build, height, hair colour/length/style, distinguishing features.
   * Example: "slender build, medium height, straight black hair to shoulders, warm smile"
   */
  appearance: string;
  /**
   * Detailed face description for consistent character rendering across all scenes.
   * Must be specific enough that the image model renders the same face in every scene.
   * Example: "oval face, high cheekbones, dark almond-shaped eyes, light freckles, small nose"
   */
  face: string;
  /**
   * Clothing and accessories for consistent visual identity across scenes.
   * Example: "casual-smart: light blue blazer over white t-shirt, dark jeans, small gold earrings"
   */
  clothing: string;
  /**
   * Speaking accent for LTX-Video speech animation.
   * The LTX-Video model uses this to animate lip sync and speech cadence.
   * Be specific: language + regional variety.
   * Examples: "American English", "British RP English", "Mandarin-accented English",
   *            "Australian English", "French-accented English", "Japanese-accented English"
   */
  speakingAccent: string;
  /** Role in the video, e.g. "main presenter", "expert guest", "interviewer" */
  role: string;
}

interface Scene {
  sceneNumber: number;
  description: string;           // what happens visually in this scene
  dialogue?: string;             // spoken text for this scene (used for LTX speech animation)
  camera: string;                // camera movement/angle, e.g. "slow zoom in", "static wide shot"
  duration: string;              // e.g. "5s"
  imagePromptHint: string;       // brief hint for the generate-image-prompt skill
  /**
   * IDs of characters from Storyboard.characters who appear in this scene.
   * Empty array for pure b-roll or narration-only scenes.
   *
   * The generate-image-prompt skill uses this list to inject character descriptions
   * (face, appearance, clothing) into the image prompt to ensure visual consistency.
   *
   * The generate-video-prompt skill uses this list to inject speaking accent into the
   * video prompt so LTX-Video animates the correct speech style.
   */
  characterIds: string[];
  transitionTo?: string;         // transition to next scene, e.g. "cut", "fade to black"
}
```

### Character design guidelines

The `generate-video-script` skill decides:
1. **How many characters** the video needs (0–3 typical for short-form)
2. **Who each character is** — age, gender, nationality, role
3. **What they look like** — face, appearance, clothing (detailed enough for consistent image generation)
4. **How they speak** — accent for LTX-Video speech animation
5. **Which scenes they appear in** — `characterIds` in each scene

Character descriptions must be **detailed and deterministic**. Vague descriptions ("a young woman") produce inconsistent results across scenes. Good descriptions anchor specific visual features ("oval face, high cheekbones, dark almond-shaped eyes") that the image model can reproduce reliably.

### Character → prompt injection

When `generate-image-prompt` runs for a scene with `characterIds: ["host", "guest-sarah"]`:

1. Read storyboard → find Character objects for "host" and "guest-sarah"
2. Construct a character block for each:
   ```
   Host (Alex, 32, male, American):
   Face: square jaw, light stubble, hazel eyes, short wavy brown hair, straight nose
   Wearing: navy crewneck sweater, dark chinos
   ```
3. Inject these descriptions into the image prompt before the scene visual description
4. Result: consistent character appearance across all scenes regardless of generation order

When `generate-video-prompt` runs for a scene with speaking characters:

1. Read storyboard → find Character objects for characters in scene
2. Include speaking accent in motion description:
   ```
   Alex speaking with American English accent, explaining AI coding tools,
   natural hand gestures, subtle head movements while talking...
   ```
3. Include dialogue content from `scene.dialogue` to guide the speech animation

## Content Project Tools

`ContentProjectManager` is an internal TypeScript class that handles project directory creation and manifest I/O. To make it agent-callable, three built-in tools wrap it:

### `content_project_create`

Create a new content project directory and write the initial `project.json` manifest.

```ts
// Input
{ topic: string; title?: string }

// Output
{
  projectId: string;     // slug, e.g. "ai-coding-trends-2026-03-24"
  manifestPath: string;  // relative path to project.json
  tasksPath: string;     // relative path to tasks.json
  projectDir: string;    // absolute path to project directory
}
```

Creates `<workspace>/projects/<project-id>/` with `scenes/` and `final/` subdirectories, writes the initial `project.json` manifest and an empty `tasks.json`, registers the project in `.bolt/projects.json`, and returns the project reference. If a project with the same ID already exists, appends `-2`, `-3`, etc. to avoid overwriting.

**Note:** Resolution and characters are NOT set here. They are decided by the `generate-video-script` skill and stored in the storyboard (`02-storyboard.json`).

### `content_project_read`

Read the current state of a content project manifest.

```ts
// Input
{ projectId: string }

// Output
ContentProject  // full manifest as defined by the ContentProject interface
```

Returns `ToolError` if the project does not exist.

### `content_project_update_artifact`

Update an artifact's status in `project.json` (e.g. after generation or user approval).

```ts
// Input
{
  projectId: string;
  artifactPath: string;  // relative to project dir, e.g. "01-trend-report.md"
  status: 'pending' | 'draft' | 'approved' | 'failed';
}

// Output
{ updated: boolean }
```

Returns `updated: false` (not an error) if no artifact with the given path exists in the manifest.

**Why tools instead of direct `file_write`?**

The agent could theoretically create and update `project.json` via `file_write`, but:
- `ContentProjectManager` enforces directory structure and schema consistency
- Path traversal protection is applied at the manager layer (`getProjectFilePath`)
- The tools are atomic (read → mutate → write in one call) — no partial-update bugs
- The audit log records every manifest mutation with typed tool names

---

## Content Project

Every video production run is a **content project** — a self-contained directory under the user's workspace that holds all intermediate and final files for that run. The project directory is the single source of truth for file locations throughout the workflow.

### Directory Structure

```
<workspace>/
  projects/
    <project-id>/               ← one directory per production run
      project.json              ← manifest: tracks all artifacts and their status
      tasks.json                ← all tasks for this project (see docs/design/task-system.md)
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
  // NOTE: resolution and characters are NOT stored here.
  // They live in the storyboard (02-storyboard.json) which is the production design document.
  // Read the storyboard to get resolution before calling comfyui_text2img / comfyui_img2video.
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

Before generating images, the agent must read the approved storyboard to get `resolution` and the scene's `characterIds`. The storyboard is the single source of truth for both.

```ts
// Step 1: read storyboard to get resolution and character info (once, reuse for all scenes)
const project = content_project_read({ projectId })
const storyboard = JSON.parse(file_read({ path: project.artifacts.storyboard.path }))
// storyboard.resolution = { width: 1080, height: 1920 }
// storyboard.characters = [{ id: "host", face: "...", clothing: "...", ... }]

// Step 2: generate image prompt via skill (inject characters for the scene)
// The generate-image-prompt skill reads the storyboard and injects character descriptions
// for the characters listed in scene.characterIds

// Step 3: generate image at the storyboard resolution
comfyui_text2img({
  prompt: "detailed image prompt including character descriptions...",
  width: storyboard.resolution.width,    // ← always from storyboard
  height: storyboard.resolution.height,  // ← always from storyboard
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

The agent must pass the same `width` and `height` from `storyboard.resolution` that were used for image generation. This ensures the LTX-Video workflow receives the correct frame size and does not silently resize or crop the source image.

```ts
// Step 1: storyboard already loaded above (same read — do not re-read for every scene)

// Step 2: generate video prompt via skill (inject character accents for the scene)
// The generate-video-prompt skill reads the storyboard and adds speakingAccent
// for each character in scene.characterIds

// Step 3: generate video clip at the same resolution as the source image
comfyui_img2video({
  imagePath: "projects/ai-coding-trends-2026-03-24/scenes/scene-01/image.png",
  prompt: "slow zoom in, Alex speaking with American English accent, natural hand gestures...",
  width: storyboard.resolution.width,    // ← always from storyboard — must match source image
  height: storyboard.resolution.height,  // ← always from storyboard — must match source image
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

**Why explicit resolution is required:** If `width`/`height` are omitted, the LTX-Video workflow defaults to 1280×720, which will not match the source image dimensions and causes silent center-crop distortion. Always read from `storyboard.resolution`.

## Tool Usage Summary

| Tool | Usage in content generation |
|------|----------------------------|
| `content_project_create` | **Orchestrator only** — initialize the project directory and manifest at pipeline start |
| `content_project_read` | Any task — read `project.json` to locate artifacts and check step status |
| `content_project_update_artifact` | Any task — update artifact status after generation (`draft`) or user approval (`approved`) |
| `web_search` | Trend research, topic exploration, competitor analysis |
| `web_fetch` | Deep-read specific articles/pages for research |
| `file_read` | Read storyboard JSON, prompts, and other artifact content within the project directory |
| `file_write` | Save artifact content (trend report, storyboard, prompts) to the project directory |
| `user_review` | Present drafts/storyboards/prompts/media for user approval |
| `comfyui_text2img` | Generate an image from a prompt via ComfyUI; writes output to the scene directory |
| `comfyui_img2video` | Generate a video clip from an image + motion prompt via ComfyUI; writes output to the scene directory |
| `skill_run` | Invoke content generation skills (analyze-trends, generate-video-script, etc.) |
| `task_create` | Set up the task DAG; first task result stores `{ projectId, manifestPath }` |
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
