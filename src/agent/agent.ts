import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { Channel } from '../channels';
import type { ToolBus } from '../tools/tool-bus';
import type { ToolContext } from '../tools/tool';
import type { Config } from '../config/config';
import type { Logger } from '../logger';
import { createNoopLogger } from '../logger';
import { DEFAULT_SYSTEM_PROMPT } from '../agent-prompt/agent-prompt';
import type { SessionStore } from '../memory/session-store';
import type { MemoryManager } from '../memory/memory-manager';
import { estimateTokens } from '../memory/memory-manager';
import {
  createSlashCommandRegistry,
  type SlashCommandRegistry,
} from '../slash-commands/slash-commands';

/** Maximum tokens to request per API call. */
const MAX_TOKENS = 8096;

/** Maximum number of retry attempts for transient API failures. */
const MAX_RETRIES = 3;

/** Initial backoff duration in ms; doubles on each subsequent attempt. */
const INITIAL_BACKOFF_MS = 1000;

/**
 * Context window size for the supported Claude model family.
 * All Claude 3+ models (including claude-opus-4-6) have a 200k token context window.
 */
const MODEL_CONTEXT_WINDOW = 200_000;


/** Returns true if the error is transient and the call should be retried. */
function isRetryableError(err: unknown): boolean {
  if (err instanceof APIConnectionError) return true;
  if (err instanceof APIError && err.status !== undefined && err.status >= 500) return true;
  return false;
}

/** Returns true if the error is a context-size exceeded error (400). */
function isExceedContextSizeError(err: unknown): boolean {
  if (!(err instanceof APIError) || err.status !== 400) return false;
  const msg = getErrorMessage(err);
  return msg.includes('exceed_context_size_error') || msg.includes('exceeds the available context size');
}

/** Extracts a human-readable message from an unknown error value. */
function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * AgentCore drives the main agentic loop.
 *
 * For each user turn received from the channel:
 *   1. Call the Anthropic API with the current message history and tools.
 *   2. If the model returns tool calls, dispatch them via the ToolBus,
 *      append the results, and call the API again.
 *   3. When the model returns a final text response, deliver it via
 *      channel.send() and wait for the next user turn.
 *
 * Transient API failures (network errors, 5xx) are retried up to MAX_RETRIES
 * times with exponential backoff. Non-retryable failures (4xx) and exhausted
 * retries are surfaced to the user via channel.send().
 *
 * When token usage exceeds memory.compactThreshold, older messages are
 * compacted before the next API call to stay within the context window.
 *
 * When a SessionStore is provided, every user turn, assistant response, tool
 * call, and tool result is persisted immediately to the L2 session log before
 * the next LLM call.
 *
 * L1 (active context) is maintained as instance state across turns so that
 * the full current-session conversation is always available to the model.
 * It is initialised once at session start with any injected history (task
 * history, session resume, or chat continuity) and grows as turns proceed.
 */
export class AgentCore {
  /**
   * L1 active context — the message array passed to the Anthropic API.
   * Persistent across turns within a session; reset on construction.
   */
  private l1: Anthropic.MessageParam[] = [];

  /**
   * Estimated token cost of the messages injected at session start.
   * Subtracted from input_tokens when evaluating the compaction threshold
   * so that large injected history does not trigger premature compaction.
   * Reset to 0 after compaction (injected messages have been evicted).
   */
  private injectedTokenEstimate = 0;

  constructor(
    private readonly client: Anthropic,
    private readonly channel: Channel,
    private readonly toolBus: ToolBus,
    private readonly ctx: ToolContext,
    private readonly config: Config,
    private readonly systemPrompt: string = DEFAULT_SYSTEM_PROMPT,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    private readonly logger: Logger = createNoopLogger(),
    private readonly sessionStore: SessionStore | null = null,
    private readonly initialSessionId?: string,
    private readonly memoryManager: MemoryManager | null = null,
    private readonly slashRegistry: SlashCommandRegistry = createSlashCommandRegistry(),
  ) {}

