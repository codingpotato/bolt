# Tools System Design

## Overview

bolt's tool system bridges the Anthropic model's tool-use API and the host environment. The model emits tool calls; the Tool Bus dispatches them to registered handler functions and returns results back into the conversation.

## Tool Interface

Every tool must implement this interface:

```ts
interface Tool<TInput = unknown, TOutput = unknown> {
  /** Unique snake_case name sent to and received from the model */
  name: string;
  /** One-line description shown to the model */
  description: string;
  /** JSON Schema for input — used to generate the Anthropic tool definition */
  inputSchema: JSONSchema;
  /**
   * If true, the Tool Bus will not run this tool concurrently with other
   * sequential tools. Use for tools that mutate shared state (e.g. todo_update).
   * Defaults to false.
   */
  sequential?: boolean;
  /** Execute the tool and return a result or throw a ToolError */
  execute(input: TInput, context: ToolContext): Promise<TOutput>;
}

interface ToolContext {
  /** Absolute working directory for the current session */
  cwd: string;
  /** Audit logger — every tool call is recorded to .bolt/tool-audit.jsonl */
  log: ToolLogger;
  /** Structured logger — operational/debug output written to .bolt/bolt.log */
  logger: Logger;
  /** Allowlisted tool names for the current agent scope (undefined = all allowed) */
  allowedTools?: string[];
  /** Progress reporter — emits real-time events to the CLI (no-op for sub-agents) */
  progress: ProgressReporter;
  /** Current session ID — used by tools that need to stamp session provenance */
  sessionId?: string;
  /** ID of the task currently being worked on, if any */
  activeTaskId?: string;
  /**
   * Optional confirmation callback for dangerous operations.
   * When absent (sub-agents, non-interactive mode) the operation is auto-denied.
   */
  confirm?: (message: string) => Promise<boolean>;
  /**
   * Channel reference for tools that need user interaction (user_review).
   * When absent, user_review falls back to confirm-style interaction.
   * See Channel interface in docs/design/architecture.md.
   */
  channel?: Channel;
  /**
   * ComfyUI Pool for dispatching comfyui_text2img and comfyui_img2video requests.
   * See ComfyUIPool interface in docs/design/comfyui-client.md.
   */
  comfyuiPool?: ComfyUIPool;
}
```

## Tool Bus

The Tool Bus is the central registry and dispatcher.

```ts
class ToolBus {
  register(tool: Tool): void;
  unregister(name: string): void;
  list(): Tool[];                         // returns tools visible in current scope
  getAnthropicDefinitions(): ToolDefinition[];  // schema format for the API call
  dispatch(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}
```

**Execution loop integration:**

```
Model response includes tool_use blocks
        │
        ▼
For each tool_use block (may run in parallel):
  ToolBus.dispatch(call, context)
        │
   ┌────┴─────┐
 found     not found
   │           │
execute     return ToolError("unknown tool")
   │
append tool_result to messages
        │
        ▼
Call model again with updated messages
```

## Built-in Tools

| Tool | Description |
|------|-------------|
| `bash` | Run a shell command; returns `{ stdout, stderr, exitCode }` |
| `file_read` | Read a file; returns `{ content }` |
| `file_write` | Write/overwrite a file; returns `{ path }` |
| `file_edit` | Replace a substring in a file; returns `{ path, changed }` |
| `web_fetch` | GET a URL; returns `{ body, statusCode, contentType }` |
| `web_search` | Search the web via configurable provider; returns `{ results[] }` |
| `user_review` | Present content for user approval/feedback; returns `{ approved, feedback? }` |
| `comfyui_text2img` | Generate an image from a prompt via ComfyUI; returns `{ outputPath, seed, durationMs }` |
| `comfyui_img2video` | Generate a video clip from an image + motion prompt via ComfyUI; returns `{ outputPath, durationMs }` |
| `todo_create` | Add a todo item; returns `{ id }` |
| `todo_update` | Update status or description of a todo item |
| `todo_list` | Return the current ordered todo list |
| `todo_delete` | Remove a todo item by id |
| `task_create` | Create a serialized task; returns `{ id }` |
| `task_update` | Update task status or result |
| `task_list` | Return all tasks with their current status |
| `skill_run` | Run a named skill as an isolated sub-agent; returns skill output |
| `subagent_run` | Delegate a free-form prompt to an isolated child agent |
| `memory_search` | Query the long-term memory store (L3); returns matching summaries |
| `memory_write` | Write a fact or note to the long-term memory store (L3) |
| `agent_suggest` | Propose an addition to `AGENT.md`; writes to `.bolt/suggestions/` for human review |
| `video_merge` | Concatenate video clips into a single file via FFmpeg; returns `{ outputPath, videoDurationSec }` |
| `video_add_audio` | Add or mix an audio track into a video via FFmpeg; supports replace and mix modes |
| `video_add_subtitles` | Embed a subtitle file (SRT/VTT/ASS) into a video via FFmpeg; supports soft and hard modes |

