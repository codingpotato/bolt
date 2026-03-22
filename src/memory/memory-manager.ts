import type Anthropic from '@anthropic-ai/sdk';
import type { SessionStore, SessionEntry } from './session-store';
import type { MemoryStore } from './memory-store';
import type { Config } from '../config/config';
import type { Logger } from '../logger';
import type { ProgressReporter } from '../progress/progress';

export type MemoryConfig = Pick<
  Config['memory'],
  'taskHistoryMessages' | 'taskHistoryTokenBudget' | 'keepRecentMessages' | 'injectRecentChat'
>;

export interface AssembleOptions {
  /** The sessionId generated for the current run. */
  currentSessionId: string;
  /** Set when --session <id> was passed at startup. */
  resumedSessionId?: string;
  /** Set when a task is currently active. */
  activeTaskId?: string;
}

/**
 * Assembles the injected history block prepended before L1 active context.
 *
 * Priority order (first matching rule wins):
 * 1. Active task — last `taskHistoryMessages` L2 entries tagged with taskId,
 *    across all prior sessions. Capped at `taskHistoryTokenBudget` tokens.
 * 2. Session resume (`--session <id>`) — last `keepRecentMessages` entries
 *    from the resumed session.
 * 3. Chat continuity (`injectRecentChat` = true) — last `keepRecentMessages`
 *    entries from the most recent prior session.
 * 4. No injection.
 */
export class MemoryManager {
  constructor(
    private readonly sessionStore: SessionStore,
    private readonly memConfig: MemoryConfig,
    private readonly logger: Logger,
    private readonly memoryStore: MemoryStore | null = null,
    private readonly client: Anthropic | null = null,
    private readonly model: string | null = null,
  ) {}

  async assembleInjectedHistory(opts: AssembleOptions): Promise<Anthropic.MessageParam[]> {
    const { currentSessionId, resumedSessionId, activeTaskId } = opts;

    if (activeTaskId) {
      return this.loadTaskHistory(activeTaskId, currentSessionId);
    }

    if (resumedSessionId) {
      return this.loadResumedSessionHistory(resumedSessionId);
    }

    if (this.memConfig.injectRecentChat) {
      return this.loadRecentChatHistory(currentSessionId);
    }

    return [];
  }

  /**
   * Compacts the message history by evicting the oldest messages and replacing
   * them with a model-generated summary stub.
   *
   * Returns `null` when there are not enough messages to evict anything.
   * Otherwise returns the compacted message list.
   */
  async compact(
    messages: Anthropic.MessageParam[],
    sessionId: string,
    activeTaskId: string | undefined,
    progress: ProgressReporter,
  ): Promise<Anthropic.MessageParam[] | null> {
    const keep = this.memConfig.keepRecentMessages;
    if (messages.length <= keep) {
      return null;
    }

    const toEvict = messages.slice(0, messages.length - keep);
    const toKeep = messages.slice(-keep);

    let summary: string;
    let tags: string[] = [];

    if (this.client !== null && this.model !== null) {
      const evictedText = toEvict
        .map(
          (m) =>
            `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`,
        )
        .join('\n\n');

      try {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 1024,
          messages: [
            {
              role: 'user',
              content: `Please summarize the following conversation history concisely:\n\n${evictedText}\n\nAfter the summary, add a line "Tags: tag1, tag2, tag3" with 3-5 relevant topic tags.`,
            },
          ],
        });

        const textBlock = response.content.find(
          (block): block is Anthropic.TextBlock => block.type === 'text',
        );
        const fullText = textBlock?.text ?? '';

        // Parse tags from the last line
        const tagLineMatch = /\nTags:\s*(.+)$/m.exec(fullText);
        if (tagLineMatch) {
          tags = tagLineMatch[1]!.split(',').map((t) => t.trim()).filter(Boolean);
          summary = fullText.replace(/\nTags:\s*.+$/m, '').trim();
        } else {
          summary = fullText.trim();
        }
      } catch (err) {
        this.logger.warn('Failed to summarize evicted messages, using fallback', {
          error: String(err),
        });
        summary = '[Conversation history compacted — summary unavailable]';
        tags = [];
      }
    } else {
      summary = '[Earlier context has been compacted to stay within the context window.]';
      tags = [];
    }

    // Write CompactEntry to MemoryStore before eviction
    if (this.memoryStore !== null) {
      await this.memoryStore.write({
        type: 'compaction',
        sessionId,
        taskId: activeTaskId,
        summary,
        messages: toEvict,
        tags,
      });
    }

    progress.onMemoryCompaction(toEvict.length);

    return [
      { role: 'user', content: `[Earlier context compacted. Summary: ${summary}]` },
      ...toKeep,
    ];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async loadTaskHistory(
    taskId: string,
    currentSessionId: string,
  ): Promise<Anthropic.MessageParam[]> {
    const allSessionIds = await this.sessionStore.listSessionIds();
    const allEntries: SessionEntry[] = [];

    for (const sessionId of allSessionIds) {
      if (sessionId === currentSessionId) continue;
      try {
        const entries = await this.sessionStore.loadSession(sessionId);
        const taskEntries = entries.filter((e) => e.taskId === taskId);
        allEntries.push(...taskEntries);
      } catch (err) {
        this.logger.warn('Failed to load session for task history', {
          sessionId,
          error: String(err),
        });
      }
    }

    // Sort chronologically (entries may come from different sessions)
    allEntries.sort((a, b) => a.ts.localeCompare(b.ts));

    // Take the last taskHistoryMessages entries
    const limited = allEntries.slice(-this.memConfig.taskHistoryMessages);

    // Convert and apply token budget (drop oldest first)
    const params = entriesToMessageParams(limited);
    return applyTokenBudget(params, this.memConfig.taskHistoryTokenBudget);
  }

  private async loadResumedSessionHistory(
    resumedSessionId: string,
  ): Promise<Anthropic.MessageParam[]> {
    const entries = await this.sessionStore.loadSession(resumedSessionId);
    const recent = entries.slice(-this.memConfig.keepRecentMessages);
    return entriesToMessageParams(recent);
  }

  private async loadRecentChatHistory(
    currentSessionId: string,
  ): Promise<Anthropic.MessageParam[]> {
    const allSessionIds = await this.sessionStore.listSessionIds();

    // Find the prior session with the most recent last-entry timestamp.
    // Cache the entries so the winning session is not loaded twice.
    let mostRecentId: string | null = null;
    let mostRecentTs = '';
    let mostRecentEntries: SessionEntry[] = [];

    for (const sessionId of allSessionIds) {
      if (sessionId === currentSessionId) continue;
      try {
        const entries = await this.sessionStore.loadSession(sessionId);
        if (entries.length === 0) continue;
        const lastTs = entries[entries.length - 1]!.ts;
        if (lastTs > mostRecentTs) {
          mostRecentTs = lastTs;
          mostRecentId = sessionId;
          mostRecentEntries = entries;
        }
      } catch (err) {
        this.logger.warn('Failed to load session for chat continuity', {
          sessionId,
          error: String(err),
        });
      }
    }

    if (!mostRecentId) return [];

    const recent = mostRecentEntries.slice(-this.memConfig.keepRecentMessages);
    return entriesToMessageParams(recent);
  }
}

