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
│   ├── channels/       # channel implementations (CLI, Web)
│   ├── content/        # social media content generation
│   ├── cli/            # CLI entry point & arg parsing
│   ├── assets.ts       # exports BUILTIN_AGENT_MD, BUILTIN_SKILLS_DIR, BUILTIN_WORKFLOWS_DIR
│   ├── AGENT.md        # built-in default agent prompt (git-tracked, copied to dist/ on build)
│   ├── skills/         # built-in .skill.md files (git-tracked, copied to dist/ on build)
│   └── workflows/      # ComfyUI workflow JSON + .patchmap.json sidecars (git-tracked, copied to dist/ on build)
├── dist/               # compiled output (gitignored)
│   ├── skills/         # copied from src/skills/ by build script
│   └── workflows/      # copied from src/workflows/ by build script
├── docs/               # project documentation
│   ├── requirements/
│   ├── design/
│   ├── testing/
│   └── workflow/
├── scripts/
│   ├── pre-commit      # TDD enforcement hook (copy to .git/hooks/)
│   └── copy-assets.js  # post-build: copies src/skills/ and src/workflows/ to dist/
├── .github/
│   └── pull_request_template.md   # PR checklist auto-loaded by GitHub
├── .bolt/              # project config and runtime data
│   ├── AGENT.md        # project-level agent prompt (git-tracked)
│   ├── config.json     # project config — no credentials (git-tracked)
│   ├── skills/         # custom skill overrides (git-tracked)
│   ├── workflows/      # ComfyUI workflow configs, bootstrapped from examples (git-tracked)
│   ├── tasks.json      # runtime task state (gitignored)
│   ├── sessions/       # conversation history (gitignored)
│   └── memory/         # long-term memory (gitignored)
├── CLAUDE.md
├── package.json
├── vitest.config.ts    # coverage thresholds enforced in CI
└── tsconfig.json
```

## Built-in Asset Dispatch (Dev vs Prod)

bolt ships built-in skills and workflow example templates as source files in `src/skills/` and `src/workflows/`. At runtime, `src/assets.ts` exports their paths anchored to `__dirname`:

```ts
// src/assets.ts
import { join } from 'path';
export const BUILTIN_AGENT_MD      = join(__dirname, 'AGENT.md');
export const BUILTIN_SKILLS_DIR    = join(__dirname, 'skills');
export const BUILTIN_WORKFLOWS_DIR = join(__dirname, 'workflows');
```

Because `package.json` uses `"type": "commonjs"`, `__dirname` resolves correctly in both phases:

| Phase | Entry point | `__dirname` in compiled `assets` | Resolved path |
|-------|-------------|----------------------------------|---------------|
| **Dev** (`npm run dev`) | `tsx src/cli/index.ts` | `<repo>/src` | `src/skills/`, `src/workflows/` |
| **Prod** (`npm start`) | `node dist/cli/index.js` | `<repo>/dist` | `dist/skills/`, `dist/workflows/` |

The build step (`npm run build` = `tsc && node scripts/copy-assets.js`) copies both directories so the prod paths exist. No environment flag or runtime check needed — the paths are always correct.

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

## PR Workflow

### 1. Submit a PR

```bash
# Create a feature branch (use the story-id from plan.md)
git checkout -b feat/s0-2-testing-infrastructure

# Work through the TDD cycle: red → green → refactor
# Commit tests and implementation together (pre-commit hook enforces co-location)
git add src/tools/bash.ts src/tools/bash.test.ts
git commit -m "feat(tools): add bash tool with stdout/stderr/exitCode"

# Push and open a PR against main
git push -u origin feat/s0-2-testing-infrastructure
gh pr create --title "S0-2: Testing infrastructure" --body "$(cat .github/pull_request_template.md)"
```

Rules:
- One branch per story; branch name must include the story ID
- All acceptance criteria from the user story must be checked before requesting review
- Complete the PR checklist in the description before marking the PR ready

### 2. Code Review

The reviewer must verify every item in the PR checklist before approving. Key things to look for:

| Area | What to check |
|------|---------------|
| **TDD** | Tests were committed before (or alongside) the implementation — check git history |
| **Coverage** | `npm run test:coverage` passes; per-module thresholds not regressed |
| **Types** | No `any`; `npm run typecheck` passes |
| **Lint** | `npm run lint` passes with no suppressions |
| **Design** | New code follows existing `Tool` / `Channel` / `Memory` interfaces |
| **Isolation** | No shared state between agent scopes |
| **Docs** | Design docs updated if interface or behavior changed |
| **Secrets** | No API keys, tokens, or PII in code, tests, or comments |

Leaving a review:
- **Approve** — all checklist items pass; PR is ready to merge
- **Request changes** — leave specific, actionable comments; do not approve until resolved
- **Comment** — for questions or non-blocking suggestions (does not block merge)

### 3. Merge into Main

Conditions before merging:
- [ ] At least one approving review
- [ ] CI is fully green (typecheck → lint → test:coverage → build)
- [ ] All reviewer comments resolved or explicitly marked won't-fix with justification
- [ ] Branch is up to date with `main` (rebase or merge before squashing)

How to merge:
```bash
# Squash-merge so main history stays one-commit-per-story
gh pr merge <PR-number> --squash --delete-branch
```

The squash commit message should be: `<type>(<scope>): <story-id> <short description>`

Examples:
```
feat(tools): S2-4 bash tool
fix(memory): S5-1 compaction threshold off-by-one
chore(ci): S0-7 CI pipeline
```

After merge, close the corresponding issue or mark the story complete in `docs/planning/plan.md`.

---

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
