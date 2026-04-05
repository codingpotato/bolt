# Configuration Design

## Philosophy: Zero Configuration

bolt is designed to work out of the box with zero configuration. Only authentication is required to start — everything else uses sensible defaults. Users can optionally configure advanced features via environment variables or `.bolt/config.json`.

### Configuration Approaches

| User Type         | Method                                     | Example                                  |
| ----------------- | ------------------------------------------ | ---------------------------------------- |
| **Simple**        | `.env` file with credentials               | `ANTHROPIC_API_KEY=sk-ant-...`           |
| **Power user**    | `.bolt/config.json` for complex structures | ComfyUI server pools, workflow overrides |
| **DevOps/Docker** | Environment variables only                 | All config via `BOLT_*` vars             |

### Credentials

All credentials **must** be set via environment variables — never written to `.bolt/config.json`. bolt rejects config files containing credential fields.

## Sources and Precedence

Configuration is resolved from three sources, in order of precedence (highest first):

```
1. Environment variables        (highest — always wins)
2. .bolt/config.json            (project-level config)
3. Built-in defaults            (lowest)
```

## Environment Variables

All configuration can be set via environment variables. This enables Docker and containerized deployments without any config files.

### Authentication (Required — one of three modes)

| Variable                  | Required     | Default | Description                                                                                       |
| ------------------------- | ------------ | ------- | ------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | Conditional¹ | —       | Anthropic API key (API key auth mode)                                                             |
| `ANTHROPIC_SESSION_TOKEN` | Conditional¹ | —       | Anthropic account session token (subscription auth mode)                                          |
| `BOLT_LOCAL_ENDPOINT`     | Conditional¹ | —       | Base URL passed to the Anthropic SDK as `baseURL`, e.g. `http://localhost:8080` (local auth mode) |
| `BOLT_LOCAL_API_KEY`      | No           | —       | API key for the local server if it requires one                                                   |

### Core

| Variable              | Required | Default           | Description                                                                             |
| --------------------- | -------- | ----------------- | --------------------------------------------------------------------------------------- |
| `BOLT_MODEL`          | No       | `claude-opus-4-6` | Model ID sent in every API request                                                      |
| `BOLT_WORKSPACE_ROOT` | No       | `process.cwd()`   | Absolute path to the workspace root; all file operations are confined to this directory |
| `BOLT_DATA_DIR`       | No       | `.bolt`           | Runtime data directory (relative to workspace root if not absolute)                     |
| `BOLT_LOG_LEVEL`      | No       | `info`            | Log verbosity: `debug` \| `info` \| `warn` \| `error`                                   |

### Web Search

| Variable                  | Required | Default   | Description                                                              |
| ------------------------- | -------- | --------- | ------------------------------------------------------------------------ |
| `BOLT_SEARCH_PROVIDER`    | No       | `searxng` | Search provider: `searxng` \| `brave` \| `serper`                        |
| `BOLT_SEARCH_ENDPOINT`    | No       | —         | Endpoint URL for the search provider                                     |
| `BOLT_SEARCH_API_KEY`     | No       | —         | API key for web search provider (Brave, Serper). Not needed for SearXNG. |
| `BOLT_SEARCH_MAX_RESULTS` | No       | `10`      | Default max results per search                                           |

### ComfyUI

| Variable                          | Required | Default               | Description                                                                   |
| --------------------------------- | -------- | --------------------- | ----------------------------------------------------------------------------- |
| `BOLT_COMFYUI_SERVERS`            | No       | —                     | Comma-separated ComfyUI server URLs, e.g. `http://gpu1:8188,http://gpu2:8188` |
| `BOLT_COMFYUI_TEXT2IMG_WORKFLOW`  | No       | `image_z_image_turbo` | Workflow name for text-to-image                                               |
| `BOLT_COMFYUI_IMG2VIDEO_WORKFLOW` | No       | `video_ltx2_3_i2v`    | Workflow name for image-to-video                                              |
| `BOLT_COMFYUI_POLL_INTERVAL_MS`   | No       | `2000`                | Polling interval for `/history/{id}` (ms)                                     |
| `BOLT_COMFYUI_TIMEOUT_MS`         | No       | `300000`              | Max wait per generation (ms)                                                  |
| `BOLT_COMFYUI_MAX_CONCURRENT`     | No       | `2`                   | Max simultaneous jobs per server                                              |

### WebChannel

| Variable           | Required | Default     | Description                                                                   |
| ------------------ | -------- | ----------- | ----------------------------------------------------------------------------- |
| `BOLT_WEB_ENABLED` | No       | `false`     | Enable WebChannel HTTP/WebSocket server                                       |
| `BOLT_WEB_TOKEN`   | No       | —           | Authentication token for WebChannel (required when enabled for remote access) |
| `BOLT_WEB_HOST`    | No       | `0.0.0.0`   | HTTP server bind host                                                         |
| `BOLT_WEB_PORT`    | No       | `3000`      | HTTP/WebSocket port                                                           |
| `BOLT_WEB_MODE`    | No       | `websocket` | Connection mode: `websocket` \| `http`                                        |

