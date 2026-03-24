# Manual Testing Guide

This guide covers how to run bolt locally and exercise its current capabilities end-to-end.

## Prerequisites

- Node.js ≥ 20
- An Anthropic API key **or** a local Anthropic-compatible server

## Setup

```bash
# Install dependencies (if not already done)
npm install

# Set your API key
export ANTHROPIC_API_KEY=sk-ant-...
```

Optional overrides:

```bash
export BOLT_MODEL=claude-opus-4-6      # default
export BOLT_DATA_DIR=.bolt             # where audit log and config live
export BOLT_LOG_LEVEL=info             # debug | info | warn | error
```

## Running bolt

```bash
# Start the interactive CLI (no build step required)
npm run dev
```

You should see:

```
bolt ready (model: claude-opus-4-6, auth: api-key)
Type a message and press Enter. Ctrl+D to exit.
```

Type any message and press **Enter**. bolt sends it to Claude, which may call tools before responding. Press **Ctrl+D** to exit cleanly.

The audit log is written to `.bolt/tool-audit.jsonl` after each tool call.

---

## Test Cases

### 1. Plain conversation (no tools)

**Input:**
```
What is the capital of France?
```

**Expected:** A direct text response. No tool calls. `.bolt/tool-audit.jsonl` should either not exist yet or contain no new entries after the response — the audit log is only written on tool calls.

---

### 2. `bash` tool — run a shell command

**Input:**
```
What files are in the current directory? Use the bash tool to list them.
```

**Expected:** Claude calls `bash({ command: "ls" })` (or similar), receives the output, and summarises the files.
**Verify:** `.bolt/tool-audit.jsonl` contains a `bash` entry with `stdout` in the result.

---

### 3. `bash` tool — non-zero exit code

**Input:**
```
Run the command "cat non_existent_file.txt" using bash and tell me what happened.
```

**Expected:** Claude calls `bash`, gets `exitCode: 1` and stderr, then explains the error. The agent loop should NOT crash — the tool returns the exit code rather than throwing.

---

### 4. `file_write` then `file_read`

**Input:**
```
Write a file called hello.txt containing the text "Hello, bolt!" then read it back and confirm the contents.
```

**Expected:** Two tool calls — `file_write` then `file_read`. Claude confirms the content matches.
**Verify:** `hello.txt` exists in the working directory with the correct content.

---

### 5. `file_edit` — string replacement

**Input:**
```
Edit the file hello.txt and replace "Hello, bolt!" with "Hello, world!"
```

*(Requires test case 4 to have been run first. If you ran test case 4 in a previous session, `hello.txt` may already contain `Hello, world!` from a prior edit — in that case re-run test case 4 first to reset the file.)*

**Expected:** Claude calls `file_edit` with the old and new strings. It reports `changed: true`.
**Verify:** `hello.txt` now contains `Hello, world!`.

---

### 6. `file_read` — missing file error

**Input:**
```
Read the file does_not_exist.txt and tell me what you find.
```

**Expected:** Claude calls `file_read`, gets a `ToolError("file not found: ...")` back as `is_error: true`, and reports the error gracefully. The agent loop should continue — no crash.

---

### 7. `web_fetch` tool

**Input:**
```
Fetch https://httpbin.org/get and summarise the response.
```

**Expected:** Claude calls `web_fetch`, receives JSON, and summarises the headers/origin field.
**Verify:** `.bolt/tool-audit.jsonl` contains a `web_fetch` entry with `statusCode: 200`.

---

### 8. Multi-tool turn — bash + file_write

**Input:**
```
Find out today's date using bash, then write it to a file called date.txt.
```

**Expected:** Claude calls `bash({ command: "date" })` then `file_write`. Two audit log entries.
**Verify:** `date.txt` contains today's date.

---

### 9. Multi-round tool loop

**Input:**
```
Write a short Python script to print numbers 1-5 to a file called numbers.py, then run it with bash and show me the output.
```

**Expected:** Multiple rounds — `file_write`, then `bash({ command: "python3 numbers.py" })`, then a text summary. Verify the agent loops correctly through both rounds before responding.

> **Note:** Requires `python3` in PATH. If unavailable, substitute with a Node.js equivalent: *"Write a script called numbers.js that prints 1-5, then run it with `node numbers.js`."*

---

### 10. Audit log inspection

