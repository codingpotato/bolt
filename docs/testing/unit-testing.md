# Unit Testing Guide

## Philosophy

bolt follows **Test-Driven Development (TDD)**. Tests are written *before* the implementation. The cycle is:

```
1. Red   — write a failing test that describes the desired behavior
2. Green — write the minimum code to make the test pass
3. Refactor — clean up without breaking the test
```

Additional principles:
- Test behavior, not implementation details
- Each tool module must be independently testable without a live Anthropic API call
- Mock external I/O (filesystem, network, Discord, Anthropic SDK) at the boundary
- Aim for fast, deterministic tests — no sleeps, no real HTTP

## Stack

| Concern | Library |
|---------|---------|
| Test runner | [Vitest](https://vitest.dev) |
| Mocking | `vi.mock` / `vi.spyOn` |
| Assertions | Vitest built-in (`expect`) |
| Type checking | `tsc --noEmit` (run in CI) |

## Directory Layout

```
src/
  tools/
    bash.ts
    bash.test.ts        ← co-located unit test
  memory/
    manager.ts
    manager.test.ts
  tasks/
    runner.ts
    runner.test.ts
  agent/
    core.ts
    core.test.ts
```

## Writing a Test

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeBash } from './bash';

vi.mock('node:child_process');

describe('executeBash', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns stdout on success', async () => {
    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockReturnValue(Buffer.from('hello\n'));
    const result = await executeBash({ command: 'echo hello' });
    expect(result.output).toBe('hello\n');
  });

  it('returns error message on failure', async () => {
    const { execSync } = await import('node:child_process');
    vi.mocked(execSync).mockImplementation(() => { throw new Error('command not found'); });
    const result = await executeBash({ command: 'bad-cmd' });
    expect(result.error).toMatch('command not found');
  });
});
```

## Running Tests

```bash
# All tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# Type check only
npm run typecheck
```

## Coverage Requirements

Coverage thresholds are enforced in CI — the build **fails** if any threshold is not met.

| Module | Minimum Coverage |
|--------|-----------------|
| Tool modules | 90% |
| Memory manager | 85% |
| Task runner | 85% |
| Agent core | 70% |

Vitest coverage config (`vitest.config.ts`):

```ts
coverage: {
  thresholds: {
    'src/tools/**': { lines: 90, functions: 90 },
    'src/memory/**': { lines: 85, functions: 85 },
    'src/tasks/**': { lines: 85, functions: 85 },
    'src/agent/**': { lines: 70, functions: 70 },
  }
}
```

## What NOT to Unit Test

- The Anthropic API response format — test your parsing of it, not the API itself
- Channel connectivity (CLI stdin, Discord gateway, WebSocket) — covered by integration tests
- End-to-end task execution — covered by e2e tests

## TDD Workflow for a New Feature

```
1. Read the acceptance criteria from the user story
2. Write a failing test for each criterion
3. Run npm test — confirm all new tests are RED
4. Implement the minimum code to turn them GREEN
5. Refactor — clean up duplication, improve names
6. Run npm test again — all tests must stay GREEN
7. Open PR — tests must have been committed before the implementation
```

PRs that add implementation without co-located tests will be rejected at review.

## TDD Enforcement Mechanisms

TDD is enforced at three layers — documentation alone is not sufficient:

| Layer | Mechanism | Effect |
|-------|-----------|--------|
| **Local** | `scripts/pre-commit` git hook | Blocks `git commit` if a new `.ts` file has no co-located `.test.ts` |
| **CI** | `vitest.config.ts` coverage thresholds | Fails `npm run test:coverage` if per-module thresholds are not met |
| **Review** | `.github/pull_request_template.md` | PR checklist requires reviewer to confirm tests were written first |

Install the pre-commit hook after cloning:

```bash
cp scripts/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
```
