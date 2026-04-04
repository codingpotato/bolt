# Workspace Safety

## Goal

bolt operates with significant authority over the host system — it can read and write files, run shell commands, and fetch URLs. This document defines the two mechanisms that keep that power from causing accidental damage: **workspace confinement** for file operations, and **dangerous-command confirmation** for the bash tool.

---

## Workspace Root

The _workspace root_ is the absolute working directory that defines the boundary within which bolt may freely read and write files. It is stored as `ToolContext.cwd` and enforced on every file operation.

### Resolution Order

The workspace root is resolved at startup in this order (highest precedence first):

1. `BOLT_WORKSPACE_ROOT` environment variable (absolute path)
2. `workspace.root` in `.bolt/config.json`
3. `process.cwd()` — the directory where bolt was invoked

### Validation

At startup, the resolved workspace root is validated:

- Must be an absolute path
- Must exist and be accessible (readable + writable)
- If validation fails, bolt exits with a descriptive error

### Use Cases

| Scenario            | Configuration                                                       |
| ------------------- | ------------------------------------------------------------------- |
| **Default**         | Run `bolt` from your project directory — workspace = cwd            |
| **Fixed workspace** | Set `BOLT_WORKSPACE_ROOT=/path/to/project` — run bolt from anywhere |
| **Docker**          | Mount volume at `/workspace`, set `BOLT_WORKSPACE_ROOT=/workspace`  |
| **Config file**     | Set `workspace.root` in `.bolt/config.json`                         |

### Data Directory

The `.bolt/` data directory is resolved relative to the workspace root by default. If `BOLT_DATA_DIR` is set to a relative path, it is joined with the workspace root. Absolute paths are used as-is.

```
# Relative: /workspace/.bolt
BOLT_WORKSPACE_ROOT=/workspace
BOLT_DATA_DIR=.bolt              # → /workspace/.bolt

# Absolute: /tmp/bolt-data
BOLT_WORKSPACE_ROOT=/workspace
BOLT_DATA_DIR=/tmp/bolt-data     # → /tmp/bolt-data
```

---

## File Operation Confinement

`file_read`, `file_write`, and `file_edit` all resolve paths relative to the workspace root. After resolution they perform a **containment check** before any filesystem I/O:

```
resolved path must start with <workspaceRoot>/
```

**Rejected examples**:

- `/etc/passwd` — absolute path outside workspace
- `../../secrets` — traversal that escapes the workspace
- `/home/user/workspace` — the workspace root itself (not a file within it)

**What is checked**:

- The `path.resolve(cwd, userPath)` result, which handles both relative and absolute inputs
- Symlinks are **not** resolved before the check — symlink targets outside the workspace are not followed (relying on OS-level POSIX permission enforcement for that layer)

**Error response**: A non-retryable `ToolError` with a clear message:

```
path "../../secrets" is outside the workspace (/home/user/project)
```

---

## Dangerous Bash Command Confirmation

The bash tool cannot be sandboxed at the shell level without OS-level isolation (containers, `landlock`, `seccomp`). Instead, bolt detects commands that are commonly destructive or irreversible and **requires explicit user confirmation** before running them.

### Dangerous Patterns

| Pattern                      | Reason                                |
| ---------------------------- | ------------------------------------- |
| `rm` with `-r` or `-R` flag  | Recursive directory deletion          |
| `sudo` / `su `               | Privilege escalation                  |
| `\| sh`, `\| bash`           | Pipe to shell (remote code execution) |
| `mkfs*`                      | Filesystem format                     |
| `dd` with `of=`              | Raw disk write                        |
| `> /dev/sd*`, `> /dev/nvme*` | Writing to block device               |
| `killall` / `pkill`          | Killing all matching processes        |
| `shred`                      | Secure file deletion                  |

Detection is performed on the raw command string before the subprocess is spawned. Pattern matching is intentionally broad — it is better to ask once too many than to run a destructive command silently.

### Confirmation Flow

1. bolt writes the command and a plain-English description of the risk to stdout.
2. A `[y/N]` prompt is shown. Default is **N** (deny).
3. The user types `y` (or `yes`) to allow, anything else to deny.
4. On denial: a non-retryable `ToolError` is returned to the model — the model can reformulate or skip.

**Non-interactive mode** (no TTY, sub-agents, tests): dangerous commands are **auto-denied** with a `ToolError`. No prompt is shown.

---

## `ToolContext.confirm`

```ts
confirm?: (message: string) => Promise<boolean>;
```

Optional callback added to `ToolContext`. When absent (sub-agents, tests that do not supply it) the bash tool treats the answer as `false` and rejects the command.

In CLI mode, `confirm` is implemented via the `CliChannel` readline interface — it calls `rl.question()` on the active interface so the answer is consumed before the next user turn, without interfering with the normal input loop.

---

## What Is NOT Sandboxed

| Capability   | Sandboxed?            | Notes                                                        |
| ------------ | --------------------- | ------------------------------------------------------------ |
| `file_read`  | ✅ workspace-confined |                                                              |
| `file_write` | ✅ workspace-confined |                                                              |
| `file_edit`  | ✅ workspace-confined |                                                              |
| `bash`       | ⚠️ confirmation only  | Full shell access; destructive patterns require confirmation |
| `web_fetch`  | ❌                    | Network access is unrestricted by design                     |

Users who need stronger bash isolation should run bolt inside a container or virtual machine.

---

## Content Project Directory

The content generation workflow writes all intermediate and final files to `projects/<project-id>/` within the workspace root. This directory is user-visible (not inside `.bolt/`) so bloggers can browse their content directly. It is not gitignored by default — users may choose to commit or ignore it.

See `docs/design/content-generation.md` for the full directory structure and manifest schema.
