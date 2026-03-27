# ComfyUI Client Design

## Overview

ComfyUI image and video generation is handled by a local `ComfyUIPool` module — not via an external MCP server. This mirrors the pattern used by `FfmpegRunner` for video post-production: a TypeScript module encapsulates all network and protocol complexity, and two built-in tools expose generation capabilities to the LLM.

```
ComfyUIPool (internal module, not exposed to LLM)
  ├── servers: ComfyUIServer[]         ← from config.comfyui.servers[]
  ├── selectServer()                   ← queue-depth-aware load balancing
  ├── resolveWorkflow(name)            ← .bolt/workflows/ → BUILTIN_WORKFLOWS_DIR
  ├── uploadImage(localPath, server)   ← POST /upload/image
  ├── queueWorkflow(workflow, server)  ← POST /prompt → promptId
  └── pollResult(promptId, server)     ← GET /history/{id} until done → files

Built-in Tools (registered in Tool Bus, exposed to LLM):
  ├── comfyui_text2img(prompt, ...)    → { outputPath, seed, durationMs }
  └── comfyui_img2video(imagePath, …) → { outputPath, durationMs }
```

## Server Pool

### Configuration

Servers are declared in `.bolt/config.json`:

```jsonc
{
  "comfyui": {
    "servers": [
      { "url": "http://gpu1:8188", "weight": 2 },
      { "url": "http://gpu2:8188", "weight": 1 }
    ],
    "workflows": {
      // workflow name (without .json) — resolved from .bolt/workflows/ first, then built-in
      "text2img": "image_z_image_turbo",
      "img2video": "video_ltx2_3_i2v"
    },
    "pollIntervalMs": 2000,
    "timeoutMs": 300000,
    "maxConcurrentPerServer": 2
  }
}
```

### Load Balancing

`selectServer()` uses queue-depth-aware selection:

1. Query each server's `GET /queue` endpoint in parallel to get `queue_remaining`
2. Divide `queue_remaining` by the server's `weight` to compute an effective load score
3. Select the server with the lowest effective load score
4. Fall back to round-robin if all servers fail to respond to the queue query

```ts
interface ComfyUIServerConfig {
  url: string;
  weight: number;  // default 1; higher = more capacity
}

interface ComfyUIQueueStatus {
  queue_running: number;
  queue_pending: number;
}
```

### Health Checks

- At startup, `ComfyUIPool.init()` pings each server's `GET /system_stats` endpoint
- Unreachable servers are logged as warnings and excluded from the active pool
- If the pool is empty at startup, a warning is logged; the `comfyui_*` tools will return a non-retryable `ToolError` when called

## TypeScript Interface

```ts
interface ComfyUIOutput {
  files: Array<{
    filename: string;
    subfolder: string;
    type: 'output' | 'temp' | 'input';
  }>;
}

class ComfyUIPool {
  constructor(config: ComfyUIConfig, logger: Logger, progress: ProgressReporter);

  /** Resolve and validate the pool at startup */
  init(): Promise<void>;

  /** Select the least-loaded reachable server */
  selectServer(): Promise<ComfyUIServerConfig>;

  /**
   * Resolve a workflow name to a file path.
   * Checks .bolt/workflows/<name>.json first (user override),
   * then BUILTIN_WORKFLOWS_DIR/<name>.json (shipped with bolt).
   * Throws a non-retryable ToolError if neither exists.
   */
  resolveWorkflow(name: string): string;

  /**
   * Load a workflow JSON and its companion patchmap from disk.
   * Returns the raw workflow object and the parsed WorkflowPatchmap.
   */
  loadWorkflow(name: string): { workflow: Record<string, ComfyUINode>; patchmap: WorkflowPatchmap };

  /** Upload a local file to the server; returns the server-assigned filename */
  uploadImage(localPath: string, server: ComfyUIServerConfig): Promise<string>;

  /** Queue a patched workflow JSON; returns the promptId */
  queueWorkflow(workflow: object, server: ComfyUIServerConfig): Promise<string>;

  /** Poll /history/{promptId} until completed or timeout; returns output file list */
  pollResult(
    promptId: string,
    server: ComfyUIServerConfig,
    timeoutMs: number
  ): Promise<ComfyUIOutput>;

  /** Download an output file from the server to a local workspace path */
  downloadOutput(
    file: ComfyUIOutput['files'][number],
    server: ComfyUIServerConfig,
    localPath: string
  ): Promise<void>;
}
```