### FFmpeg

| Variable           | Required | Default | Description                                                          |
| ------------------ | -------- | ------- | -------------------------------------------------------------------- |
| `BOLT_FFMPEG_PATH` | No       | —       | Explicit path to ffmpeg binary (resolved via system PATH if omitted) |

### Memory

| Variable                        | Required | Default   | Description                                                   |
| ------------------------------- | -------- | --------- | ------------------------------------------------------------- |
| `BOLT_MEMORY_COMPACT_THRESHOLD` | No       | `0.8`     | Fraction of context window that triggers compaction (0.0–1.0) |
| `BOLT_MEMORY_KEEP_RECENT`       | No       | `10`      | Number of recent messages always retained after compaction    |
| `BOLT_MEMORY_SEARCH_BACKEND`    | No       | `keyword` | Search backend for memory_search: `keyword` \| `embedding`    |

### CLI

| Variable            | Required | Default | Description                          |
| ------------------- | -------- | ------- | ------------------------------------ |
| `BOLT_CLI_PROGRESS` | No       | `true`  | Show progress events in TTY mode     |
| `BOLT_CLI_VERBOSE`  | No       | `false` | Show progress events in non-TTY mode |

### Agent Prompt

| Variable                   | Required | Default          | Description                                        |
| -------------------------- | -------- | ---------------- | -------------------------------------------------- |
| `BOLT_AGENT_PROJECT_FILE`  | No       | `.bolt/AGENT.md` | Path to the workspace agent prompt                 |
| `BOLT_AGENT_MAX_TOKENS`    | No       | `8000`           | Warning threshold for assembled system prompt size |
| `BOLT_AGENT_WATCH_CHANGES` | No       | `true`           | Enable hot-reload when AGENT.md files change       |

### Tasks & Tools

| Variable                       | Required | Default | Description                                               |
| ------------------------------ | -------- | ------- | --------------------------------------------------------- |
| `BOLT_TASKS_MAX_SUBTASK_DEPTH` | No       | `5`     | Max depth for nested subtasks                             |
| `BOLT_TASKS_MAX_RETRIES`       | No       | `3`     | Max retries for a failed task                             |
| `BOLT_TOOLS_TIMEOUT_MS`        | No       | `30000` | Timeout per tool call (ms, 0 = no timeout)                |
| `BOLT_TOOLS_ALLOWED`           | No       | —       | Comma-separated global tool allowlist (omit to allow all) |

### Code Workflows

| Variable                     | Required | Default | Description                                    |
| ---------------------------- | -------- | ------- | ---------------------------------------------- |
| `BOLT_CODE_TEST_FIX_RETRIES` | No       | `3`     | Max retries during automated test fix attempts |

¹ Exactly one of `ANTHROPIC_API_KEY`, `ANTHROPIC_SESSION_TOKEN`, or `BOLT_LOCAL_ENDPOINT` must be set. Precedence when multiple are set: API Key > Subscription > Local.

## `.bolt/config.json` Schema

Use `.bolt/config.json` for complex structures that are awkward in environment variables (server pools, workflow overrides, nested objects). All fields are optional — bolt works with zero config beyond authentication.

