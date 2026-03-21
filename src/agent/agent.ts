import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import type { Channel } from '../channels';
import type { ToolBus } from '../tools/tool-bus';
import type { ToolContext } from '../tools/tool';
import type { Config } from '../config/config';
import type { Logger } from '../logger';
import { createNoopLogger } from '../logger';

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

/** System prompt sent on every API call. */
const SYSTEM = 'You are bolt, an autonomous CLI agent. You have access to tools to execute shell commands, read and write files, and fetch web content. Use them to complete the user\'s request.';

/** Returns true if the error is transient and the call should be retried. */
function isRetryableError(err: unknown): boolean {
  if (err instanceof APIConnectionError) return true;
  if (err instanceof APIError && err.status !== undefined && err.status >= 500) return true;
  return false;
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
 */
export class AgentCore {
  constructor(
    private readonly client: Anthropic,
    private readonly channel: Channel,
    private readonly toolBus: ToolBus,
    private readonly ctx: ToolContext,
    private readonly config: Config,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    private readonly logger: Logger = createNoopLogger(),
  ) {}

  /** Run the agent loop until the channel closes. */
  async run(): Promise<void> {
    for await (const turn of this.channel.receive()) {
      await this.handleTurn(turn.content);
    }
  }

  /**
   * Handle a single user turn:
   * build messages, call the API, dispatch tool calls until done,
   * then deliver the final response.
   *
   * If the API call fails irrecoverably (4xx or exhausted retries) the error
   * message is delivered to the user via channel.send() rather than throwing.
   * Context overflow that cannot be resolved by compaction is also surfaced
   * this way.
   */
  async handleTurn(userMessage: string): Promise<void> {
    // Each user turn starts with a fresh message history. Cross-turn memory
    // (persisting context across multiple turns in the same run() session) is
    // handled by the Memory Manager introduced in Sprint 5.
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

    // Tool definitions are stable for the lifetime of a turn — hoist the call
    // outside the loop to avoid redundant work on every round-trip.
    const tools = this.toolBus.getAnthropicDefinitions() as Anthropic.Tool[];

    try {
      while (true) {
        this.logger.debug('Sending request to LLM', {
          model: this.config.model,
          messageCount: messages.length,
        });

        const response = await this.callApi({
          model: this.config.model,
          system: SYSTEM,
          max_tokens: MAX_TOKENS,
          tools,
          messages,
        });

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

          const toolResults = await this.toolBus.dispatchAll(toolCalls, this.ctx);

          // Append the assistant turn (which contains the tool_use blocks)
          messages.push({ role: 'assistant', content: response.content });

          // Append all tool results as a single user turn.
          // Only include is_error when true — some proxy servers reject is_error: false.
          messages.push({
            role: 'user',
            content: toolResults.map((result) => ({
              type: 'tool_result' as const,
              tool_use_id: result.id,
              content: result.content,
              ...(result.is_error ? { is_error: true } : {}),
            })),
          });

          // Check if token usage is approaching the context window limit.
          // We check here (after appending tool results) so the assessment
          // includes the full cost of the current round-trip. If over the
          // threshold, compact before the next API call.
          const tokenFraction = response.usage.input_tokens / MODEL_CONTEXT_WINDOW;
          if (tokenFraction > this.config.memory.compactThreshold) {
            const compacted = this.compactMessages(messages);
            if (compacted === null) {
              throw new Error(
                `Context window exceeded and cannot be compacted further ` +
                `(${response.usage.input_tokens.toLocaleString()}/${MODEL_CONTEXT_WINDOW.toLocaleString()} tokens used).`,
              );
            }
            messages.splice(0, messages.length, ...compacted);
          }
        } else {
          // Covers 'end_turn', 'max_tokens', 'stop_sequence', and null.
          // In all cases we deliver whatever text the model produced so far.
          const textBlock = response.content.find(
            (block): block is Anthropic.TextBlock => block.type === 'text',
          );
          await this.channel.send(textBlock?.text ?? '');
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
        this.logger.warn('API call failed, retrying', {
          attempt: attempt + 1,
          total: MAX_RETRIES + 1,
          error: getErrorMessage(err),
          retryMs: delayMs,
        });
        await this.sleep(delayMs);
      }
    }
    // Unreachable: the loop always exits via return or throw.
    throw new Error('unreachable');
  }

  /**
   * Compacts the message history to reduce token usage.
   *
   * Keeps the `memory.keepRecentMessages` most recent messages and prepends a
   * single stub message indicating that earlier context was omitted.
   *
   * Returns `null` when there are not enough messages to evict anything —
   * the caller should treat this as an unresolvable context overflow.
   *
   * Full compaction (model-generated summary + Compact Store persistence) is
   * implemented by the Memory Manager in Sprint 5. This is the minimal
   * in-agent fallback that keeps the loop alive during long tool-use chains.
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
}