  /** Run the agent loop until the channel closes or /exit is received. */
  async run(): Promise<void> {
    const sessionId = this.initialSessionId ?? randomUUID();
    // Stamp the sessionId into the shared ToolContext so tools (e.g. task_update)
    // can record which session is doing the work.
    this.ctx.sessionId = sessionId;
    this.ctx.progress.onSessionStart(sessionId, this.initialSessionId !== undefined);

    // Initialise L1 with injected history ONCE at session start.
    // This covers task history, session resume, and chat continuity.
    // Subsequent turns append to this.l1 rather than rebuilding from scratch,
    // ensuring the model sees the full current-session conversation each turn.
    if (this.memoryManager) {
      const injected = await this.memoryManager.assembleInjectedHistory({
        currentSessionId: sessionId,
        resumedSessionId: this.initialSessionId,
        activeTaskId: this.ctx.activeTaskId,
      });
      if (injected.length > 0) {
        const source = this.ctx.activeTaskId ? 'task' : 'chat';
        this.ctx.progress.onContextInjection(source, injected.length, this.ctx.activeTaskId);
        this.l1 = [...injected];
        this.injectedTokenEstimate = injected.reduce((sum, p) => sum + estimateTokens(p), 0);
      }
    }

    for await (const turn of this.channel.receive()) {
      const content = turn.content.trimStart();
      if (this.slashRegistry.isSlashCommand(content)) {
        const result = await this.slashRegistry.dispatch(content, {
          send: (msg) => this.channel.send(msg),
          sessionId,
        });
        if (result.exit) break;
        continue;
      }
      await this.handleTurn(turn.content, sessionId, turn.author);
    }
  }