```jsonc
{
  // Workspace — the root directory for all file operations
  // bolt can only read/write files within this directory
  // Overridden by BOLT_WORKSPACE_ROOT env var
  "workspace": {
    // Absolute path to workspace root (default: process.cwd())
    "root": "/path/to/my/project",
  },

  // Authentication
  "auth": {
    // "api-key" | "subscription" | "local"
    // If omitted, resolved from env vars automatically
    "mode": "api-key",
  },

  // Model ID sent in every API request (all auth modes)
  "model": "claude-opus-4-6",

  // Local inference server (only used when auth.mode is "local")
  "local": {
    // Base URL passed to the Anthropic SDK as baseURL
    // Overridden by BOLT_LOCAL_ENDPOINT env var
    "endpoint": "http://localhost:8080",
  },

  // Web search
  "search": {
    // Search provider: "searxng" (default, free) | "brave" | "serper"
    "provider": "searxng",
    // Endpoint URL for the search provider
    // SearXNG: "http://localhost:8080" (local instance)
    // Brave: "https://api.search.brave.com" (default, uses BOLT_SEARCH_API_KEY)
    // Serper: "https://google.serper.dev" (default, uses BOLT_SEARCH_API_KEY)
    "endpoint": "http://localhost:8080",
    // Default max results per search
    "maxResults": 10,
  },

  // ComfyUI image and video generation
  "comfyui": {
    // Pool of ComfyUI servers; load balanced by queue depth
    // Can also be set via BOLT_COMFYUI_SERVERS env var (comma-separated URLs)
    "servers": [
      {
        // Server base URL (ComfyUI default port is 8188)
        "url": "http://gpu1:8188",
        // Relative capacity weight for load balancing (default: 1)
        // Use when servers have different GPU capacity (e.g. A100 vs 4090)
        "weight": 2,
      },
      {
        "url": "http://gpu2:8188",
        "weight": 1,
      },
    ],
    // Workflow name (without .json).
    // Resolved from .bolt/workflows/<name>.json first (user override),
    // then from the built-in src/workflows/ (shipped with bolt).
    "workflows": {
      "text2img": "image_z_image_turbo",
      "img2video": "video_ltx2_3_i2v",
    },
    // How often to poll /history/{promptId} for completion (ms)
    "pollIntervalMs": 2000,
    // Max time to wait for a single generation before returning a retryable ToolError (ms)
    "timeoutMs": 300000,
    // Max simultaneous jobs dispatched to one server
    "maxConcurrentPerServer": 2,
  },

  // FFmpeg video post-production
  "ffmpeg": {
    // Explicit path to ffmpeg binary (default: resolved via system PATH)
    // Can also be set via BOLT_FFMPEG_PATH env var
    "path": "/usr/local/bin/ffmpeg",
    // Default output video codec
    "videoCodec": "libx264",
    // CRF quality value (0–51; lower = better quality)
    "crf": 23,
    // Encoding preset (ultrafast..veryslow)
    "preset": "fast",
    // Default audio codec
    "audioCodec": "aac",
    // Default audio bitrate
    "audioBitrate": "128k",
  },

  // Memory system
  "memory": {
    // Fraction of context window that triggers compaction (0.0–1.0)
    "compactThreshold": 0.8,
    // Number of recent messages always retained in L1 after compaction
    "keepRecentMessages": 10,
    // Directory for L3 long-term memory files (relative to BOLT_DATA_DIR)
    "storePath": "memory",
    // Directory for L2 session store files (relative to BOLT_DATA_DIR)
    "sessionPath": "sessions",
    // Max number of prior task messages to inject from L2 into context
    "taskHistoryMessages": 20,
    // Max tokens to spend on injected task history (oldest entries dropped if over budget)
    "taskHistoryTokenBudget": 20000,
    // Inject recent chat history when no task is active and no --session flag is given
    "injectRecentChat": true,
    // Search backend for memory_search: "keyword" (default) | "embedding"
    "searchBackend": "keyword",
  },

  // Agent prompt system
  "agentPrompt": {
    // Path to the workspace agent prompt file
    // On first run, the built-in AGENT.md is copied here if it does not exist
    "projectFile": ".bolt/AGENT.md",
    // Directory for pending suggestion files
    "suggestionsPath": ".bolt/suggestions",
    // Warning threshold for assembled system prompt size in tokens (default: 8000)
    "maxTokens": 8000,
    // Enable hot-reload when AGENT.md files change (default: true in TTY mode)
    "watchForChanges": true,
  },

  // Task system
  "tasks": {
    // Max depth for nested subtasks (prevents infinite recursion)
    "maxSubtaskDepth": 5,
    // Max retries for a failed task before marking it as permanently failed
    "maxRetries": 3,
  },

  // Tool execution
  "tools": {
    // Timeout per tool call in milliseconds (0 = no timeout)
    "timeoutMs": 30000,
    // Global tool allowlist — overrides per-agent defaults (omit to allow all)
    "allowedTools": [],
  },

  // Code workflow
  "codeWorkflows": {
    // Max retries when a test run fails during automated fix attempts
    "testFixRetries": 3,
  },

  // CLI output
  "cli": {
    // Show progress events (tool calls, compaction, task changes) in TTY mode
    "progress": true,
    // Show progress events even in non-TTY mode (e.g. CI with visible output)
    "verbose": false,
  },

  // Channels
  "channels": {
    "web": {
      // Enable WebChannel HTTP/WebSocket server
      "enabled": false,
      // Host to bind to (default: "0.0.0.0")
      "host": "0.0.0.0",
      // Port to listen on
      "port": 3000,
      // "http" | "websocket"
      "mode": "websocket",
      // Simple token for authentication (required when enabled for remote access)
      // Should be set via BOLT_WEB_TOKEN env var in production
      "token": "",
    },
  },
}
```

## Defaults

All fields are optional. The defaults above apply when a field is omitted. bolt starts with zero config — only authentication is required.

## Validation

Configuration is validated at startup using the schema above. Invalid values cause bolt to exit with a descriptive error:

```
Error: config.memory.compactThreshold must be between 0.0 and 1.0, got: 1.5
Error: config.comfyui.servers[0].url is required when ComfyUI servers are configured
Error: config.search.provider must be one of: searxng, brave, serper
```

## Sensitive Values

Credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_SESSION_TOKEN`, `BOLT_LOCAL_API_KEY`, `BOLT_SEARCH_API_KEY`, `BOLT_WEB_TOKEN`) must only be set via environment variables — never written to `.bolt/config.json`. bolt rejects config files that contain credential fields.

Note: `channels.web.token` in `.bolt/config.json` is provided as a convenience for local development only. Production deployments must use `BOLT_WEB_TOKEN`.

`BOLT_LOCAL_ENDPOINT` is not a credential and may be set in `.bolt/config.json` under `local.endpoint`.
