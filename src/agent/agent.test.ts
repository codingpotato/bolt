import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentCore } from './agent';
import type { Channel, UserTurn } from '../channels';
import type { ToolBus } from '../tools/tool-bus';
import type { ToolContext } from '../tools/tool';
import type { Config } from '../config/config';
import type Anthropic from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Config with a known model name. */
function makeConfig(model = 'claude-test'): Config {
  return {
    model,
    dataDir: '.bolt',
    logLevel: 'info',
    auth: {},
    local: {},
    memory: { compactThreshold: 0.8, keepRecentMessages: 10, storePath: 'memory', searchBackend: 'keyword' },
    tasks: { maxSubtaskDepth: 5, maxRetries: 3 },
    tools: { timeoutMs: 30000, allowedTools: [] },
    codeWorkflows: { testFixRetries: 3 },
    channels: { web: { enabled: false, port: 3000, mode: 'websocket' } },
  };
}

/** Create a Channel mock that yields the given messages then closes. */
function makeChannel(messages: string[]): { channel: Channel; sendSpy: ReturnType<typeof vi.fn> } {
  const sendSpy = vi.fn().mockResolvedValue(undefined) as ReturnType<typeof vi.fn>;

  async function* receive(): AsyncIterable<UserTurn> {
    for (const content of messages) {
      yield { content };
    }
  }

  const channel: Channel = { receive, send: sendSpy };
  return { channel, sendSpy };
}

/** Create a ToolBus mock. */
function makeToolBus(dispatchAllResult: Awaited<ReturnType<ToolBus['dispatchAll']>> = []) {
  return {
    getAnthropicDefinitions: vi.fn().mockReturnValue([]),
    dispatchAll: vi.fn().mockResolvedValue(dispatchAllResult),
  } as unknown as ToolBus;
}

/** Build a minimal ToolContext. */
function makeCtx(): ToolContext {
  return { cwd: '/tmp', log: { log: vi.fn().mockResolvedValue(undefined) } };
}

/** Minimal Usage shape satisfying the SDK type. */
const FAKE_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: null,
  cache_read_input_tokens: null,
} as unknown as Anthropic.Usage;

/**
 * Build a fake Anthropic text response (no tool calls).
 * Pass an empty string to produce a response with no content blocks at all,
 * which exercises the "no text block" branch in AgentCore.
 */
function makeTextResponse(text: string): Anthropic.Message {
  const content = text
    ? ([{ type: 'text', text, citations: [] }] as unknown as Anthropic.ContentBlock[])
    : [];
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude-test',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: FAKE_USAGE,
    container: null,
  };
}

/** Build a fake Anthropic response with tool_use blocks. */
function makeToolUseResponse(
  tools: Array<{ id: string; name: string; input: unknown }>,
): Anthropic.Message {
  return {
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    content: tools.map((t) => ({
      type: 'tool_use' as const,
      id: t.id,
      name: t.name,
      input: t.input,
    })) as unknown as Anthropic.ContentBlock[],
    model: 'claude-test',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: FAKE_USAGE,
    container: null,
  };
}

