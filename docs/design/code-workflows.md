# Code Workflows Design

## Goals

- Allow bolt to autonomously write, test, and review code
- Integrate with the tool system so code workflows are composable with other agent tasks
- Produce verifiable output — tests must pass before a workflow is considered complete

## Workflows

### Write Code

The agent receives a description of the desired functionality and:
1. Reads relevant existing files with `file_read`
2. Writes or edits files using `file_write` / `file_edit`
3. Runs the project's test suite with `bash` to verify the output

### Write Tests

The agent receives a file or function to test and:
1. Reads the target source file
2. Infers the test framework from `package.json` or config files
3. Writes a co-located test file following the project's conventions
4. Runs the tests to confirm they pass

### Run Tests

```bash
bash: { command: "npm test" }
```

The agent interprets stdout/stderr to determine pass/fail. On failure, it reads the error, identifies the cause, and attempts a fix up to a configurable retry limit.

### Code Review

The agent receives a diff or file path and produces a structured review:

```ts
interface CodeReviewResult {
  summary: string;
  issues: Array<{
    severity: 'error' | 'warning' | 'suggestion';
    file: string;
    line?: number;
    message: string;
  }>;
  approved: boolean;
}
```

## Built-in Skills

Code workflow capabilities are exposed as built-in skills:

| Skill | Description |
|-------|-------------|
| `review-code` | Perform a code review on a diff or file; returns a structured `CodeReviewResult` |

Additional skills (`write-feature`, `fix-bug`, `add-tests`) can be added as `.skill.md` files.

## Tool Usage

Code workflows use the standard built-in tools — no special tools are required:

| Tool | Usage |
|------|-------|
| `file_read` | Read source files and test files |
| `file_write` | Create new source or test files |
| `file_edit` | Apply targeted edits to existing files |
| `bash` | Run build commands, test suites, linters |
