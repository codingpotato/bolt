# Memory System Design

## Goals

- Persist every turn immediately — no data loss on crash or clean exit
- Give the agent automatic access to prior work on the current task
- Allow the agent to query and write cross-session knowledge explicitly
- Keep the active LLM context lean, relevant, and within the token budget

## Core Principle: Memory is Task-Scoped

bolt is a task-driven agent. Memory is organised around tasks, not arbitrary time windows or session replays. When the agent resumes work on a task, it automatically receives the relevant prior context for that task — not a dump of everything that has ever happened.

---

## Three Memory Levels

| Level | Name | Storage | Written | Eviction |
|-------|------|---------|---------|----------|
| L1 | Active context | In-process array | Always (current turn) | Compacted to L3 on overflow |
| L2 | Session store | `.bolt/sessions/<session-id>.jsonl` | Every turn, immediately | Never auto-deleted |
| L3 | Long-term memory | `.bolt/memory/<id>.json` | Compaction + `memory_write` tool | Manual or TTL-based |

---

## L1 — Active Context

The in-process message array passed to the Anthropic API on every call. Contains only the current session's messages.

- Compaction is triggered when token usage exceeds `memory.compactThreshold × context_window`
- The `memory.keepRecentMessages` most recent messages are always retained
- Evicted messages are summarised and written to L3 before removal
- A summary stub replaces the evicted block in L1

---

## L2 — Session Store

An append-only JSONL file written on **every turn** — before the next LLM call. This is the source of truth for raw conversation history. It survives crashes, clean exits, and process restarts.

### Session Identity

A `sessionId` (UUID v4) is generated at process startup. It is stamped on every L2 entry, every tool audit entry, and every L3 compact entry.

The user may pass `--session <id>` at startup to continue a previous session. When resuming, the prior session's L2 log is loaded and the active task's history is injected into L1 (see Context Assembly below).

### Schema

```ts
interface SessionEntry {
  sessionId: string;       // UUID of the current session
  seq: number;             // monotonically increasing turn counter
  ts: string;              // ISO 8601 timestamp
  taskId?: string;         // active task at the time of this entry (if any)
  date: string;            // YYYY-MM-DD derived from ts — used for date-range queries
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result';
  content: unknown;        // raw message content (Anthropic message format)
}
```

### File Layout

```
.bolt/
  sessions/
    <session-id>.jsonl      ← one file per session, entries appended per turn
```

### Date Queries

`date` is a denormalized index field derived from `ts`. Sessions can be listed or filtered by date without parsing timestamps. There is no day-level directory structure — date is just a field.

---

## L3 — Long-term Memory

Persisted JSON files written in two ways:

1. **Compaction** — when L1 overflows, evicted messages are summarised and written as a compact entry
2. **`memory_write` tool** — the agent explicitly writes a fact, preference, or note

### Compact Entry Schema

```ts
interface CompactEntry {
  id: string;              // UUID
  type: 'compaction' | 'agent_note';
  sessionId: string;       // session that produced this entry
  taskId?: string;         // task active at compaction time (if any)
  createdAt: string;       // ISO 8601
  date: string;            // YYYY-MM-DD
  summary: string;         // model-generated summary (compaction) or agent-written content
  messages?: Message[];    // raw evicted messages (compaction only)
  tags: string[];          // topics extracted for retrieval
}
```

### File Layout

```
.bolt/
  memory/
    <entry-id>.json         ← one file per compact entry
```

---

## Context Assembly

What gets sent to the LLM on each call — in order, top to bottom:

```
┌─────────────────────────────────────────────────────┐
│ System prompt                                       │  always
├─────────────────────────────────────────────────────┤
│ Task history (from L2, task-scoped)                 │  only if active task has prior sessions
│   last memory.taskHistoryMessages entries           │
│   tagged with the current taskId                    │
├─────────────────────────────────────────────────────┤
│ L1 active context                                   │  always; compacted on overflow
└─────────────────────────────────────────────────────┘
```