After running any tool-calling test case:

```bash
cat .bolt/tool-audit.jsonl
```

Each line should be valid JSON with `ts`, `tool`, `input`, and `result` fields. Credentials should never appear.

---

---

> **Note:** Todos are held in-memory and do not survive process restarts. Run all todo test cases (11–15) within the same bolt session.

### 11. `todo_create` — create a todo item

**Input:**
```
Create a todo item titled "Buy groceries" with description "milk, eggs, bread".
```

**Expected:** Claude calls `todo_create`, receives the new item's ID, and confirms the todo was created.

---

### 12. `todo_list` — list all todos

**Input:**
```
Show me all my current todo items.
```

*(Run after test case 11 so at least one item exists.)*

**Expected:** Claude calls `todo_list` and returns the list including the "Buy groceries" item with `status: pending`.

---

### 13. `todo_update` — change status and description

**Input:**
```
Mark the "Buy groceries" todo as in_progress.
```

**Expected:** Claude calls `todo_update` with the correct ID and `status: "in_progress"`. It confirms the update.

---

### 14. `todo_delete` — remove a todo

**Input:**
```
Delete the "Buy groceries" todo item.
```

**Expected:** Claude calls `todo_delete` with the correct ID. A subsequent `todo_list` call should no longer include it.

---

### 15. Todo error — update non-existent item

**Input:**
```
Update the status of todo ID "todo-9999" to done.
```

**Expected:** Claude calls `todo_update`, receives a `ToolError("todo not found: todo-9999")` as `is_error: true`, and reports the error gracefully without crashing.

---

### 16. `task_create` — create a task

**Input:**
```
Create a task titled "Write blog post" with description "Draft an intro paragraph about TypeScript".
```

**Expected:** Claude calls `task_create`, receives the new task ID (e.g. `task-1`), and confirms creation. The task should have `status: pending`.
**Verify:** `.bolt/tasks.json` is created in the data directory and contains the task.

---

### 17. `task_list` — list all tasks

**Input:**
```
List all my tasks and their current statuses.
```

*(Run after test case 16 so at least one task exists.)*

**Expected:** Claude calls `task_list` and returns all tasks including "Write blog post" with `status: pending`.

---

### 18. `task_update` — update task status

**Input:**
```
Mark the "Write blog post" task as in_progress.
```

**Expected:** Claude calls `task_update` with the correct task ID and `status: "in_progress"`. It confirms the update.
**Verify:** `.bolt/tasks.json` is updated with the new status.

---

### 19. `task_update` — mark task completed with result

**Input:**
```
Mark the "Write blog post" task as completed with the result "Intro paragraph done — 150 words".
```

**Expected:** Claude calls `task_update` with `status: "completed"` and `result` set. It confirms.
**Verify:** `.bolt/tasks.json` reflects `status: "completed"` and the result string.

---

### 20. Task persistence across restarts

**Prerequisites:** Create a task (test case 16), then exit bolt with Ctrl+D.

**Steps:**
1. Restart bolt with `npm run dev`
2. Ask: *"List all my tasks."*

**Expected:** Claude calls `task_list` and the previously created task is still present with the same ID and status — it was loaded from `.bolt/tasks.json` on startup.

---

### 21. Task error — update non-existent task

**Input:**
```
Update task ID "task-9999" to completed.
```

**Expected:** Claude calls `task_update`, receives a `ToolError("task not found: task-9999")` as `is_error: true`, and reports the error gracefully without crashing.

---

### 22. Structured log output

After running any test case:

```bash
cat .bolt/bolt.log
```

Each line should be valid JSON with `ts`, `level`, `msg`, and optional `context` fields. The startup entry should include `model` and `auth` fields. LLM requests and responses appear as `debug`-level entries when `BOLT_LOG_LEVEL=debug` is set.

---

---

## bolt serve — WebChannel daemon mode

These test cases cover `bolt serve` end-to-end. Run them after `npm run build` (or replace `node dist/cli/index.js` with `npx ts-node src/cli/index.ts` for dev mode).

**Setup for all serve test cases:**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export BOLT_WEB_TOKEN=test-token
```

---

### 23. Start the server and verify it listens

```bash
node dist/cli/index.js serve --port 3001
```

**Expected:**

```
bolt serve: listening on http://localhost:3001 (model: claude-opus-4-6)
```

Process stays running (does not exit). `.bolt/bolt.log` contains a `bolt serve started` entry with `port: 3001`.

---

### 24. Connect from a browser

Open `http://localhost:3001?token=test-token` in a browser.

