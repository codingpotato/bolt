import type { Tool, ToolContext } from './tool';
import type { MemoryStore, CompactEntry } from '../memory/memory-store';

export interface MemorySearchInput {
  query: string;
  limit?: number;
  taskId?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface MemorySearchEntry {
  id: string;
  type: 'compaction' | 'agent_note';
  summary: string;
  tags: string[];
  taskId?: string;
  createdAt: string;
}

export interface MemorySearchResult {
  entries: MemorySearchEntry[];
}

/** Tokenize text into lowercase words, stripping non-alphanumeric characters. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 0);
}

/**
 * BM25 relevance scoring over a corpus of CompactEntry objects.
 *
 * Each document is the concatenation of the entry's summary tokens and tag tokens.
 * Returns entries with score > 0, sorted descending by score, up to limit.
 */
function bm25Search(
  entries: CompactEntry[],
  query: string,
  limit: number,
): CompactEntry[] {
  if (entries.length === 0 || query.trim() === '') return [];

  const K1 = 1.5;
  const B = 0.75;

  // Build per-document token lists.
  const docTokens: string[][] = entries.map((e) => [
    ...tokenize(e.summary),
    ...e.tags.flatMap((tag) => tokenize(tag)),
  ]);

  const N = entries.length;
  const avgDl = docTokens.reduce((s, t) => s + t.length, 0) / N;

  // Document frequency per term.
  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    for (const term of new Set(tokens)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const queryTerms = tokenize(query);

  const scored = entries.map((entry, i) => {
    const tokens = docTokens[i] ?? [];
    const dl = tokens.length;

    // Term frequency map for this document.
    const tf = new Map<string, number>();
    for (const t of (tokens ?? [])) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    let score = 0;
    for (const term of queryTerms) {
      const termDf = df.get(term) ?? 0;
      if (termDf === 0) continue;

      const idf = Math.log((N - termDf + 0.5) / (termDf + 0.5) + 1);
      const termTf = tf.get(term) ?? 0;
      const numerator = termTf * (K1 + 1);
      const denominator = termTf + K1 * (1 - B + B * (dl / avgDl));
      score += idf * (numerator / denominator);
    }

    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
}

function toSearchEntry(e: CompactEntry): MemorySearchEntry {
  const result: MemorySearchEntry = {
    id: e.id,
    type: e.type,
    summary: e.summary,
    tags: e.tags,
    createdAt: e.createdAt,
  };
  if (e.taskId !== undefined) {
    result.taskId = e.taskId;
  }
  return result;
}

export function createMemorySearchTool(store: MemoryStore): Tool<MemorySearchInput, MemorySearchResult> {
  return {
    name: 'memory_search',
    description:
      'Search long-term memory (L3) for relevant past context, compacted summaries, and agent notes. ' +
      'Returns entries ranked by relevance to the query. Use this to recall facts from prior sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language search query.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 5).',
        },
        taskId: {
          type: 'string',
          description: 'Restrict results to entries from a specific task.',
        },
        dateFrom: {
          type: 'string',
          description: 'Filter to entries on or after this date (YYYY-MM-DD).',
        },
        dateTo: {
          type: 'string',
          description: 'Filter to entries on or before this date (YYYY-MM-DD).',
        },
      },
      required: ['query'],
    },

    async execute(input: MemorySearchInput, _ctx: ToolContext): Promise<MemorySearchResult> {
      const limit = input.limit ?? 5;
      let candidates = store.getAll();

      if (input.taskId !== undefined) {
        const tid = input.taskId;
        candidates = candidates.filter((e) => e.taskId === tid);
      }

      if (input.dateFrom !== undefined) {
        const from = input.dateFrom;
        candidates = candidates.filter((e) => e.date >= from);
      }

      if (input.dateTo !== undefined) {
        const to = input.dateTo;
        candidates = candidates.filter((e) => e.date <= to);
      }

      const matched = bm25Search(candidates, input.query, limit);
      return { entries: matched.map(toSearchEntry) };
    },
  };
}
