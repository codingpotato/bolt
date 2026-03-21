# bolt

An autonomous AI CLI agent built with TypeScript and the Anthropic SDK.

bolt operates from the command line and completes complex, multi-step tasks by combining tool execution, memory, composable skills, and isolated sub-agent delegation.

## Features

- **Tool execution** — bash, file read/write/edit, web fetch, todo and task management
- **Memory** — compacts context on overflow and persists history across sessions
- **Skills** — loadable, composable capability modules (blog posts, code review, social content, etc.)
- **Sub-agent delegation** — spawns fully isolated child agents for subtasks
- **Discord integration** — connects to and operates within Discord channels
- **Structured tasks** — serialized tasks survive process restarts; can be paused and resumed

## Prerequisites

- Node.js >= 20
- npm >= 10
- One of:
  - `ANTHROPIC_API_KEY` — for API key mode
  - `ANTHROPIC_SESSION_TOKEN` — for Anthropic subscription mode

## Installation

```bash
git clone <repo>
cd bolt
npm install
cp .env.example .env    # fill in your API key or session token
npm run build
```

Install the TDD pre-commit hook (one-time):

```bash
cp scripts/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## Authentication

bolt supports three auth modes — set exactly one:

| Variable | Mode | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | API key | Standard Anthropic API |
| `ANTHROPIC_SESSION_TOKEN` | Subscription | Claude.ai account, no key needed |
| `BOLT_LOCAL_ENDPOINT` | Local | Custom base URL for the Anthropic SDK (any Anthropic-compatible server); no key needed |

Precedence when multiple are set: API Key > Subscription > Local. If none is set, bolt exits with a clear error.

### Using a local server

`BOLT_LOCAL_ENDPOINT` overrides the Anthropic SDK's base URL — no separate client needed. The server must implement the Anthropic Messages API (`POST /v1/messages`).

```bash
# Start a local server that speaks the Anthropic API
export BOLT_LOCAL_ENDPOINT=http://localhost:8080
npm start
```

See [docs/design/authentication.md](docs/design/authentication.md) for full details.

## First Run

```bash
# Start the CLI agent
npm start

# You'll get a prompt — type any task:
> Summarize the key points from https://example.com/article
> Write a bash script that counts lines in all .ts files
> Review the code in src/agent/core.ts
```

## Running a Skill

Skills are composable capability modules. Invoke one directly from the CLI:

```bash
bolt run-skill write-blog-post --topic "TypeScript strict mode" --tone "technical"
bolt run-skill review-code --path src/tools/bash.ts
bolt run-skill draft-social-post --platform twitter --topic "AI agents"
bolt run-skill summarize-url --url https://example.com/article
```

List all available skills:

```bash
bolt skills list
```

Add your own skills by placing `.skill.md` files in `.bolt/skills/`.

## Discord Integration

Set two additional environment variables:

```bash
DISCORD_BOT_TOKEN=your-bot-token
DISCORD_CHANNEL_ID=your-channel-id
```

Then start bolt in Discord mode:

```bash
npm start -- --channel discord
```

bolt will listen in the configured channel and reply to every message.

## Development

```bash
npm run dev           # watch mode — recompiles on change
npm run test:watch    # reruns tests on file change
npm run test:coverage # run tests + enforce coverage thresholds
npm run typecheck     # tsc --noEmit
npm run lint          # ESLint
npm run format        # Prettier
```

bolt uses TDD — write tests before implementation. The pre-commit hook rejects new `src/**/*.ts` files without a co-located `.test.ts`. See [docs/testing/unit-testing.md](docs/testing/unit-testing.md).

## Project Structure

```
bolt/
├── src/
│   ├── agent/          # agent core loop
│   ├── tools/          # tool implementations
│   ├── memory/         # memory manager & compact store
│   ├── tasks/          # task runner & serialization
│   ├── channels/       # channel implementations (CLI, Discord)
│   ├── content/        # content generation skills
│   └── cli/            # CLI entry point & arg parsing
├── docs/               # full design and planning docs
│   ├── requirements/
│   ├── design/
│   ├── testing/
│   ├── workflow/
│   └── planning/
├── scripts/
│   └── pre-commit      # TDD enforcement hook
└── .bolt/              # runtime data — gitignored
    ├── tasks.json
    ├── memory/
    └── skills/         # custom user skills go here
```

## Documentation

| Doc | Path |
|-----|------|
| Requirements | [docs/requirements/overview.md](docs/requirements/overview.md) |
| Architecture | [docs/design/architecture.md](docs/design/architecture.md) |
| Authentication | [docs/design/authentication.md](docs/design/authentication.md) |
| Tools System | [docs/design/tools-system.md](docs/design/tools-system.md) |
| Memory System | [docs/design/memory-system.md](docs/design/memory-system.md) |
| Task System | [docs/design/task-system.md](docs/design/task-system.md) |
| Skills System | [docs/design/skills-system.md](docs/design/skills-system.md) |
| Configuration | [docs/design/configuration.md](docs/design/configuration.md) |
| Project Plan | [docs/planning/plan.md](docs/planning/plan.md) |
| Dev Workflow | [docs/workflow/development.md](docs/workflow/development.md) |

## Configuration

Runtime configuration lives in `.bolt/config.json`. Environment variables override config file values. See [docs/design/configuration.md](docs/design/configuration.md) for all options.

Key env vars:

| Variable | Default | Description |
|---|---|---|
| `BOLT_MODEL` | `claude-opus-4-6` | Model ID sent in every API request |
| `BOLT_LOCAL_ENDPOINT` | — | Local server base URL (Anthropic API format) |
| `BOLT_LOCAL_API_KEY` | — | API key for local server (usually not needed) |
| `BOLT_DATA_DIR` | `.bolt` | Runtime data directory |
| `DISCORD_BOT_TOKEN` | — | Discord bot token |
| `DISCORD_CHANNEL_ID` | — | Discord channel to monitor |