## Workflow Files

### Shipped workflows

bolt ships two production-ready ComfyUI API workflow files in `src/workflows/` (copied to `dist/workflows/` on build). These are real, working workflows — not templates or examples.

| Filename | Config name | Purpose | Model |
|----------|-------------|---------|-------|
| `image_z_image_turbo.json` | `image_z_image_turbo` | Text-to-image | Z-Image Turbo (AuraFlow + Qwen3 CLIP + ae VAE) |
| `video_ltx2_3_i2v.json` | `video_ltx2_3_i2v` | Image-to-video | LTX-Video 2.3 22B (i2v + Gemma prompt enhancer + audio) |

### Workflow resolution

`ComfyUIPool.resolveWorkflow(name)` checks two locations in order:

1. `.bolt/workflows/<name>.json` — user override (project-local, committed to user's repo)
2. `BUILTIN_WORKFLOWS_DIR/<name>.json` — bolt built-in (`src/workflows/` in dev, `dist/workflows/` in prod)

The config stores only the name (without `.json`). To swap in a custom workflow, place it in `.bolt/workflows/` under the same name and it takes precedence automatically.

`BUILTIN_WORKFLOWS_DIR` is exported from `src/assets.ts` using a `__dirname` anchor — see `docs/design/skills-system.md` for the dev/prod resolution mechanism (same pattern).

### Patchmap sidecar files

Each workflow has a companion `.patchmap.json` file at the same path. The patchmap declares which node IDs and input fields to overwrite for each tool parameter, and which node's outputs contain the generated file(s).

```
src/workflows/
  image_z_image_turbo.json
  image_z_image_turbo.patchmap.json
  video_ltx2_3_i2v.json
  video_ltx2_3_i2v.patchmap.json
```

**Patchmap schema:**

```ts
interface WorkflowPatchmap {
  /** Node ID whose outputs[] contains the generated file(s) to download */
  outputNode: string;
  /** img2video only: LoadImage node where the uploaded image filename is set */
  imageNode?: string;
  imageField?: string;
  /**
   * Maps each tool parameter name to one or more {nodeId, field} pairs.
   * The pool patches all listed nodes when that parameter is provided.
   * If a parameter is omitted by the caller, its nodes are left unchanged
   * (the workflow's own default values remain in effect).
   */
  params: Record<string, Array<{ nodeId: string; field: string }>>;
}
```

**Patching logic:**

```ts
// Patch format: { nodeId: { inputField: value } }
function patchWorkflow(
  workflow: Record<string, ComfyUINode>,
  patch: Record<string, Record<string, unknown>>
): Record<string, ComfyUINode>;
```

The pool deep-merges the patch into the workflow JSON. Only the specified fields change; everything else (model loaders, sampler settings, LoRA config, etc.) stays exactly as in the original file.

---

## Workflow Details

### Text-to-image: `image_z_image_turbo`

**Model stack:**
- UNet: `z_image_turbo_bf16.safetensors`
- CLIP: `qwen_3_4b.safetensors` (Lumina2 type)
- VAE: `ae.safetensors`
- Sampler: `res_multistep`, scheduler `simple`, cfg=1 (all fixed in workflow)

**Negative conditioning:** achieved via `ConditioningZeroOut` — there is no text-based negative prompt node. The `comfyui_text2img` tool does **not** accept a `negativePrompt` parameter.

**Patchmap (`image_z_image_turbo.patchmap.json`):**

```json
{
  "outputNode": "9",
  "params": {
    "prompt": [{ "nodeId": "57:27", "field": "text" }],
    "width":  [{ "nodeId": "57:13", "field": "width" }],
    "height": [{ "nodeId": "57:13", "field": "height" }],
    "steps":  [{ "nodeId": "57:3",  "field": "steps" }],
    "seed":   [{ "nodeId": "57:3",  "field": "seed" }]
  }
}
```

**Workflow defaults (applied when tool parameter is omitted):**

| Parameter | Default | Node |
|-----------|---------|------|
| `width` | 1024 | `57:13` |
| `height` | 1024 | `57:13` |
| `steps` | 8 | `57:3` |
| `seed` | random (existing value in workflow) | `57:3` |

---

### Image-to-video: `video_ltx2_3_i2v`

**Model stack:**
- Checkpoint: `ltx-2.3-22b-dev-fp8.safetensors`
- LoRA (distilled video): `ltx-2.3-22b-distilled-lora-384.safetensors` (strength 0.5, fixed)
- Text encoder: `gemma_3_12B_it_fp4_mixed.safetensors`
- LoRA (text): `gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors` (strength 1, fixed)
- Audio VAE: same as checkpoint
- Spatial upscaler: `ltx-2.3-spatial-upscaler-x2-1.0.safetensors`

**Prompt enhancement:** The workflow routes the user prompt through `TextGenerateLTX2Prompt` (node `267:274`), which uses the Gemma model to expand and refine the prompt before CLIP encoding. Users should provide a natural, detailed scene description — over-engineering the prompt is unnecessary as the enhancer handles refinement.

**Two-pass sampling:** The workflow uses two `SamplerCustomAdvanced` nodes in sequence (`267:219` → `267:215`). Each has its own `RandomNoise` seed node. A single `seed` tool parameter patches both seeds simultaneously for reproducibility. Seeds are independent by default in the workflow; patching with the same value makes generation deterministic.

**Image input:** The source image must be uploaded to the ComfyUI server first (`POST /upload/image`). The returned server-assigned filename is patched into `LoadImage` node `269`.

**Patchmap (`video_ltx2_3_i2v.patchmap.json`):**

```json
{
  "outputNode": "75",
  "imageNode": "269",
  "imageField": "image",
  "params": {
    "prompt":         [{ "nodeId": "267:266", "field": "value" }],
    "negativePrompt": [{ "nodeId": "267:247", "field": "text" }],
    "width":          [{ "nodeId": "267:257", "field": "value" }],
    "height":         [{ "nodeId": "267:258", "field": "value" }],
    "frames":         [{ "nodeId": "267:225", "field": "value" }],
    "fps":            [{ "nodeId": "267:260", "field": "value" }],
    "seed": [
      { "nodeId": "267:216", "field": "noise_seed" },
      { "nodeId": "267:237", "field": "noise_seed" }
    ]
  }
}
```

**Workflow defaults (applied when tool parameter is omitted):**

| Parameter | Default | Node | Notes |
|-----------|---------|------|-------|
| `negativePrompt` | `"pc game, console game, video game, cartoon, childish, ugly"` | `267:247` | Left unchanged if not provided |
| `width` | 1280 | `267:257` | |
| `height` | 720 | `267:258` | |
| `frames` | 121 | `267:225` | ≈5s at 24fps |
| `fps` | 24 | `267:260` | |
| `seed` | independent random seeds | `267:216`, `267:237` | |

---

## Tool Execution Flows

### comfyui_text2img

```
1. pool.selectServer()
2. pool.loadWorkflow("image_z_image_turbo") → { workflow, patchmap }
3. Build patch from tool args using patchmap.params
4. patchWorkflow(workflow, patch)
5. POST /prompt → { prompt_id }
6. Poll GET /history/{prompt_id} every pollIntervalMs
7. On completion: locate output in history[patchmap.outputNode].outputs
8. GET /view?filename=…&subfolder=…&type=output → download binary
9. Write to outputPath (workspace-relative, confinement-checked)
10. Return { outputPath, seed, durationMs }
```

### comfyui_img2video

```
1. pool.selectServer()
2. pool.uploadImage(imagePath, server) → serverFilename
3. pool.loadWorkflow("video_ltx2_3_i2v") → { workflow, patchmap }
4. Build patch: { [patchmap.imageNode]: { [patchmap.imageField]: serverFilename }, ...params }
5. patchWorkflow(workflow, patch)
6. POST /prompt → { prompt_id }
7. Poll GET /history/{prompt_id} every pollIntervalMs
8. On completion: locate output in history[patchmap.outputNode].outputs
9. GET /view → download binary
10. Write to outputPath
11. Return { outputPath, durationMs }
```

Progress events are emitted to `ProgressReporter` on every poll cycle (e.g. `"Generating video… 3 items in queue"`).

---

## Built-in Tool Specifications

### comfyui_text2img

```ts
// Input
interface Text2ImgInput {
  prompt: string;     // scene description — CLIP-encoded via Qwen3 in workflow
  width?: number;     // default 1024 (→ node 57:13.width)
  height?: number;    // default 1024 (→ node 57:13.height)
  steps?: number;     // default 8   (→ node 57:3.steps)
  seed?: number;      // random if omitted; returned in output (→ node 57:3.seed)
  outputPath: string; // workspace-relative path for the output image
}

// Output
interface Text2ImgOutput {
  outputPath: string; // absolute path to saved image
  seed: number;       // seed used — pass back to reproduce the same image
  durationMs: number;
}
```

Note: no `negativePrompt` — the `image_z_image_turbo` workflow uses `ConditioningZeroOut` for the negative, not a text node.

### comfyui_img2video

```ts
// Input
interface Img2VideoInput {
  imagePath: string;        // workspace-relative path to source image (uploaded to server)
  prompt: string;           // scene/motion description (enhanced by Gemma in workflow)
  negativePrompt?: string;  // default: workflow's built-in negative (→ node 267:247.text)
  width?: number;           // default 1280 (→ node 267:257.value)
  height?: number;          // default 720  (→ node 267:258.value)
  frames?: number;          // default 121  (→ node 267:225.value; 121 frames ≈ 5s at 24fps)
  fps?: number;             // default 24   (→ node 267:260.value)
  seed?: number;            // patches both RandomNoise nodes (267:216 and 267:237)
  outputPath: string;       // workspace-relative path for the output clip
}

// Output
interface Img2VideoOutput {
  outputPath: string; // absolute path to saved clip
  durationMs: number;
}
```

Both tools:
- Enforce workspace confinement on all path arguments before any network call
- Return a **non-retryable** `ToolError` if no ComfyUI servers are configured or the workflow file cannot be resolved
- Return a **retryable** `ToolError` on transient network or timeout failures
- Emit poll-cycle progress events to `ProgressReporter`

---

## Error Handling

| Condition | Retryable |
|-----------|-----------|
| No servers configured | No |
| All servers unreachable | Yes |
| Workflow file not found (neither user nor built-in) | No |
| Patchmap file missing | No |
| Queue submission — 4xx | No |
| Queue submission — 5xx / network | Yes |
| Poll timeout (`timeoutMs` exceeded) | Yes |
| Output download failed | Yes |
| Image upload failed | Yes |
| Path resolves outside workspace | No |

---

## Config Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `comfyui.servers[].url` | string | — | ComfyUI server base URL (e.g. `http://gpu1:8188`) |
| `comfyui.servers[].weight` | number | `1` | Relative capacity weight for load balancing |
| `comfyui.workflows.text2img` | string | `"image_z_image_turbo"` | Workflow name for text-to-image |
| `comfyui.workflows.img2video` | string | `"video_ltx2_3_i2v"` | Workflow name for image-to-video |
| `comfyui.pollIntervalMs` | number | `2000` | Polling interval for `/history/{id}` |
| `comfyui.timeoutMs` | number | `300000` | Max wait per generation (5 minutes) |
| `comfyui.maxConcurrentPerServer` | number | `2` | Max simultaneous jobs dispatched to one server |
