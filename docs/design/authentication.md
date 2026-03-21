# Authentication Design

## Goals

- Support three mutually exclusive authentication modes
- Fail fast with a clear error if no mode is configured
- Never expose credentials in logs, audit trails, or error messages

## Modes

| Mode | Env Var(s) | Description |
|------|------------|-------------|
| **API Key** | `ANTHROPIC_API_KEY` | Standard Anthropic API key; passed as the `x-api-key` header on every request |
| **Subscription** | `ANTHROPIC_SESSION_TOKEN` | Anthropic account session token (Claude.ai subscription); no API key required |
| **Local** | `BOLT_LOCAL_ENDPOINT` | Custom Anthropic-compatible base URL (e.g. a local proxy or llama.cpp with Anthropic API support); uses the same Anthropic SDK with a different base URL; no API key required |

Exactly one mode must be active at startup. If multiple are configured, precedence is: **API Key > Subscription > Local**. If none is set, bolt exits immediately with a descriptive error.

## Startup Validation

```
Read environment / config
        │
        ▼
ANTHROPIC_API_KEY set?
  ├── yes → use API Key mode
  └── no  → ANTHROPIC_SESSION_TOKEN set?
               ├── yes → use Subscription mode
               └── no  → BOLT_LOCAL_ENDPOINT set?
                            ├── yes → use Local mode
                            └── no  → exit with error:
                                       "Authentication required. Set ANTHROPIC_API_KEY
                                        for API key mode, ANTHROPIC_SESSION_TOKEN for
                                        subscription mode, or BOLT_LOCAL_ENDPOINT to
                                        point bolt at a local Anthropic-compatible server."
```

## Configuration

Auth mode can be set via environment variables or a config file (`.bolt/config.json`). Environment variables take precedence.

```jsonc
// .bolt/config.json
{
  "auth": {
    // "api-key" | "subscription" | "local"
    // If omitted, resolved from env vars automatically
    "mode": "local"
  }
}
```

The actual credential is always read from the environment — never stored in the config file.

## Local Mode

Local mode uses the **Anthropic SDK unchanged**, but overrides the base URL so requests go to a local server instead of `api.anthropic.com`. This is useful for:

- Local proxies that implement the Anthropic API
- llama.cpp servers with Anthropic API compatibility layers
- Development/testing stubs

Required env var:

| Variable | Example | Description |
|---|---|---|
| `BOLT_LOCAL_ENDPOINT` | `http://localhost:8080` | Base URL passed to the Anthropic SDK as `baseURL` |

Optional env var:

| Variable | Default | Description |
|---|---|---|
| `BOLT_LOCAL_API_KEY` | _(none)_ | API key if the local server requires one; omitted from requests otherwise |

No separate HTTP client is needed — the Anthropic SDK handles all requests. The server must implement the Anthropic Messages API (`POST /v1/messages`).

### Quick Start

```bash
# Start a local server that speaks the Anthropic API
# (e.g. a proxy, llama.cpp with an Anthropic-compatible adapter)
my-local-server --port 8080

# Point bolt at it — no API key needed
export BOLT_LOCAL_ENDPOINT=http://localhost:8080
npm start
```

## Interface

```ts
type AuthMode = 'api-key' | 'subscription' | 'local';

interface AuthConfig {
  mode: AuthMode;
  /** Resolved credential — never logged. Empty string for local mode (unless BOLT_LOCAL_API_KEY is set). */
  credential: string;
  /** Only set when mode is "local" — passed as baseURL to the Anthropic SDK */
  localEndpoint?: string;
}

function resolveAuth(): AuthConfig;  // throws if no valid mode is configured
```

`resolveAuth()` is called once at agent startup. The resulting `AuthConfig` is passed into the Anthropic SDK client constructor for all three modes — local mode simply adds `baseURL: localEndpoint` to the constructor options.

## Sub-agent Auth Inheritance

Sub-agents run as isolated child processes. They do not inherit the parent's environment variables directly. Auth config is passed at spawn time via a sealed argument:

```ts
// Parent spawns sub-agent
spawnSubagent({
  prompt,
  authConfig: resolveAuth(),   // resolved AuthConfig passed by value
  allowedTools,
});

// Child constructs its Anthropic SDK client from this argument, not from process.env
```

For local mode, `localEndpoint` is included in the passed `AuthConfig` — the child does not read `BOLT_LOCAL_ENDPOINT` from the environment.

This ensures:
- Sub-agents cannot access env vars beyond what is explicitly passed
- Rotating a credential mid-session does not affect already-running sub-agents
- Sub-agents cannot escalate their own auth by reading a broader env

## Security Constraints

- Credentials must never appear in `tool-audit.jsonl` or any other log file
- Error messages must not echo the credential value, only its presence/absence
- Credentials are passed to sub-agents by value at spawn time; sub-agents do not read `process.env`
- In local mode, `BOLT_LOCAL_ENDPOINT` is not a credential but is still passed by value to sub-agents to maintain isolation