### web_search

Search the web using a configurable search provider. Designed for trend research and topic exploration.

```ts
interface WebSearchInput {
  /** The search query */
  query: string;
  /** Maximum number of results (default: 10) */
  maxResults?: number;
  /** Time range filter for recency */
  timeRange?: 'day' | 'week' | 'month' | 'year';
  /** Search category */
  category?: 'general' | 'news' | 'images' | 'videos';
}

interface WebSearchOutput {
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    date?: string;       // ISO 8601 if available
    source?: string;     // e.g. "twitter.com", "youtube.com"
  }>;
}
```

**Provider abstraction:** The search backend is selected by `search.provider` in config. All providers implement the same interface; only the HTTP call differs.

| Provider | Config value | Description |
|----------|-------------|-------------|
| **SearXNG** (default) | `"searxng"` | Self-hosted meta-search engine. Free, no API key. Default for development. |
| **Brave** | `"brave"` | Brave Search API. 2000 free requests/month. Requires API key. |
| **Serper** | `"serper"` | Google results via API. 2500 free credits. Requires API key. |

### user_review

Present content to the user for approval or feedback. This tool bridges the agent and the user for interactive workflows (e.g. reviewing a video storyboard before generating images).

```ts
interface UserReviewInput {
  /** Content to present for review */
  content: string;
  /** Type hint for rendering in WebChannel */
  contentType: 'script' | 'storyboard' | 'image_prompt' | 'video_prompt' | 'image' | 'video' | 'text';
  /** Question or instruction for the reviewer */
  question: string;
  /** Optional file paths for media preview (images, videos) */
  mediaFiles?: string[];
}

interface UserReviewOutput {
  /** Whether the user approved the content */
  approved: boolean;
  /** Optional feedback text when not approved or requesting changes */
  feedback?: string;
}
```

**Channel-specific behavior:**
- **CliChannel**: Renders content as text, prompts with `[approve/reject/feedback]:`
- **WebChannel**: Renders rich preview (markdown, images, video player), shows approve/reject buttons with a feedback text box
- **Disconnect handling**: If the WebSocket client disconnects while `user_review` is waiting, the tool throws a retryable `ToolError("client disconnected during review")`. The agent loop surfaces this to the model, which can re-call `user_review` once the client reconnects.

### comfyui_text2img

Generate an image from a text prompt using the `image_z_image_turbo` workflow (Z-Image Turbo, AuraFlow). `ComfyUIPool` selects the least-loaded server, patches the workflow with the provided parameters, queues it, polls for completion, and writes the image to `outputPath`.

No `negativePrompt` — the workflow uses `ConditioningZeroOut` for negative conditioning; there is no negative text node to patch.

```ts
interface Text2ImgInput {
  prompt: string;     // scene description (→ node 57:27.text)
  width?: number;     // default 1024 (→ node 57:13.width)
  height?: number;    // default 1024 (→ node 57:13.height)
  steps?: number;     // default 8   (→ node 57:3.steps)
  seed?: number;      // random if omitted (→ node 57:3.seed)
  outputPath: string; // workspace-relative path for the output image
}
interface Text2ImgOutput {
  outputPath: string; // absolute path to saved image
  seed: number;       // seed used — pass back to reproduce
  durationMs: number;
}
```

### comfyui_img2video

Generate a video clip from a source image using the `video_ltx2_3_i2v` workflow (LTX-Video 2.3 22B). The tool uploads the image to the selected server, patches the workflow, queues it, polls for completion, and writes the clip to `outputPath`.

The workflow routes `prompt` through a `TextGenerateLTX2Prompt` Gemma-based enhancer before CLIP encoding — provide a natural scene description rather than a heavily engineered prompt.

```ts
interface Img2VideoInput {
  imagePath: string;        // workspace-relative source image (→ uploaded, node 269.image)
  prompt: string;           // scene/motion description (→ node 267:266.value, Gemma-enhanced)
  negativePrompt?: string;  // default: workflow's built-in negative (→ node 267:247.text)
  width?: number;           // default 1280 (→ node 267:257.value)
  height?: number;          // default 720  (→ node 267:258.value)
  frames?: number;          // default 121  (→ node 267:225.value; ≈5s at 24fps)
  fps?: number;             // default 24   (→ node 267:260.value)
  seed?: number;            // patches both RandomNoise nodes 267:216 and 267:237
  outputPath: string;       // workspace-relative path for the output clip
}
interface Img2VideoOutput {
  outputPath: string; // absolute path to saved clip
  durationMs: number;
}
```