### Rules

Context injection follows a priority order — only the first matching rule applies:

| Priority | Condition | What is injected |
|----------|-----------|-----------------|
| 1 | Active task | Last `memory.taskHistoryMessages` L2 entries tagged with the current `taskId`, across all prior sessions for that task. Capped at `memory.taskHistoryTokenBudget` tokens. |
| 2 | `--session <id>` resume, no active task | Last `memory.keepRecentMessages` entries from the specified session. |
| 3 | No active task, no `--session` flag, `memory.injectRecentChat` is true | Last `memory.keepRecentMessages` entries from the most recent prior session. Provides natural chat continuity without the user needing to track session IDs. |
| 4 | First ever session, or `memory.injectRecentChat` is false | No injection. |

Additional rules:
- **L1 is always fully included** after any injected history
- **L3 is never auto-injected** — the agent queries L3 explicitly via `memory_search`. This avoids noisy retrieval and keeps the context predictable.
- **Token budget** — task history injection (priority 1) is bounded by `memory.taskHistoryTokenBudget`; oldest entries are dropped first if over budget.
- **Compaction threshold uses L1 token count only** — injected history tokens are excluded from the compaction threshold check. The threshold is evaluated against `response.usage.output_tokens` (i.e. L1 growth) rather than total `input_tokens`. This prevents a task with large injected history from triggering a compaction loop even when L1 itself is small.

---

## Compaction Flow

```
L1 token usage > threshold
        │
        ▼
Identify oldest messages to evict
(retain keepRecentMessages most recent)
        │
        ▼
Call model to summarize evicted messages
        │
        ▼
Write CompactEntry (type: 'compaction') to L3
with sessionId, taskId, summary, raw messages, tags
        │
        ▼
Replace evicted messages in L1 with a summary stub
```

---

## Tools

### `memory_search`

Query L3 for relevant past context.

```ts
interface MemorySearchInput {
  query: string;        // natural language query
  limit?: number;       // max results (default: 5)
  taskId?: string;      // filter to a specific task
  dateFrom?: string;    // YYYY-MM-DD
  dateTo?: string;      // YYYY-MM-DD
}

interface MemorySearchResult {
  entries: Array<{
    id: string;
    type: 'compaction' | 'agent_note';
    summary: string;
    tags: string[];
    taskId?: string;
    createdAt: string;
  }>;
}
```

Search backend is selected by configuration:

| Backend | Config value | Description |
|---------|-------------|-------------|
| **Keyword** (default) | `"keyword"` | BM25-style full-text search over summary and tags. No extra dependencies. |
| **Embedding** | `"embedding"` | Vector similarity search. Requires an embedding model call per query. More semantically relevant. Counts against token budget. |

### `memory_write`

Explicitly write a fact or note to L3. Use this to persist learned preferences, important decisions, or cross-task knowledge.

```ts
interface MemoryWriteInput {
  content: string;      // the fact or note to persist
  tags?: string[];      // optional topic tags for retrieval
}

interface MemoryWriteResult {
  id: string;           // the ID of the created CompactEntry
}
```

---

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `memory.compactThreshold` | `0.8` | Fraction of context window that triggers compaction |
| `memory.keepRecentMessages` | `10` | Number of recent messages always retained in L1 during compaction |
| `memory.taskHistoryMessages` | `20` | Max number of prior task messages to inject from L2 |
| `memory.taskHistoryTokenBudget` | `20000` | Max tokens to spend on injected task history |
| `memory.injectRecentChat` | `true` | When true, inject the last N messages from the most recent prior session when no task is active and no `--session` flag is given |
| `memory.storePath` | `.bolt/memory` | Directory for L3 compact entry files |
| `memory.sessionPath` | `.bolt/sessions` | Directory for L2 session log files |
| `memory.searchBackend` | `"keyword"` | Search backend for `memory_search`: `"keyword"` or `"embedding"` |
