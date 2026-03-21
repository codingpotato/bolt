# Authentication Design

## Goals

- Support two mutually exclusive authentication modes for the Anthropic API
- Fail fast with a clear error if neither mode is configured
- Never expose credentials in logs, audit trails, or error messages

## Modes

| Mode | Env Var | Description |
|------|---------|-------------|
| **API Key** | `ANTHROPIC_API_KEY` | Standard Anthropic API key; passed as the `x-api-key` header on every request |
| **Subscription** | `ANTHROPIC_SESSION_TOKEN` | Anthropic account session token (Claude.ai subscription); no API key required |

Exactly one of the two must be set at startup. If both are set, API Key mode takes precedence and a warning is logged. If neither is set, bolt exits immediately with a descriptive error.

## Startup Validation

```
Read environment / config
        │
        ▼
ANTHROPIC_API_KEY set?
  ├── yes → use API Key mode
  └── no  → ANTHROPIC_SESSION_TOKEN set?
               ├── yes → use Subscription mode
               └── no  → exit with error:
                          "Authentication required. Set ANTHROPIC_API_KEY
                           for API key mode, or ANTHROPIC_SESSION_TOKEN
                           for Anthropic subscription mode."
```

## Configuration

Auth mode can be set via environment variables or a config file (`.bolt/config.json`). Environment variables take precedence.

```jsonc
// .bolt/config.json
{
  "auth": {
    "mode": "api-key"   // "api-key" | "subscription"
  }
}
```

The actual credential is always read from the environment — never stored in the config file.

## Interface

```ts
type AuthMode = 'api-key' | 'subscription';

interface AuthConfig {
  mode: AuthMode;
  /** Resolved credential — never logged */
  credential: string;
}

function resolveAuth(): AuthConfig;  // throws if neither env var is set
```

`resolveAuth()` is called once at agent startup and the resulting `AuthConfig` is passed into the Anthropic SDK client constructor.

## Sub-agent Auth Inheritance

Sub-agents run as isolated child processes. They do not inherit the parent's environment variables directly. Auth config is passed at spawn time via a sealed argument:

```ts
// Parent spawns sub-agent
spawnSubagent({
  prompt,
  authConfig: resolveAuth(),   // resolved credential passed by value
  allowedTools,
});

// Child process receives auth config as a startup argument — never via env
// The child constructs its Anthropic SDK client from this argument, not from process.env
```

This ensures:
- Sub-agents cannot access env vars beyond what is explicitly passed
- Rotating a credential mid-session does not affect already-running sub-agents
- Sub-agents cannot escalate their own auth by reading a broader env

## Security Constraints

- Credentials must never appear in `tool-audit.jsonl` or any other log file
- Error messages must not echo the credential value, only its presence/absence
- Credentials are passed to sub-agents by value at spawn time; sub-agents do not read `process.env`