Both tools enforce workspace confinement on all paths and return a retryable `ToolError` on transient server failures. See `docs/design/comfyui-client.md` for the full workflow details, patchmap format, and error table.

### video_merge

Concatenate video clips into a single output file using FFmpeg. Requires `ffmpeg` to be installed on the host.

```ts
interface VideoMergeInput {
  /** Ordered list of clip paths (≥ 2). All must be within the workspace root. */
  clips: string[];
  /** Output path within workspace root. Extension determines container (.mp4 default). */
  outputPath: string;
  /** Force re-encode when clips have mismatched resolutions/codecs. Default: false. */
  reencode?: boolean;
}
interface VideoMergeOutput {
  outputPath: string;
  durationMs: number;
  videoDurationSec: number;
}
```

### video_add_audio

Add or mix an audio track into a video file.

```ts
interface VideoAddAudioInput {
  videoPath: string;
  audioPath: string;   // mp3, aac, wav, ogg — within workspace root
  outputPath: string;
  mode?: 'replace' | 'mix';         // default: "replace"
  audioVolume?: number;              // 0.0–2.0, default: 1.0
  originalVolume?: number;           // 0.0–2.0, default: 1.0 (mix mode only)
  fitToVideo?: boolean;              // trim/loop audio to video length, default: true
}
interface VideoAddAudioOutput {
  outputPath: string;
  durationMs: number;
}
```

### video_add_subtitles

Embed a subtitle file into a video as a soft track (selectable, lossless) or as hard-burned text (re-encode, universally compatible).

```ts
interface VideoAddSubtitlesInput {
  videoPath: string;
  subtitlesPath: string;   // .srt, .vtt, or .ass — within workspace root
  outputPath: string;
  mode?: 'soft' | 'hard';  // default: "soft"
  language?: string;        // BCP-47 code, e.g. "en", "zh" (soft mode only)
  fontSize?: number;        // default: 24 (hard mode only)
  fontColor?: string;       // CSS hex, default: "#ffffff" (hard mode only)
}
interface VideoAddSubtitlesOutput {
  outputPath: string;
  durationMs: number;
  subtitleCount: number;
}
```

All three tools enforce workspace confinement on every path argument and return a non-retryable `ToolError` if `ffmpeg` is not found. See `docs/design/video-editing.md` for the full FFmpeg command forms and error table.

## Tool Registration

Built-in tools are registered at agent startup. Additional tools can be registered at runtime:

```ts
agent.tools.register({
  name: 'custom_tool',
  description: 'A custom tool',
  inputSchema: {
    type: 'object',
    properties: {
      input: { type: 'string' }
    },
    required: ['input']
  },
  execute: async ({ input }, ctx) => {
    return { output: input.toUpperCase() };
  }
});
```

## Tool Allowlisting

Each agent scope (top-level, skill, sub-agent) carries an optional `allowedTools` set. The Tool Bus filters its list and rejects dispatch calls for tools outside the allowlist.

```ts
// Sub-agent that can only read files and search memory
const result = await subagentRun(prompt, {
  allowedTools: ['file_read', 'memory_search']
});
```

**Allowlist precedence when multiple scopes apply:**

The Tool Bus enforces the **intersection** of all active allowlists — the most restrictive set wins.

```
Agent-level allowlist:  ['bash', 'file_read', 'file_write', 'web_fetch']
Skill-level allowlist:  ['web_fetch', 'file_write']
                                  ↓ intersection
Effective allowlist:    ['web_fetch', 'file_write']
```

If a skill omits `allowedTools` (defaults to all tools), the agent-level allowlist applies unchanged. If the agent-level allowlist is also absent, all registered tools are available.

## Error Handling

Tools signal failure by throwing a `ToolError`:

```ts
class ToolError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean = false
  ) { super(message); }
}
```

The Tool Bus catches `ToolError`, serializes it as a `tool_result` with `is_error: true`, and returns it to the model so it can decide how to proceed.

## Audit Logging

Every tool call and result is appended to `.bolt/tool-audit.jsonl`:

```jsonc
{ "ts": "2026-03-21T10:00:00Z", "tool": "bash", "input": { "command": "ls" }, "result": { "stdout": "...", "exitCode": 0 } }
{ "ts": "2026-03-21T10:00:01Z", "tool": "web_search", "input": { "query": "AI coding trends" }, "result": { "results": [...] } }
{ "ts": "2026-03-21T10:00:05Z", "tool": "comfyui_text2img", "input": { "prompt": "...", "outputPath": "scenes/scene-01/image.png" }, "result": { "outputPath": "...", "seed": 42, "durationMs": 45000 } }
```

## Parallelism

When the model returns multiple `tool_use` blocks in one response, the Tool Bus runs them concurrently with `Promise.all`, unless a tool declares `{ sequential: true }` (e.g. tools that mutate shared state like `todo_update`).