/** Build a fake Anthropic client whose `messages.create` returns a sequence of responses. */
function makeClient(responses: Anthropic.Message[]) {
  let callCount = 0;
  const createSpy = vi.fn().mockImplementation(() => {
    const response = responses[callCount];
    if (response === undefined) {
      throw new Error(`Unexpected extra API call (call #${callCount})`);
    }
    callCount++;
    return Promise.resolve(response);
  });

  return {
    client: { messages: { create: createSpy } } as unknown as Anthropic,
    createSpy,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentCore', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = makeCtx();
  });

  // ── basic text response ───────────────────────────────────────────────────

  describe('simple text response', () => {
    it('delivers model text to channel.send()', async () => {
      const { client, createSpy } = makeClient([makeTextResponse('Hello!')]);
      const { channel, sendSpy } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(createSpy).toHaveBeenCalledOnce();
      expect(sendSpy).toHaveBeenCalledOnce();
      expect(sendSpy).toHaveBeenCalledWith('Hello!');
    });

    it('sends empty string when model response has no text block', async () => {
      const emptyResponse: Anthropic.Message = {
        ...makeTextResponse(''),
        content: [],
        stop_reason: 'end_turn',
      };
      const { client } = makeClient([emptyResponse]);
      const { channel, sendSpy } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(sendSpy).toHaveBeenCalledWith('');
    });

    it('handles multiple sequential user turns', async () => {
      const { client, createSpy } = makeClient([
        makeTextResponse('Response 1'),
        makeTextResponse('Response 2'),
      ]);
      const { channel, sendSpy } = makeChannel(['turn 1', 'turn 2']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy).toHaveBeenNthCalledWith(1, 'Response 1');
      expect(sendSpy).toHaveBeenNthCalledWith(2, 'Response 2');
    });

    it('exits cleanly when channel yields no messages', async () => {
      const { client, createSpy } = makeClient([]);
      const { channel, sendSpy } = makeChannel([]);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(createSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    });
  });

  // ── API parameters ────────────────────────────────────────────────────────

  describe('API call parameters', () => {
    it('uses model from config', async () => {
      const { client, createSpy } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig('claude-custom-model'));
      await agent.run();

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'claude-custom-model' }),
      );
    });

    it('passes tool definitions from ToolBus to the API', async () => {
      const toolDef = { name: 'bash', description: 'run shell', input_schema: { type: 'object' } };
      const { client, createSpy } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hi']);
      const toolBus = {
        getAnthropicDefinitions: vi.fn().mockReturnValue([toolDef]),
        dispatchAll: vi.fn().mockResolvedValue([]),
      } as unknown as ToolBus;

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ tools: [toolDef] }),
      );
    });

    it('includes the user message in the messages array', async () => {
      const { client, createSpy } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['do the thing']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      const callArg = createSpy.mock.calls[0]?.[0] as { messages: Anthropic.MessageParam[] };
      expect(callArg.messages[0]).toEqual({ role: 'user', content: 'do the thing' });
    });
  });

  // ── tool call loop ────────────────────────────────────────────────────────

  describe('tool call loop', () => {
    it('dispatches tool calls via ToolBus', async () => {
      const toolUse = makeToolUseResponse([{ id: 'tu_1', name: 'bash', input: { command: 'ls' } }]);
      const toolResult = { id: 'tu_1', content: '{"stdout":"file.txt","exitCode":0}' };
      const finalText = makeTextResponse('Done!');

      const { client } = makeClient([toolUse, finalText]);
      const { channel, sendSpy } = makeChannel(['run ls']);
      const toolBus = makeToolBus([toolResult]);

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(toolBus.dispatchAll).toHaveBeenCalledOnce();
      expect(toolBus.dispatchAll).toHaveBeenCalledWith(
        [{ id: 'tu_1', name: 'bash', input: { command: 'ls' } }],
        ctx,
      );
      expect(sendSpy).toHaveBeenCalledWith('Done!');
    });

    it('appends assistant tool_use and tool_result messages before next API call', async () => {
      const toolUseResponse = makeToolUseResponse([
        { id: 'tu_1', name: 'bash', input: { command: 'pwd' } },
      ]);
      const toolResult = { id: 'tu_1', content: '{"stdout":"/home","exitCode":0}' };
      const finalResponse = makeTextResponse('Done.');

      const { client, createSpy } = makeClient([toolUseResponse, finalResponse]);
      const { channel } = makeChannel(['run']);
      const toolBus = makeToolBus([toolResult]);

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      // Second call should include the assistant turn + tool_result turn
      const secondCallArg = createSpy.mock.calls[1]?.[0] as { messages: Anthropic.MessageParam[] };
      expect(secondCallArg.messages).toHaveLength(3);
      expect(secondCallArg.messages[1]).toEqual({
        role: 'assistant',
        content: toolUseResponse.content,
      });
      expect(secondCallArg.messages[2]).toEqual({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: '{"stdout":"/home","exitCode":0}',
            is_error: undefined,
          },
        ],
      });
    });

    it('dispatches multiple tool calls from one response', async () => {
      const toolUseResponse = makeToolUseResponse([
        { id: 'tu_1', name: 'bash', input: { command: 'ls' } },
        { id: 'tu_2', name: 'bash', input: { command: 'pwd' } },
      ]);
      const toolResults = [
        { id: 'tu_1', content: '{"stdout":"a","exitCode":0}' },
        { id: 'tu_2', content: '{"stdout":"/home","exitCode":0}' },
      ];
      const finalResponse = makeTextResponse('All done.');

      const { client } = makeClient([toolUseResponse, finalResponse]);
      const { channel } = makeChannel(['run both']);
      const toolBus = makeToolBus(toolResults);

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(toolBus.dispatchAll).toHaveBeenCalledWith(
        [
          { id: 'tu_1', name: 'bash', input: { command: 'ls' } },
          { id: 'tu_2', name: 'bash', input: { command: 'pwd' } },
        ],
        ctx,
      );
    });

    it('loops through multiple rounds of tool calls before delivering response', async () => {
      const round1 = makeToolUseResponse([{ id: 'tu_1', name: 'bash', input: {} }]);
      const round2 = makeToolUseResponse([{ id: 'tu_2', name: 'bash', input: {} }]);
      const final = makeTextResponse('All done.');

      const { client, createSpy } = makeClient([round1, round2, final]);
      const { channel, sendSpy } = makeChannel(['go']);

      const toolBus = {
        getAnthropicDefinitions: vi.fn().mockReturnValue([]),
        dispatchAll: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'tu_1', content: '{}' }])
          .mockResolvedValueOnce([{ id: 'tu_2', content: '{}' }]),
      } as unknown as ToolBus;

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(createSpy).toHaveBeenCalledTimes(3);
      expect(toolBus.dispatchAll).toHaveBeenCalledTimes(2);
      expect(sendSpy).toHaveBeenCalledWith('All done.');
    });

    it('accumulates full message history across multiple tool call rounds', async () => {
      const round1 = makeToolUseResponse([{ id: 'tu_1', name: 'bash', input: { command: 'ls' } }]);
      const round2 = makeToolUseResponse([{ id: 'tu_2', name: 'bash', input: { command: 'pwd' } }]);
      const final = makeTextResponse('Done.');

      const { client, createSpy } = makeClient([round1, round2, final]);
      const { channel } = makeChannel(['go']);

      const toolBus = {
        getAnthropicDefinitions: vi.fn().mockReturnValue([]),
        dispatchAll: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'tu_1', content: '{"stdout":"a"}' }])
          .mockResolvedValueOnce([{ id: 'tu_2', content: '{"stdout":"/home"}' }]),
      } as unknown as ToolBus;

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      // Third call should carry all five messages: user + (assistant + tool_result) × 2
      const thirdCallArg = createSpy.mock.calls[2]?.[0] as { messages: Anthropic.MessageParam[] };
      expect(thirdCallArg.messages).toHaveLength(5);
      expect(thirdCallArg.messages[0]).toMatchObject({ role: 'user' });
      expect(thirdCallArg.messages[1]).toMatchObject({ role: 'assistant' }); // round 1 tool_use
      expect(thirdCallArg.messages[2]).toMatchObject({ role: 'user' });      // round 1 tool_result
      expect(thirdCallArg.messages[3]).toMatchObject({ role: 'assistant' }); // round 2 tool_use
      expect(thirdCallArg.messages[4]).toMatchObject({ role: 'user' });      // round 2 tool_result
    });

    it('includes is_error flag in tool_result when tool failed', async () => {
      const toolUseResponse = makeToolUseResponse([
        { id: 'tu_1', name: 'bash', input: { command: 'fail' } },
      ]);
      const errorResult = { id: 'tu_1', content: '{"error":"oops"}', is_error: true };
      const finalResponse = makeTextResponse('Failed.');

      const { client, createSpy } = makeClient([toolUseResponse, finalResponse]);
      const { channel } = makeChannel(['run']);
      const toolBus = makeToolBus([errorResult]);

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      const secondCall = createSpy.mock.calls[1]?.[0] as { messages: Anthropic.MessageParam[] };
      const toolResultTurn = secondCall.messages[2] as {
        role: string;
        content: Array<{ is_error: boolean }>;
      };
      expect(toolResultTurn.content[0]?.is_error).toBe(true);
    });
  });

  // ── stop_reason edge cases ────────────────────────────────────────────────

  describe('stop_reason edge cases', () => {
    it('delivers text when stop_reason is null', async () => {
      const nullStopResponse: Anthropic.Message = {
        ...makeTextResponse('partial'),
        stop_reason: null,
      };
      const { client } = makeClient([nullStopResponse]);
      const { channel, sendSpy } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(sendSpy).toHaveBeenCalledWith('partial');
    });

    it('delivers text when stop_reason is max_tokens', async () => {
      const maxTokensResponse: Anthropic.Message = {
        ...makeTextResponse('truncated'),
        stop_reason: 'max_tokens',
      };
      const { client } = makeClient([maxTokensResponse]);
      const { channel, sendSpy } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(sendSpy).toHaveBeenCalledWith('truncated');
    });
  });

  // ── handleTurn (unit) ─────────────────────────────────────────────────────

  describe('handleTurn', () => {
    it('can be called directly with a user message string', async () => {
      const { client } = makeClient([makeTextResponse('direct response')]);
      const { channel, sendSpy } = makeChannel([]);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.handleTurn('direct call');

      expect(sendSpy).toHaveBeenCalledWith('direct response');
    });
  });
});