  /**
   * Handle a single user turn:
   * append the user message to L1, call the API, dispatch tool calls until
   * done, append the final assistant response to L1, then deliver it via
   * channel.send().
   *
   * If the API call fails irrecoverably (4xx or exhausted retries) the error
   * message is delivered to the user via channel.send() rather than throwing.
   * Context overflow that cannot be resolved by compaction is also surfaced
   * this way.
   */
  async handleTurn(userMessage: string, sessionId: string = randomUUID(), author?: string): Promise<void> {
    // Tool definitions are stable for the lifetime of a turn — hoist the call
    // outside the loop to avoid redundant work on every round-trip.
    const tools = this.toolBus.getAnthropicDefinitions() as Anthropic.Tool[];

    // In multi-user sessions, prefix the message with the author's name so the
    // model understands who sent each turn.
    const messageContent = author ? `[${author}]: ${userMessage}` : userMessage;

    // Append the user message to L1 and persist to L2.
    this.l1.push({ role: 'user', content: messageContent });
    await this.persistEntry(sessionId, 'user', messageContent);

    try {
      while (true) {
        this.logger.debug('Sending request to LLM', {
          model: this.config.model,
          messageCount: this.l1.length,
        });

        this.ctx.progress.onThinking();

        // Build stable params (messages snapshot is taken fresh each attempt).
        const buildParams = () => ({
          model: this.config.model,
          system: this.systemPrompt,
          max_tokens: MAX_TOKENS,
          tools,
          // Spread to snapshot l1 at call time — prevents later mutations to
          // this.l1 (e.g. pushing the final assistant response) from being
          // visible in test spy captures of the argument.
          messages: [...this.l1],
        });

        let response: Anthropic.Message;
        try {
          response = await this.callApi(buildParams());
        } catch (err) {
          if (!isExceedContextSizeError(err)) throw err;
          // The request exceeded the context window before the threshold check
          // could fire (e.g. injected history masked the true token count).
          // Compact now and retry once before giving up.
          const compacted = this.memoryManager
            ? await this.memoryManager.compact(this.l1, sessionId, this.ctx.activeTaskId, this.ctx.progress)
            : this.compactMessages(this.l1);
          if (compacted === null) {
            throw new Error(
              `Context window exceeded and cannot be compacted further.`,
            );
          }
          this.l1.splice(0, this.l1.length, ...compacted);
          this.injectedTokenEstimate = 0;
          response = await this.callApi(buildParams());
        }

        this.logger.debug('Received response from LLM', {
          model: response.model,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          stopReason: response.stop_reason,
        });

        if (response.stop_reason === 'tool_use') {
          const toolUseBlocks = response.content.filter(
            (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
          );

          const toolCalls = toolUseBlocks.map((block) => ({
            id: block.id,
            name: block.name,
            input: block.input,
          }));

          // Persist assistant turn (with tool_use blocks) before dispatching.
          await this.persistEntry(sessionId, 'assistant', response.content);

          // Persist each tool call before dispatch.
          for (const call of toolCalls) {
            await this.persistEntry(sessionId, 'tool_call', call);
          }

          const toolResults = await this.toolBus.dispatchAll(toolCalls, this.ctx);

          // Persist each tool result after dispatch (before next LLM call).
          for (const result of toolResults) {
            await this.persistEntry(sessionId, 'tool_result', result);
          }

          // Append the assistant turn (which contains the tool_use blocks)
          this.l1.push({ role: 'assistant', content: response.content });

          // Append all tool results as a single user turn.
          // Only include is_error when true — some proxy servers reject is_error: false.
          this.l1.push({
            role: 'user',
            content: toolResults.map((result) => ({
              type: 'tool_result' as const,
              tool_use_id: result.id,
              content: result.content,
              ...(result.is_error ? { is_error: true } : {}),
            })),
          });

          // Check if context is approaching the limit.
          // Two checks are combined with OR:
          //   1. l1Fraction: L1-only tokens (subtracts injected estimate) vs threshold —
          //      avoids premature compaction when injected history is large.
          //   2. totalFraction: absolute total tokens vs threshold — catches the case
          //      where injectedTokenEstimate is large enough to suppress l1Fraction
          //      even though the full request is near the context limit.
          const l1Tokens = Math.max(0, response.usage.input_tokens - this.injectedTokenEstimate);
          const l1Fraction = l1Tokens / MODEL_CONTEXT_WINDOW;
          const totalFraction = response.usage.input_tokens / MODEL_CONTEXT_WINDOW;
          if (l1Fraction > this.config.memory.compactThreshold || totalFraction > this.config.memory.compactThreshold) {
            const compacted = this.memoryManager
              ? await this.memoryManager.compact(this.l1, sessionId, this.ctx.activeTaskId, this.ctx.progress)
              : this.compactMessages(this.l1);
            if (compacted === null) {
              throw new Error(
                `Context window exceeded and cannot be compacted further ` +
                `(${response.usage.input_tokens.toLocaleString()}/${MODEL_CONTEXT_WINDOW.toLocaleString()} tokens used).`,
              );
            }
            this.l1.splice(0, this.l1.length, ...compacted);
            // Injected history has been evicted — clear its token estimate so it
            // no longer artificially inflates the compaction headroom.
            this.injectedTokenEstimate = 0;
          }
        } else {
          // Covers 'end_turn', 'max_tokens', 'stop_sequence', and null.
          // In all cases we deliver whatever text the model produced so far.
          const textBlock = response.content.find(
            (block): block is Anthropic.TextBlock => block.type === 'text',
          );
          const text = textBlock?.text ?? '';

          // Persist final assistant response before delivering to the channel.
          await this.persistEntry(sessionId, 'assistant', text);

          // Append the final assistant response to L1 so the next user turn
          // sees the full conversation including this response.
          this.l1.push({ role: 'assistant', content: text });

          await this.channel.send(text);
          break;
        }
      }
    } catch (err) {
      await this.channel.send(`Error: ${getErrorMessage(err)}`);
    }
  }

  /**
   * Calls the Anthropic API with automatic retry for transient failures.
   *
   * - Network errors and 5xx responses are retried up to MAX_RETRIES times
   *   with exponential backoff (1 s, 2 s, 4 s, …).
   * - Each retry attempt is logged at warn level via console.warn.
   * - 4xx errors fail immediately without retrying.
   * - After MAX_RETRIES failed retries the last error is re-thrown.
   */
  private async callApi(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.client.messages.create(params);
      } catch (err) {
        if (!isRetryableError(err) || attempt === MAX_RETRIES) {
          throw err;
        }
        const delayMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        const reason = getErrorMessage(err);
        this.logger.warn('API call failed, retrying', {
          attempt: attempt + 1,
          total: MAX_RETRIES + 1,
          error: reason,
          retryMs: delayMs,
        });
        this.ctx.progress.onRetry(attempt + 1, MAX_RETRIES, reason);
        await this.sleep(delayMs);
      }
    }
    // Unreachable: the loop always exits via return or throw.
    throw new Error('unreachable');
  }

  /**
   * Fallback compaction used when no MemoryManager is wired up.
   *
   * Keeps the `memory.keepRecentMessages` most recent messages and prepends a
   * single stub message indicating that earlier context was omitted.
   *
   * Returns `null` when there are not enough messages to evict anything —
   * the caller should treat this as an unresolvable context overflow.
   */
  private compactMessages(
    messages: Anthropic.MessageParam[],
  ): Anthropic.MessageParam[] | null {
    const keep = this.config.memory.keepRecentMessages;
    if (messages.length <= keep) {
      return null; // nothing left to evict
    }
    return [
      {
        role: 'user',
        content: '[Earlier context has been compacted to stay within the context window.]',
      },
      ...messages.slice(-keep),
    ];
  }

  /** Appends one entry to the L2 session log. No-ops when no store is configured. */
  private async persistEntry(
    sessionId: string,
    role: 'user' | 'assistant' | 'tool_call' | 'tool_result',
    content: unknown,
  ): Promise<void> {
    if (!this.sessionStore) return;
    try {
      await this.sessionStore.append({
        sessionId,
        role,
        content,
        taskId: this.ctx.activeTaskId,
      });
    } catch (err) {
      // Log but do not throw — a persistence failure must not abort the agent loop.
      this.logger.warn('Failed to persist session entry', {
        sessionId,
        role,
        error: getErrorMessage(err),
      });
    }
  }
}
