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

**Expected:** A direct text response. No tool calls. Verify only one API round-trip occurs (no `.bolt/tool-audit.jsonl` entry).

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

*(Requires test case 4 to have been run first.)*

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

---

### 10. Audit log inspection

After running any tool-calling test case:

```bash
cat .bolt/tool-audit.jsonl
```

Each line should be valid JSON with `ts`, `tool`, `input`, and `result` fields. Credentials should never appear.

---

## Local inference server

To use a local Anthropic-compatible server instead of the real API:

```bash
export BOLT_LOCAL_ENDPOINT=http://localhost:8080
export BOLT_LOCAL_API_KEY=optional-key   # if your server requires one
npm run dev
```

The startup message will show `auth: local`.
