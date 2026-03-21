# Development Workflow

## Prerequisites

- Node.js >= 20
- npm >= 10
- One of the following (see [Authentication design](../design/authentication.md)):
  - `ANTHROPIC_API_KEY` — for API key mode
  - `ANTHROPIC_SESSION_TOKEN` — for Anthropic subscription mode
- Optionally: a Discord bot token (`DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID`)

## Getting Started

```bash
git clone <repo>
cd bolt
npm install
cp .env.example .env        # fill in API keys
npm run build
npm start

# Install the pre-commit hook (one-time setup)
cp scripts/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```

## Project Structure

```
bolt/
├── src/
│   ├── agent/          # agent core loop
│   ├── tools/          # tool implementations
│   ├── memory/         # memory manager & compact store
│   ├── tasks/          # task runner & serialization
│   ├── channels/       # channel implementations (CLI, Discord, Web)
│   ├── content/        # social media content generation
│   └── cli/            # CLI entry point & arg parsing
├── docs/               # project documentation
│   ├── requirements/
│   ├── design/
│   ├── testing/
│   └── workflow/
├── scripts/
│   └── pre-commit      # TDD enforcement hook (copy to .git/hooks/)
├── .github/
│   └── pull_request_template.md   # PR checklist auto-loaded by GitHub
├── .bolt/              # runtime data (gitignored)
│   ├── tasks.json
│   └── memory/
├── CLAUDE.md
├── package.json
├── vitest.config.ts    # coverage thresholds enforced in CI
└── tsconfig.json
```

## Branching Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Stable, always deployable |
| `feat/<name>` | New feature work |
| `fix/<name>` | Bug fixes |
| `chore/<name>` | Tooling, deps, docs |

Work on a feature branch, open a PR to `main`, merge after review and green CI.

## Development Loop

bolt uses TDD — write tests before implementation. See [unit-testing.md](../testing/unit-testing.md) for the full TDD workflow.

```bash
# Start in watch mode (compiles + reruns on change)
npm run dev

# Run tests (watch mode — runs on every file save)
npm run test:watch

# Run tests with coverage (must pass thresholds)
npm run test:coverage

# Type check
npm run typecheck

# Lint
npm run lint
```

## Adding a New Tool

Follow the TDD cycle — tests come before implementation:

1. Write a failing unit test in `src/tools/<tool-name>.test.ts`
2. Run `npm test` — confirm the test is **red**
3. Create `src/tools/<tool-name>.ts` — export a `Tool` object with `name`, `description`, `inputSchema`, and `execute`
4. Register the tool in `src/tools/index.ts`
5. Run `npm test` — confirm the test is **green**
6. Refactor as needed; tests must stay green
7. Document the tool's purpose and parameters in a JSDoc comment at the top of the file
8. If the tool requires new environment variables, add them to `.env.example` and `docs/design/configuration.md`

## Code Style

- Strict TypeScript — `"strict": true` in `tsconfig.json`, no `any`
- Format with Prettier (`npm run format`)
- Lint with ESLint (`npm run lint`)
- All public functions should have JSDoc comments

## TDD Enforcement

Three mechanisms enforce the test-first rule:

| Mechanism | When | What it checks |
|-----------|------|----------------|
| **Pre-commit hook** (`scripts/pre-commit`) | On every `git commit` | Every new `src/**/*.ts` file must have a co-located `.test.ts` — commit is rejected otherwise |
| **Coverage gate** (`vitest.config.ts`) | On every `npm run test:coverage` | Per-module thresholds (90% tools, 85% memory/tasks, 70% agent) — fails the process if not met |
| **PR template** (`.github/pull_request_template.md`) | On every PR opened | Checklist includes "Tests written before implementation" — reviewer verifies before approving |

## CI Pipeline

On every PR:
1. `npm run typecheck`
2. `npm run lint`
3. `npm test -- --coverage` — **coverage thresholds enforced via `vitest.config.ts`; CI fails if any threshold is not met**
4. Build check: `npm run build`

All steps must pass before merging. PRs without tests for new behavior are rejected at review (see [agile.md](agile.md) PR checklist).

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Conditional | Anthropic API key — required if using API key auth mode |
| `ANTHROPIC_SESSION_TOKEN` | Conditional | Anthropic account session token — required if using subscription auth mode |
| `DISCORD_BOT_TOKEN` | No | Discord bot token |
| `DISCORD_CHANNEL_ID` | No | Discord channel to monitor |
| `BOLT_MODEL` | No | Anthropic model ID (default: `claude-opus-4-6`) |
| `BOLT_DATA_DIR` | No | Runtime data directory (default: `.bolt`) |
