import type Anthropic from '@anthropic-ai/sdk';
import type { Channel } from '../channels';
import type { ToolBus } from '../tools/tool-bus';
import type { ToolContext } from '../tools/tool';
import type { Config } from '../config/config';

/** Maximum tokens to request per API call. */
const MAX_TOKENS = 8096;

/**
 * AgentCore drives the main agentic loop.
 *
 * For each user turn received from the channel:
 *   1. Call the Anthropic API with the current message history and tools.
 *   2. If the model returns tool calls, dispatch them via the ToolBus,
 *      append the results, and call the API again.
 *   3. When the model returns a final text response, deliver it via
 *      channel.send() and wait for the next user turn.
 */
export class AgentCore {
  constructor(
    private readonly client: Anthropic,
    private readonly channel: Channel,
    private readonly toolBus: ToolBus,
    private readonly ctx: ToolContext,
    private readonly config: Config,
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
   */
  async handleTurn(userMessage: string): Promise<void> {
    // Each user turn starts with a fresh message history. Cross-turn memory
    // (persisting context across multiple turns in the same run() session) is
    // handled by the Memory Manager introduced in Sprint 5.
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userMessage }];

    // Tool definitions are stable for the lifetime of a turn — hoist the call
    // outside the loop to avoid redundant work on every round-trip.
    const tools = this.toolBus.getAnthropicDefinitions() as Anthropic.Tool[];

    while (true) {
      const response = await this.client.messages.create({
        model: this.config.model,
        max_tokens: MAX_TOKENS,
        tools,
        messages,
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

        // Append all tool results as a single user turn
        messages.push({
          role: 'user',
          content: toolResults.map((result) => ({
            type: 'tool_result' as const,
            tool_use_id: result.id,
            content: result.content,
            is_error: result.is_error,
          })),
        });
      } else {
        // Covers 'end_turn', 'max_tokens', 'stop_sequence', and null.
        // In all cases we deliver whatever text the model produced so far.
        // Context-overflow recovery (max_tokens → compaction → retry) is
        // added in S3-3.
        const textBlock = response.content.find(
          (block): block is Anthropic.TextBlock => block.type === 'text',
        );
        await this.channel.send(textBlock?.text ?? '');
        break;
      }
    }
  }
}
