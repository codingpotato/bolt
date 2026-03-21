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
| `DISCORD_BOT_TOKEN` | No | — | Discord bot token (required if Discord channel is used) |
| `DISCORD_CHANNEL_ID` | No | — | Discord channel ID to monitor |
| `BOLT_MODEL` | No | `claude-opus-4-6` | Anthropic model ID |
| `BOLT_DATA_DIR` | No | `.bolt` | Runtime data directory |
| `BOLT_LOG_LEVEL` | No | `info` | Log verbosity: `debug` \| `info` \| `warn` \| `error` |

¹ Exactly one of `ANTHROPIC_API_KEY` or `ANTHROPIC_SESSION_TOKEN` must be set.

## `.bolt/config.json` Schema

```jsonc
{
  // Authentication
  "auth": {
    // "api-key" | "subscription"
    // If omitted, resolved from env vars automatically
    "mode": "api-key"
  },

  // Model selection
  "model": "claude-opus-4-6",

  // Memory system
  "memory": {
    // Fraction of context window that triggers compaction (0.0–1.0)
    "compactThreshold": 0.8,
    // Number of recent messages always retained after compaction
    "keepRecentMessages": 10,
    // Directory for compact store files (relative to BOLT_DATA_DIR)
    "storePath": "memory",
    // Search backend: "keyword" (default) | "embedding"
    "searchBackend": "keyword"
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

Credentials (`ANTHROPIC_API_KEY`, `ANTHROPIC_SESSION_TOKEN`, `DISCORD_BOT_TOKEN`) must only be set via environment variables — never written to `.bolt/config.json`. bolt rejects config files that contain credential fields.
