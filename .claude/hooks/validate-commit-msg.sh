#!/usr/bin/env bash
# Pre-tool hook: validate git commit message format
# Expected: <type>(<scope>): <description>
# Types: feat, fix, chore, docs, test, refactor

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only run on git commit commands
if [[ "$COMMAND" != *"git commit"* ]]; then
  exit 0
fi

# Skip --amend without -m (interactive reword) and --no-edit
if [[ "$COMMAND" == *"--amend"* && "$COMMAND" != *"-m "* ]]; then
  exit 0
fi

# Try to extract message from -m "..." or -m '...'
MSG=$(echo "$COMMAND" | grep -oP '(?<=-m ")[^"]+' | head -1)
if [[ -z "$MSG" ]]; then
  MSG=$(echo "$COMMAND" | grep -oP "(?<=-m ')[^']+" | head -1)
fi

# If message is in a heredoc or subshell $(...) we can't parse it — let it through
if [[ -z "$MSG" ]]; then
  exit 0
fi

# Validate format: <type>(<scope>): <description>
PATTERN='^(feat|fix|chore|docs|test|refactor)\([^)]+\): .+'
if ! echo "$MSG" | grep -qP "$PATTERN"; then
  echo "Blocked: commit message does not match required format." >&2
  echo "  Required: <type>(<scope>): <story-id> <description>" >&2
  echo "  Types:    feat, fix, chore, docs, test, refactor" >&2
  echo "  Example:  feat(tools): S2-4 bash tool" >&2
  echo "  Got:      $MSG" >&2
  exit 2
fi

exit 0