// ---------------------------------------------------------------------------
// Conversion utilities (exported for use in AgentCore token estimation)
// ---------------------------------------------------------------------------

/**
 * Convert SessionEntry objects to Anthropic MessageParam objects.
 *
 * - Skips `tool_call` and `tool_result` entries (they are redundant with the
 *   assistant and user turns that already carry the tool-use content).
 * - Ensures alternating user/assistant by replacing consecutive same-role
 *   entries with the newer one — this keeps the final text response when
 *   multiple assistant entries appear between user turns.
 */
export function entriesToMessageParams(entries: SessionEntry[]): Anthropic.MessageParam[] {
  const params: Anthropic.MessageParam[] = [];
  for (const entry of entries) {
    const param = entryToMessageParam(entry);
    if (param === null) continue;
    const last = params[params.length - 1];
    if (last && last.role === param.role) {
      // Replace with the more recent same-role entry
      params[params.length - 1] = param;
    } else {
      params.push(param);
    }
  }
  return params;
}

/** Rough token estimate: 1 token ≈ 4 characters of JSON. */
export function estimateTokens(param: Anthropic.MessageParam): number {
  return Math.ceil(JSON.stringify(param.content).length / 4);
}

function entryToMessageParam(entry: SessionEntry): Anthropic.MessageParam | null {
  if (entry.role === 'user') {
    return {
      role: 'user',
      content:
        typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
    };
  }
  if (entry.role === 'assistant') {
    return {
      role: 'assistant',
      content: extractAssistantText(entry.content),
    };
  }
  // tool_call and tool_result are skipped — they are embedded in the
  // surrounding user/assistant entries and not needed for context injection.
  return null;
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const b = block as Record<string, unknown>;
        if (b['type'] === 'text' && typeof b['text'] === 'string') {
          texts.push(b['text']);
        }
      }
    }
    return texts.join('\n') || '[Tool use response]';
  }
  return JSON.stringify(content);
}

/**
 * Drop oldest MessageParams until total estimated tokens fit within budget.
 * Always processes from newest to oldest, so the most recent context is kept.
 */
function applyTokenBudget(
  params: Anthropic.MessageParam[],
  budget: number,
): Anthropic.MessageParam[] {
  let total = 0;
  const result: Anthropic.MessageParam[] = [];
  for (let i = params.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(params[i]!);
    if (total + tokens > budget) break;
    total += tokens;
    result.unshift(params[i]!);
  }
  return result;
}
