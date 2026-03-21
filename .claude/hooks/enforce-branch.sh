#!/usr/bin/env bash
# Pre-tool hook: block git push to main branch

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [[ "$COMMAND" == *"git push"* ]]; then
  BRANCH=$(git -C "$(dirname "$0")/../.." rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [[ "$BRANCH" == "main" || "$BRANCH" == "master" ]]; then
    echo "Blocked: cannot push directly to $BRANCH. Create a feature branch and open a PR instead." >&2
    exit 2
  fi
fi

exit 0