**Expected:**
- The chat UI loads.
- The input box is **enabled** (not read-only).
- No console errors.

---

### 25. Send a message via WebChannel

With the browser connected (test case 24 running), type a message:

```
What is 2 + 2?
```

**Expected:**
- A thinking indicator appears while the agent responds.
- The agent replies "4" (or a short explanation). No tool calls.
- The server process remains running after the reply.

---

### 26. Session preserved after client reconnects

1. Send a message: *"Remember the number 42."*
2. Close the browser tab (disconnect).
3. Reopen `http://localhost:3001?token=test-token`.
4. Send: *"What number did I ask you to remember?"*

**Expected:** The agent recalls 42 — conversation history is preserved in the running process across disconnects.

---

### 27. Read-only observer

1. Open the UI in **Tab A** — it becomes the active connection.
2. Open the same URL in **Tab B**.

**Expected:**
- Tab B shows the banner: *"Observing — another session is active"* and the input is disabled.
- Send a message from Tab A. Tab B receives the response.
- Close Tab A. Tab B's banner disappears and input becomes enabled (promoted to active).

---

### 28. Graceful shutdown — Ctrl+C

With the server running and a browser connected:

1. Press `Ctrl+C` in the terminal.

**Expected:**
- Terminal prints: `bolt serve: shutting down gracefully...`
- Process exits with code 0.
- Browser shows the disconnected/reconnecting state.
- `.bolt/bolt.log` does **not** contain any unhandled error entries.

---

### 29. Graceful shutdown — SIGTERM

```bash
# Start server in background
node dist/cli/index.js serve --port 3001 &
SERVER_PID=$!

# Wait for it to start, then send SIGTERM
sleep 2
kill -TERM $SERVER_PID
wait $SERVER_PID
echo "Exit code: $?"
```

**Expected:** Exit code is 0. Terminal shows the shutdown message.

---

### 30. Invalid --port argument

```bash
node dist/cli/index.js serve --port abc
```

**Expected:**

```
bolt serve: --port must be a number
```

Process exits immediately with a non-zero exit code. No server is started.

---

### 31. Missing auth token — connection rejected

```bash
# Start server with a token
node dist/cli/index.js serve --port 3001 --token secret

# In another terminal, attempt to connect without a token:
curl -i http://localhost:3001/chat -X POST \
  -H "Content-Type: application/json" \
  -d '{"type":"message","content":"hello"}'
```

**Expected:** HTTP `401 Unauthorized`. No agent turn is enqueued.

---

### 32. --port override takes precedence over config

With `.bolt/config.json` containing `"channels": { "web": { "port": 4000 } }`:

```bash
node dist/cli/index.js serve --port 3001
```

**Expected:** Server listens on port **3001**, not 4000. The startup message shows port 3001.

---

### 33. Media file served inline in review card

*(Requires a test image in the workspace.)*

1. Place a file `test.png` in the current working directory.
2. Trigger a `user_review` tool call with `mediaFiles: ["test.png"]` (e.g. ask the agent: *"Review my image test.png and ask me to approve it."*).

**Expected:**
- The review card appears in the browser with the image displayed inline above the content.
- Approve button sends approval; the agent continues.

---

### 34. Markdown rendered in review card

Trigger a review with markdown content, e.g.:

```
Ask me to review a short blog post draft that includes headers and bullet points.
```

**Expected:** The review card shows formatted HTML — headers, bullet points, code spans — not raw markdown syntax.

---

### 35. Server survives multiple conversation rounds

1. Start the server.
2. Send five separate messages in sequence, including at least one that triggers a tool call (e.g. *"List files in the current directory."*).

**Expected:** All five messages receive responses. The server does not crash or stall between rounds. `.bolt/tool-audit.jsonl` contains entries for any tool calls.

---

## Local inference server

To use a local Anthropic-compatible server instead of the real API:

```bash
export BOLT_LOCAL_ENDPOINT=http://localhost:8080
export BOLT_LOCAL_API_KEY=optional-key   # if your server requires one
npm run dev
```

The startup message will show `auth: local`.
