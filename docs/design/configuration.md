# Configuration Design

## Sources and Precedence

Configuration is resolved from three sources, in order of precedence (highest first):

```
1. Environment variables        (highest — always wins)
2. .bolt/config.json            (project-level config)
3. Built-in defaults            (lowest)
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | Conditional¹ | — | Anthropic API key (API key auth mode) |
| `ANTHROPIC_SESSION_TOKEN` | Conditional¹ | — | Anthropic account session token (subscription auth mode) |
| `BOLT_LOCAL_ENDPOINT` | Conditional¹ | — | Base URL passed to the Anthropic SDK as `baseURL`, e.g. `http://localhost:8080` (local auth mode) |
| `BOLT_LOCAL_API_KEY` | No | — | API key for the local server if it requires one |
| `DISCORD_BOT_TOKEN` | No | — | Discord bot token (required if Discord channel is used) |
| `DISCORD_CHANNEL_ID` | No | — | Discord channel ID to monitor |
| `BOLT_MODEL` | No | `claude-opus-4-6` | Model ID sent in every API request (applies to all three auth modes) |
| `BOLT_DATA_DIR` | No | `.bolt` | Runtime data directory |
| `BOLT_LOG_LEVEL` | No | `info` | Log verbosity for `.bolt/bolt.log`: `debug` \| `info` \| `warn` \| `error`. Entries below this level are dropped. `error`-level entries are also written to stderr. See `docs/design/logging.md`. |

¹ Exactly one of `ANTHROPIC_API_KEY`, `ANTHROPIC_SESSION_TOKEN`, or `BOLT_LOCAL_ENDPOINT` must be set. Precedence when multiple are set: API Key > Subscription > Local.

## `.bolt/config.json` Schema

```jsonc
{
  // Authentication
  "auth": {
    // "api-key" | "subscription" | "local"
    // If omitted, resolved from env vars automatically
    "mode": "api-key"
  },

  // Model ID sent in every API request (all auth modes)
  "model": "claude-opus-4-6",

  // Local inference server (only used when auth.mode is "local")
  "local": {
    // Base URL passed to the Anthropic SDK as baseURL
    // Overridden by BOLT_LOCAL_ENDPOINT env var
    "endpoint": "http://localhost:8080"
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
    "searchBackend": "keyword"
  },

  // Agent prompt system
  "agentPrompt": {
    // Path to the project-level agent prompt file
    "projectFile": ".bolt/AGENT.md",
    // Path to the user-level agent prompt file
    "userFile": "~/.bolt/AGENT.md",
    // Directory for pending suggestion files
    "suggestionsPath": ".bolt/suggestions"
  },

  // Task system
  "tasks": {
    // Max depth for nested subtasks (prevents infinite recursion)
    "maxSubtaskDepth": 5,
    // Max retries for a failed task before marking it as permanently failed
    "maxRetries": 3
  },

  // Tool execution
  "tools": {
    // Timeout per tool call in milliseconds (0 = no timeout)
    "timeoutMs": 30000,
    // Global tool allowlist — overrides per-agent defaults (omit to allow all)
    "allowedTools": []
  },

  // Code workflow
  "codeWorkflows": {
    // Max retries when a test run fails during automated fix attempts
    "testFixRetries": 3
  },

  // Channels
  "channels": {
    "web": {
      // Enable WebChannel HTTP/WebSocket server
      "enabled": false,
      // Port to listen on
      "port": 3000,
      // "http" | "websocket"
      "mode": "websocket"
    }
  }
}
```

## Defaults

All fields are optional. The defaults above apply when a field is omitted. bolt starts with zero config — only authentication is required.

## Validation

Configuration is validated at startup using the schema above. Invalid values cause bolt to exit with a descriptive error:

```
Error: config.memory.compactThreshold must be between 0.0 and 1.0, got: 1.5
```

## Sensitive Values

Credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_SESSION_TOKEN`, `DISCORD_BOT_TOKEN`, `BOLT_LOCAL_API_KEY`) must only be set via environment variables — never written to `.bolt/config.json`. bolt rejects config files that contain credential fields.

`BOLT_LOCAL_ENDPOINT` is not a credential and may be set in `.bolt/config.json` under `local.endpoint`.
