# Memory System Design

## Goals

- Keep the active context window lean and relevant
- Never silently drop information — compact and persist before evicting
- Allow the agent to query past context when needed

## Levels

| Level | Storage | Scope | Eviction |
|-------|---------|-------|----------|
| Active context | In-process array | Current session | Compacted on overflow |
| Compact store | Persisted (file / SQLite) | Cross-session | Manual or TTL-based |

## Compaction Flow

```
Token usage > threshold
        │
        ▼
Identify oldest N messages to evict
        │
        ▼
Call model to summarize evicted messages
        │
        ▼
Write summary + raw messages to Compact Store
        │
        ▼
Replace evicted messages in active context
with a single summary stub message
```

## Compact Store Schema

```ts
interface CompactEntry {
  id: string;
  createdAt: string;       // ISO 8601
  summary: string;         // model-generated summary
  messages: Message[];     // raw evicted messages
  tags: string[];          // topics extracted for retrieval
}
```

## Retrieval

The agent issues a `memory_search` tool call with a query string. The search backend is selected by configuration:

| Backend | Config value | Description |
|---------|-------------|-------------|
| **Keyword** (default) | `"keyword"` | Full-text search over summary and tag fields using BM25-style ranking. No extra dependencies. |
| **Embedding** | `"embedding"` | Vector similarity search. Requires an embedding model call per query; results are more semantically relevant. Counts against the token budget. |

The keyword backend is used by default and requires no additional setup. Switch to embedding by setting `memory.searchBackend = "embedding"` in `.bolt/config.json`.

`memory_search` input/output:

```ts
interface MemorySearchInput {
  query: string;   // natural language query
  limit?: number;  // max results to return (default: 5)
}

interface MemorySearchResult {
  entries: Array<{
    id: string;
    summary: string;
    tags: string[];
    createdAt: string;
  }>;
}
```

## Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `memory.compactThreshold` | 0.8 | Fraction of context window that triggers compaction |
| `memory.keepRecentMessages` | 10 | Number of recent messages always retained in active context |
| `memory.storePath` | `.bolt/memory` | Directory for compact store files |
