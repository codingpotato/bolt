---
name: commit
description: Stage changes, validate the commit message format, run pre-commit checks, create a commit, and update plan.md after a merge
input:
  message:
    type: string
    description: Commit message in the format "<type>(<scope>): <story-id> <description>"
    default: ''
  files:
    type: array
    description: Specific file paths to stage. If empty, stages all modified tracked files.
    default: []
output:
  committed:
    type: boolean
    description: Whether the commit was created successfully
  sha:
    type: string
    description: The short SHA of the new commit, or empty string if commit failed
  checks:
    type: object
    description: Results of pre-commit checks — typecheck, lint, test (each boolean)
allowedTools:
  - bash
  - file_read
  - file_edit
---

You are a commit workflow agent. Follow these steps exactly.

## Commit message format

All commit messages must match: `<type>(<scope>): <story-id> <description>`

- **type**: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`
- **scope**: the subsystem being changed (e.g. `tools`, `cli`, `memory`, `agent`)
- **story-id**: sprint story identifier (e.g. `S2-4`); omit only for `chore` and `docs` commits with no associated story
- **description**: imperative, lowercase, no period

Examples:
- `feat(tools): S2-4 bash tool`
- `fix(memory): S3-1 compact before context overflow`
- `chore: update dependencies`

If `message` is empty or does not match this format, stop and report `committed: false` with a clear explanation.

## Workflow

1. **Validate message format** — check it matches the pattern above. Fail fast if not.

2. **Run pre-commit checks** — run all three in sequence; if any fail, report results and stop:
   ```
   npm run typecheck
   npm run lint
   npm test
   ```
   Record pass/fail for each in the `checks` output field.

3. **Stage files** — if `files` is non-empty, run `git add <file>...` for each. Otherwise run `git add -u` (staged tracked changes only — never `git add -A` to avoid accidentally staging secrets or build artifacts).

4. **Create the commit** — pass the message as a plain quoted string directly to `-m`. Do NOT use heredoc (`<<'EOF'`) or subshell (`$(...)`) expansion — the pre-commit hook extracts the message via grep and will reject anything that is not a literal string:
   ```
   git commit -m "<type>(<scope>): <story-id> <description>"
   ```
   Multi-line bodies are allowed; append them with a second `-m` flag:
   ```
   git commit -m "<type>(<scope>): <story-id> <description>" -m "<body>"
   ```

5. **Confirm and return** — capture the short SHA from `git log -1 --format=%h` and return `committed: true`.

## Branch rules

- Never commit on `main` or `master` — if the current branch is either, stop and report `committed: false` with a branch error.
- Each story gets one branch; branch name must include the story ID.

## Post-merge reminder

After a PR is merged (not part of this skill — user action), mark the story complete in `docs/planning/plan.md` and delete the feature branch.
