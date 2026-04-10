import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentCore } from './agent';
import type { Channel, UserTurn } from '../channels';
import type { ToolBus } from '../tools/tool-bus';
import type { ToolContext } from '../tools/tool';
import type { Config } from '../config/config';
import type { Logger } from '../logger';
import { createNoopLogger } from '../logger';
import type Anthropic from '@anthropic-ai/sdk';
import { APIConnectionError, APIError } from '@anthropic-ai/sdk';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal Config with a known model name. */
function makeConfig(model = 'claude-test'): Config {
  return {
    model,
    dataDir: '.bolt',
    logLevel: 'info',
    logTrace: false,
    workspace: { root: process.cwd() },
    auth: {},
    local: {},
    agentPrompt: { maxTokens: 8000, watchForChanges: false, projectFile: '.bolt/AGENT.md' },
    memory: {
      compactThreshold: 0.8,
      keepRecentMessages: 10,
      storePath: 'memory',
      sessionPath: 'sessions',
      taskHistoryMessages: 20,
      taskHistoryTokenBudget: 20000,
      injectRecentChat: true,
      searchBackend: 'keyword',
    },
    search: { provider: 'searxng' as const, maxResults: 10 },
    tasks: { maxSubtaskDepth: 5, maxRetries: 3 },
    tools: { timeoutMs: 30000, allowedTools: [] },
    comfyui: {
      servers: [],
      workflows: { text2img: 'image_z_image_turbo', img2video: 'video_ltx2_3_i2v' },
      pollIntervalMs: 2000,
      timeoutMs: 300000,
      maxConcurrentPerServer: 2,
    },
    ffmpeg: {
      videoCodec: 'libx264',
      crf: 23,
      preset: 'fast',
      audioCodec: 'aac',
      audioBitrate: '128k',
    },
    codeWorkflows: { testFixRetries: 3 },
    cli: { progress: true, verbose: false },
    channels: { web: { enabled: false, port: 3000, mode: 'websocket' } },
  };
}

/** Create a Channel mock that yields the given messages then closes. */
function makeChannel(messages: string[]): { channel: Channel; sendSpy: ReturnType<typeof vi.fn> } {
  const sendSpy = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

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
  return {
    cwd: '/tmp',
    log: { log: vi.fn().mockResolvedValue(undefined) },
    logger: createNoopLogger(),
    progress: {
      onSessionStart: vi.fn(),
      onThinking: vi.fn(),
      onLlmCall: vi.fn(),
      onLlmResponse: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onTaskStatusChange: vi.fn(),
      onContextInjection: vi.fn(),
      onMemoryCompaction: vi.fn(),
      onRetry: vi.fn(),
      onSubagentStart: vi.fn(),
      onSubagentEnd: vi.fn(),
      onSubagentError: vi.fn(),
      onSubagentThinking: vi.fn(),
      onSubagentToolCall: vi.fn(),
      onSubagentToolResult: vi.fn(),
      onSubagentRetry: vi.fn(),
    },
  };
}

/** Build a mock Logger whose methods can be asserted on. */
function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** No-op sleep for tests — avoids real delays. */
const noopSleep = vi.fn().mockResolvedValue(undefined);

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
  } as unknown as Anthropic.Message;
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
  } as unknown as Anthropic.Message;
}

/** Build a fake Anthropic client whose `messages.create` returns a sequence of responses or throws errors. */
function makeClient(responses: Array<Anthropic.Message | Error>) {
  let callCount = 0;
  const createSpy = vi.fn().mockImplementation(() => {
    const response = responses[callCount];
    if (response === undefined) {
      throw new Error(`Unexpected extra API call (call #${callCount})`);
    }
    callCount++;
    if (response instanceof Error) {
      return Promise.reject(response);
    }
    return Promise.resolve(response);
  });

  return {
    client: { messages: { create: createSpy } } as unknown as Anthropic,
    createSpy,
  };
}

/**
 * Build a Usage object with a specific input_tokens count.
 * Used to simulate context window pressure in overflow tests.
 */
function makeUsage(inputTokens: number): Anthropic.Usage {
  return {
    input_tokens: inputTokens,
    output_tokens: 5,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
  } as unknown as Anthropic.Usage;
}

/** Build a tool_use response with explicit token usage. */
function makeToolUseResponseWithTokens(
  tools: Array<{ id: string; name: string; input: unknown }>,
  inputTokens: number,
): Anthropic.Message {
  return {
    ...makeToolUseResponse(tools),
    usage: makeUsage(inputTokens),
  } as unknown as Anthropic.Message;
}

/** Build a 5xx API error (retryable). */
function make5xxError(status = 500): APIError {
  return APIError.generate(status, undefined, `HTTP ${status}`, new Headers()) as APIError;
}

/** Build a 4xx API error (non-retryable). */
function make4xxError(status = 401): APIError {
  return APIError.generate(status, undefined, `HTTP ${status}`, new Headers()) as APIError;
}

/** Build a network/connection error (retryable). */
function makeNetworkError(): APIConnectionError {
  return new APIConnectionError({ message: 'ECONNREFUSED' });
}

/** Build a 400 exceed_context_size_error (context window exceeded). */
function makeExceedContextSizeError(): APIError {
  return APIError.generate(
    400,
    undefined,
    'request (447954 tokens) exceeds the available context size (200192 tokens), try increasing it',
    new Headers(),
  ) as APIError;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentCore', () => {
  let ctx: ToolContext;

  beforeEach(() => {
    ctx = makeCtx();
    noopSleep.mockClear();
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

  // ── progress emissions (S5-2) ─────────────────────────────────────────────

  describe('progress emissions', () => {
    it('emits onSessionStart once when run() is called', async () => {
      const { client } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(ctx.progress.onSessionStart).toHaveBeenCalledOnce();
      expect(ctx.progress.onSessionStart).toHaveBeenCalledWith(expect.any(String), false);
    });

    it('emits onThinking before each API call', async () => {
      const { client } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(ctx.progress.onThinking).toHaveBeenCalledOnce();
    });

    it('emits onThinking for each round-trip in a tool-call loop', async () => {
      const toolUse = makeToolUseResponse([{ id: 'tu_1', name: 'bash', input: { command: 'ls' } }]);
      const { client } = makeClient([toolUse, makeTextResponse('done')]);
      const { channel } = makeChannel(['go']);
      const toolBus = makeToolBus([{ id: 'tu_1', content: '{"exitCode":0}' }]);

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      // onThinking is called before each API call — 2 calls = 2 emissions
      expect(ctx.progress.onThinking).toHaveBeenCalledTimes(2);
    });

    it('emits onLlmCall before each API call with message count', async () => {
      const { client } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(ctx.progress.onLlmCall).toHaveBeenCalledOnce();
      expect(ctx.progress.onLlmCall).toHaveBeenCalledWith(
        expect.objectContaining({
          messageCount: expect.any(Number),
          injectedTokens: expect.any(Number),
        }),
      );
    });

    it('emits onLlmResponse after each API call with token usage', async () => {
      const { client } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(client, channel, toolBus, ctx, makeConfig());
      await agent.run();

      expect(ctx.progress.onLlmResponse).toHaveBeenCalledOnce();
      expect(ctx.progress.onLlmResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
          stopReason: expect.any(String),
        }),
      );
    });

    it('emits onRetry on each transient failure', async () => {
      const { client } = makeClient([make5xxError(500), make5xxError(500), makeTextResponse('ok')]);
      const { channel } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(ctx.progress.onRetry).toHaveBeenCalledTimes(2);
      expect(ctx.progress.onRetry).toHaveBeenNthCalledWith(1, 1, 3, expect.any(String));
      expect(ctx.progress.onRetry).toHaveBeenNthCalledWith(2, 2, 3, expect.any(String));
    });
  });

  // ── API parameters ────────────────────────────────────────────────────────

  describe('API call parameters', () => {
    it('uses the provided systemPrompt as the system field in every API call', async () => {
      const { client, createSpy } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        'custom system prompt',
      );
      await agent.run();

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ system: 'custom system prompt' }),
      );
    });

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

      expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ tools: [toolDef] }));
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
      expect(thirdCallArg.messages[2]).toMatchObject({ role: 'user' }); // round 1 tool_result
      expect(thirdCallArg.messages[3]).toMatchObject({ role: 'assistant' }); // round 2 tool_use
      expect(thirdCallArg.messages[4]).toMatchObject({ role: 'user' }); // round 2 tool_result
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

  // ── API error handling and retries ────────────────────────────────────────

  describe('API error handling and retries', () => {
    it('retries on a 5xx error and succeeds on the next attempt', async () => {
      const { client, createSpy } = makeClient([make5xxError(500), makeTextResponse('ok')]);
      const { channel, sendSpy } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy).toHaveBeenCalledWith('ok');
    });

    it('retries on a network/connection error and succeeds on the next attempt', async () => {
      const { client, createSpy } = makeClient([makeNetworkError(), makeTextResponse('ok')]);
      const { channel, sendSpy } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy).toHaveBeenCalledWith('ok');
    });

    it('surfaces error via channel.send() after exhausting all retries', async () => {
      // 4 failures = initial attempt + 3 retries exhausted
      const { client, createSpy } = makeClient([
        make5xxError(503),
        make5xxError(503),
        make5xxError(503),
        make5xxError(503),
      ]);
      const { channel, sendSpy } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).toHaveBeenCalledTimes(4);
      expect(sendSpy).toHaveBeenCalledOnce();
      expect(sendSpy.mock.calls[0]?.[0]).toMatch(/^Error:/);
    });

    it('does not retry on a 4xx error — fails immediately', async () => {
      const { client, createSpy } = makeClient([make4xxError(401)]);
      const { channel, sendSpy } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).toHaveBeenCalledOnce();
      expect(noopSleep).not.toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalledOnce();
      expect(sendSpy.mock.calls[0]?.[0]).toMatch(/^Error:/);
    });

    it('does not retry on a 400 bad-request error', async () => {
      const { client, createSpy } = makeClient([make4xxError(400)]);
      const { channel, sendSpy } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).toHaveBeenCalledOnce();
      expect(noopSleep).not.toHaveBeenCalled();
      expect(sendSpy.mock.calls[0]?.[0]).toMatch(/^Error:/);
    });

    it('retries up to MAX_RETRIES (3) times before giving up', async () => {
      // Exactly 3 retries (4 total calls) should be attempted before giving up.
      const errors = [
        makeNetworkError(),
        makeNetworkError(),
        makeNetworkError(),
        makeNetworkError(), // 4th failure — no more retries
      ];
      const { client, createSpy } = makeClient(errors);
      const { channel } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).toHaveBeenCalledTimes(4);
      expect(noopSleep).toHaveBeenCalledTimes(3);
    });

    it('logs a warning via logger on each retry attempt', async () => {
      const { client } = makeClient([make5xxError(500), make5xxError(500), makeTextResponse('ok')]);
      const { channel } = makeChannel(['hi']);
      const toolBus = makeToolBus();
      const mockLogger = makeLogger();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
        mockLogger,
      );
      await agent.run();

      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
      expect(vi.mocked(mockLogger.warn).mock.calls[0]?.[0]).toBe('API call failed, retrying');
      expect(vi.mocked(mockLogger.warn).mock.calls[0]?.[1]).toMatchObject({ attempt: 1, total: 4 });
      expect(vi.mocked(mockLogger.warn).mock.calls[1]?.[1]).toMatchObject({ attempt: 2, total: 4 });
    });

    it('uses exponential backoff: delays are 1000ms, 2000ms, 4000ms', async () => {
      const { client } = makeClient([
        makeNetworkError(),
        makeNetworkError(),
        makeNetworkError(),
        makeTextResponse('ok'),
      ]);
      const { channel } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(noopSleep).toHaveBeenCalledTimes(3);
      expect(noopSleep).toHaveBeenNthCalledWith(1, 1000);
      expect(noopSleep).toHaveBeenNthCalledWith(2, 2000);
      expect(noopSleep).toHaveBeenNthCalledWith(3, 4000);
    });

    it('does not call sleep when no retry is needed', async () => {
      const { client } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hi']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(noopSleep).not.toHaveBeenCalled();
    });

    it('retries mid-conversation tool-call loop independently of prior turns', async () => {
      // Turn 1: succeeds immediately. Turn 2: first API call fails then succeeds.
      const { client, createSpy } = makeClient([
        makeTextResponse('turn 1 done'),
        make5xxError(502),
        makeTextResponse('turn 2 done'),
      ]);
      const { channel, sendSpy } = makeChannel(['turn 1', 'turn 2']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).toHaveBeenCalledTimes(3);
      expect(sendSpy).toHaveBeenNthCalledWith(1, 'turn 1 done');
      expect(sendSpy).toHaveBeenNthCalledWith(2, 'turn 2 done');
    });
  });

  // ── context overflow handling ─────────────────────────────────────────────

  describe('context overflow handling', () => {
    // Config with a small keepRecentMessages to make compaction easy to trigger.
    // compactThreshold: 0.8 × 200_000 = 160_000 tokens.
    function makeOverflowConfig() {
      return { ...makeConfig(), memory: { ...makeConfig().memory, keepRecentMessages: 2 } };
    }

    const TOOL_CALL = { id: 'tu_1', name: 'bash', input: { command: 'ls' } };
    const TOOL_RESULT = { id: 'tu_1', content: '{"stdout":"ok","exitCode":0}' };

    it('does not compact when token usage is below threshold', async () => {
      // 10 tokens / 200_000 = 0.00005 — well below 0.8 threshold
      const toolUse = makeToolUseResponseWithTokens([TOOL_CALL], 10);
      const final = makeTextResponse('done');

      const { client, createSpy } = makeClient([toolUse, final]);
      const { channel } = makeChannel(['go']);
      const toolBus = makeToolBus([TOOL_RESULT]);

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeOverflowConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      // Second call should have the full un-compacted message history:
      // [user, assistant(tool_use), user(tool_result)]
      const secondCallArg = createSpy.mock.calls[1]?.[0] as { messages: Anthropic.MessageParam[] };
      expect(secondCallArg.messages).toHaveLength(3);
    });

    it('compacts messages when token usage exceeds threshold', async () => {
      // 170_000 tokens / 200_000 = 0.85 — above 0.8 threshold
      const toolUse = makeToolUseResponseWithTokens([TOOL_CALL], 170_000);
      const final = makeTextResponse('done');

      const { client, createSpy } = makeClient([toolUse, final]);
      const { channel } = makeChannel(['go']);
      const toolBus = makeToolBus([TOOL_RESULT]);

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeOverflowConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      // After compaction (keepRecentMessages=2), messages shrink:
      // [stub, assistant(tool_use), user(tool_result)] — 3 items (stub + 2 recent)
      const secondCallArg = createSpy.mock.calls[1]?.[0] as { messages: Anthropic.MessageParam[] };
      expect(secondCallArg.messages).toHaveLength(3);
    });

    it('inserts a compaction stub as the first message after compaction', async () => {
      const toolUse = makeToolUseResponseWithTokens([TOOL_CALL], 170_000);
      const final = makeTextResponse('done');

      const { client, createSpy } = makeClient([toolUse, final]);
      const { channel } = makeChannel(['go']);
      const toolBus = makeToolBus([TOOL_RESULT]);

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeOverflowConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      const secondCallArg = createSpy.mock.calls[1]?.[0] as { messages: Anthropic.MessageParam[] };
      const firstMsg = secondCallArg.messages[0] as { role: string; content: string };
      expect(firstMsg.role).toBe('user');
      expect(firstMsg.content).toContain('compacted');
    });

    it('retains the keepRecentMessages most recent messages after compaction', async () => {
      // With keepRecentMessages=2, the 2 most recent messages should be preserved.
      // After the first tool round-trip, messages = [user, assistant, user(tool_result)].
      // Compaction keeps last 2: [assistant, user(tool_result)].
      const toolUse = makeToolUseResponseWithTokens([TOOL_CALL], 170_000);
      const final = makeTextResponse('done');

      const { client, createSpy } = makeClient([toolUse, final]);
      const { channel } = makeChannel(['go']);
      const toolBus = makeToolBus([TOOL_RESULT]);

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeOverflowConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      const secondCallArg = createSpy.mock.calls[1]?.[0] as { messages: Anthropic.MessageParam[] };
      // [stub, assistant(tool_use), user(tool_result)]
      expect(secondCallArg.messages[1]).toMatchObject({ role: 'assistant' });
      expect(secondCallArg.messages[2]).toMatchObject({ role: 'user' });
    });

    it('continues the agent loop after compaction and delivers the final response', async () => {
      const toolUse = makeToolUseResponseWithTokens([TOOL_CALL], 170_000);
      const final = makeTextResponse('all done');

      const { client } = makeClient([toolUse, final]);
      const { channel, sendSpy } = makeChannel(['go']);
      const toolBus = makeToolBus([TOOL_RESULT]);

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeOverflowConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(sendSpy).toHaveBeenCalledWith('all done');
    });

    it('surfaces an error via channel.send() when messages cannot be compacted further', async () => {
      // With keepRecentMessages=2 and only 2 messages total after tool round-trip
      // (we force this with keepRecentMessages=3 so messages.length <= keep),
      // compaction returns null and an error is thrown.
      const overflowConfig = {
        ...makeConfig(),
        memory: { ...makeConfig().memory, keepRecentMessages: 10 },
      };
      // After one tool round-trip: [user, assistant, user(tool_result)] = 3 messages.
      // keepRecentMessages=10 > 3, so compactMessages returns null.
      const toolUse = makeToolUseResponseWithTokens([TOOL_CALL], 170_000);

      const { client, createSpy } = makeClient([toolUse]);
      const { channel, sendSpy } = makeChannel(['go']);
      const toolBus = makeToolBus([TOOL_RESULT]);

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        overflowConfig,
        undefined,
        noopSleep,
      );
      await agent.run();

      // The API should only be called once (no retry after unresolvable overflow)
      expect(createSpy).toHaveBeenCalledOnce();
      expect(sendSpy).toHaveBeenCalledOnce();
      expect(sendSpy.mock.calls[0]?.[0]).toMatch(/Context window exceeded/);
    });

    it('delegates to memoryManager.compact() when a MemoryManager is provided', async () => {
      const toolUse = makeToolUseResponseWithTokens([TOOL_CALL], 170_000);
      const final = makeTextResponse('done');

      const { client } = makeClient([toolUse, final]);
      const { channel } = makeChannel(['go']);
      const toolBus = makeToolBus([TOOL_RESULT]);

      const compactSpy = vi
        .fn()
        .mockImplementation(async (msgs: Anthropic.MessageParam[]) => [
          { role: 'user' as const, content: '[compacted by manager]' },
          ...msgs.slice(-2),
        ]);
      const mockMemoryManager = {
        assembleInjectedHistory: vi.fn().mockResolvedValue([]),
        compact: compactSpy,
      };

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeOverflowConfig(),
        undefined,
        noopSleep,
        undefined,
        undefined,
        undefined,
        undefined,
        mockMemoryManager as unknown as import('../memory/memory-manager').MemoryManager,
      );
      await agent.run();

      expect(compactSpy).toHaveBeenCalledOnce();
      const [msgs, sessionId, activeTaskId, progress] = compactSpy.mock.calls[0] as [
        Anthropic.MessageParam[],
        string,
        string | undefined,
        unknown,
      ];
      expect(Array.isArray(msgs)).toBe(true);
      expect(typeof sessionId).toBe('string');
      expect(activeTaskId).toBeUndefined();
      expect(progress).toBe(ctx.progress);
    });

    it('includes token counts in the unresolvable overflow error message', async () => {
      const overflowConfig = {
        ...makeConfig(),
        memory: { ...makeConfig().memory, keepRecentMessages: 10 },
      };
      const toolUse = makeToolUseResponseWithTokens([TOOL_CALL], 170_000);

      const { client } = makeClient([toolUse]);
      const { channel, sendSpy } = makeChannel(['go']);
      const toolBus = makeToolBus([TOOL_RESULT]);

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        overflowConfig,
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(sendSpy.mock.calls[0]?.[0]).toContain('170,000');
      expect(sendSpy.mock.calls[0]?.[0]).toContain('200,000');
    });

    it('compacts when total tokens exceed threshold even if injected estimate suppresses l1 fraction', async () => {
      // input_tokens = 170_000, totalFraction = 0.85 > 0.8 (absolute check triggers).
      // injectedTokenEstimate = estimateTokens({role:'user', content:'a'.repeat(40_000)})
      //   = ceil(JSON.stringify('a'.repeat(40_000)).length / 4) = ceil(40_002 / 4) = 10_001.
      // l1Tokens = 170_000 - 10_001 = 159_999, l1Fraction = 0.7999 < 0.8 (relative check would miss it).
      const toolUse = makeToolUseResponseWithTokens([TOOL_CALL], 170_000);
      const final = makeTextResponse('done');

      const { client } = makeClient([toolUse, final]);
      const { channel } = makeChannel(['go']);
      const toolBus = makeToolBus([TOOL_RESULT]);

      const compactSpy = vi
        .fn()
        .mockImplementation(async (msgs: Anthropic.MessageParam[]) => [
          { role: 'user' as const, content: '[compacted]' },
          ...msgs.slice(-2),
        ]);
      const mockMemoryManager = {
        // Single injected message whose content is 40_000 chars → estimateTokens = 10_001
        assembleInjectedHistory: vi
          .fn()
          .mockResolvedValue([{ role: 'user' as const, content: 'a'.repeat(40_000) }]),
        compact: compactSpy,
      };

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeOverflowConfig(),
        undefined,
        noopSleep,
        undefined,
        undefined,
        undefined,
        undefined,
        mockMemoryManager as unknown as import('../memory/memory-manager').MemoryManager,
      );
      await agent.run();

      expect(compactSpy).toHaveBeenCalledOnce();
    });

    it('compacts reactively when API returns exceed_context_size_error on a subsequent call', async () => {
      // First call: tool use with low token count (no threshold compaction).
      // l1 grows to [user, assistant(tool_use), user(tool_result)] = 3 messages.
      // Second call: exceed_context_size_error — agent compacts l1 (keepRecentMessages=2) and retries.
      // Third call: success after compaction.
      const toolUse = makeToolUseResponseWithTokens([TOOL_CALL], 10);
      const exceedErr = makeExceedContextSizeError();
      const final = makeTextResponse('recovered');

      const { client, createSpy } = makeClient([toolUse, exceedErr, final]);
      const { channel, sendSpy } = makeChannel(['go']);
      const toolBus = makeToolBus([TOOL_RESULT]);

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeOverflowConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).toHaveBeenCalledTimes(3);
      expect(sendSpy).toHaveBeenCalledWith('recovered');
    });

    it('surfaces error when reactive compaction cannot reduce context further after exceed_context_size_error', async () => {
      // keepRecentMessages=10 with only the initial user message in l1 (1 <= 10) → compactMessages returns null.
      const overflowConfig = {
        ...makeConfig(),
        memory: { ...makeConfig().memory, keepRecentMessages: 10 },
      };
      const exceedErr = makeExceedContextSizeError();

      const { client, createSpy } = makeClient([exceedErr]);
      const { channel, sendSpy } = makeChannel(['go']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        overflowConfig,
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).toHaveBeenCalledOnce();
      expect(sendSpy.mock.calls[0]?.[0]).toMatch(/Context window exceeded/);
    });
  });

  // ---------------------------------------------------------------------------
  // Session store persistence
  // ---------------------------------------------------------------------------

  describe('session store persistence', () => {
    function makeSessionStore() {
      return { append: vi.fn().mockResolvedValue(undefined) };
    }

    it('writes a user entry before the first LLM call', async () => {
      const { client } = makeClient([makeTextResponse('hi')]);
      const { channel } = makeChannel(['hello']);
      const toolBus = makeToolBus();
      const store = makeSessionStore();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        makeCtx(),
        makeConfig(),
        undefined,
        noopSleep,
        createNoopLogger(),
        undefined,
        store as never,
      );
      await agent.run();

      const calls = store.append.mock.calls as Array<[{ role: string; content: unknown }]>;
      const userEntries = calls.filter(([e]) => e.role === 'user');
      expect(userEntries.length).toBeGreaterThanOrEqual(1);
      expect(userEntries[0]?.[0].content).toBe('hello');
    });

    it('writes an assistant entry for the final text response', async () => {
      const { client } = makeClient([makeTextResponse('world')]);
      const { channel } = makeChannel(['hello']);
      const toolBus = makeToolBus();
      const store = makeSessionStore();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        makeCtx(),
        makeConfig(),
        undefined,
        noopSleep,
        createNoopLogger(),
        undefined,
        store as never,
      );
      await agent.run();

      const calls = store.append.mock.calls as Array<[{ role: string; content: unknown }]>;
      const assistantEntries = calls.filter(([e]) => e.role === 'assistant');
      expect(assistantEntries.length).toBeGreaterThanOrEqual(1);
      expect(assistantEntries[0]?.[0].content).toBe('world');
    });

    it('writes tool_call and tool_result entries during a tool-use turn', async () => {
      const toolCall = { id: 'tc1', name: 'bash', input: { command: 'ls' } };
      const toolResult = { id: 'tc1', content: 'file.txt', is_error: false };
      const { client } = makeClient([makeToolUseResponse([toolCall]), makeTextResponse('done')]);
      const { channel } = makeChannel(['run']);
      const toolBus = makeToolBus([toolResult]);
      const store = makeSessionStore();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        makeCtx(),
        makeConfig(),
        undefined,
        noopSleep,
        createNoopLogger(),
        undefined,
        store as never,
      );
      await agent.run();

      const calls = store.append.mock.calls as Array<[{ role: string }]>;
      const roles = calls.map(([e]) => e.role);
      expect(roles).toContain('tool_call');
      expect(roles).toContain('tool_result');
    });

    it('stamps all entries with the same sessionId', async () => {
      const { client } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hello']);
      const toolBus = makeToolBus();
      const store = makeSessionStore();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        makeCtx(),
        makeConfig(),
        undefined,
        noopSleep,
        createNoopLogger(),
        undefined,
        store as never,
      );
      await agent.run();

      const calls = store.append.mock.calls as Array<[{ sessionId: string }]>;
      const sessionIds = new Set(calls.map(([e]) => e.sessionId));
      expect(sessionIds.size).toBe(1);
      expect([...sessionIds][0]).toBeTruthy();
    });

    it('uses the provided initialSessionId when resuming', async () => {
      const { client } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hello']);
      const toolBus = makeToolBus();
      const store = makeSessionStore();
      const resumedId = 'my-resumed-session-id';

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        makeCtx(),
        makeConfig(),
        undefined,
        noopSleep,
        createNoopLogger(),
        undefined,
        store as never,
        resumedId,
      );
      await agent.run();

      const calls = store.append.mock.calls as Array<[{ sessionId: string }]>;
      expect(calls.every(([e]) => e.sessionId === resumedId)).toBe(true);
    });

    it('does not throw when no session store is provided', async () => {
      const { client } = makeClient([makeTextResponse('ok')]);
      const { channel, sendSpy } = makeChannel(['hello']);
      const toolBus = makeToolBus();

      // No session store — should work exactly as before
      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        makeCtx(),
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(sendSpy).toHaveBeenCalledWith('ok');
    });

    it('stamps entries with activeTaskId from ToolContext when set', async () => {
      const { client } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hello']);
      const toolBus = makeToolBus();
      const store = makeSessionStore();
      const ctx = makeCtx();
      ctx.activeTaskId = 'task-42';

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
        createNoopLogger(),
        store as never,
      );
      await agent.run();

      const calls = store.append.mock.calls as Array<[{ taskId?: string }]>;
      expect(calls.every(([e]) => e.taskId === 'task-42')).toBe(true);
    });

    it('stamps entries with undefined taskId when no active task', async () => {
      const { client } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['hello']);
      const toolBus = makeToolBus();
      const store = makeSessionStore();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        makeCtx(),
        makeConfig(),
        undefined,
        noopSleep,
        createNoopLogger(),
        store as never,
      );
      await agent.run();

      const calls = store.append.mock.calls as Array<[{ taskId?: string }]>;
      expect(calls.every(([e]) => e.taskId === undefined)).toBe(true);
    });
  });

  // ── slash commands ────────────────────────────────────────────────────────

  describe('slash command handling', () => {
    it('/exit terminates the loop without calling the LLM', async () => {
      const { client, createSpy } = makeClient([]);
      const { channel, sendSpy } = makeChannel(['/exit']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).not.toHaveBeenCalled();
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it('normal message after /exit is never processed', async () => {
      const { client, createSpy } = makeClient([makeTextResponse('ok')]);
      const { channel } = makeChannel(['/exit', 'hello']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).not.toHaveBeenCalled();
    });

    it('/help sends a list of commands without calling the LLM', async () => {
      const { client, createSpy } = makeClient([]);
      const { channel, sendSpy } = makeChannel(['/help', '/exit']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).not.toHaveBeenCalled();
      expect(sendSpy).toHaveBeenCalledOnce();
      const msg = (sendSpy.mock.calls[0] as unknown[])[0] as string;
      expect(msg).toContain('/exit');
    });

    it('non-slash messages are still forwarded to the LLM', async () => {
      const { client, createSpy } = makeClient([makeTextResponse('hello back')]);
      const { channel } = makeChannel(['hello', '/exit']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      expect(createSpy).toHaveBeenCalledOnce();
    });
  });

  // ── L1 session context continuity ─────────────────────────────────────────

  describe('L1 session context continuity', () => {
    it('second turn includes first turn user message and assistant response', async () => {
      // Two sequential user turns. The second API call for turn 2 must contain
      // the full conversation from turn 1 so the model has context.
      const { client, createSpy } = makeClient([
        makeTextResponse('answer to hello'),
        makeTextResponse('answer to world'),
      ]);
      const { channel } = makeChannel(['hello', 'world']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      // Turn 1: API call 0 with [user:hello]
      // Turn 2: API call 1 with [user:hello, assistant:answer, user:world]
      const turn2Arg = createSpy.mock.calls[1]?.[0] as { messages: Anthropic.MessageParam[] };
      expect(turn2Arg.messages).toHaveLength(3);
      expect(turn2Arg.messages[0]).toMatchObject({ role: 'user', content: 'hello' });
      expect(turn2Arg.messages[1]).toMatchObject({ role: 'assistant', content: 'answer to hello' });
      expect(turn2Arg.messages[2]).toMatchObject({ role: 'user', content: 'world' });
    });

    it('L1 grows correctly across three turns', async () => {
      const { client, createSpy } = makeClient([
        makeTextResponse('reply 1'),
        makeTextResponse('reply 2'),
        makeTextResponse('reply 3'),
      ]);
      const { channel } = makeChannel(['msg1', 'msg2', 'msg3']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
      );
      await agent.run();

      // Turn 3 API call should include all prior context: 5 messages
      // [user:msg1, assistant:reply1, user:msg2, assistant:reply2, user:msg3]
      const turn3Arg = createSpy.mock.calls[2]?.[0] as { messages: Anthropic.MessageParam[] };
      expect(turn3Arg.messages).toHaveLength(5);
      expect(turn3Arg.messages[4]).toMatchObject({ role: 'user', content: 'msg3' });
    });

    it('assembleInjectedHistory is called once at session start, not on every turn', async () => {
      const assembleSpyFn = vi.fn().mockResolvedValue([]);
      const mockMemoryManager = {
        assembleInjectedHistory: assembleSpyFn,
        compact: vi.fn().mockResolvedValue(null),
      };

      const { client } = makeClient([
        makeTextResponse('r1'),
        makeTextResponse('r2'),
        makeTextResponse('r3'),
      ]);
      const { channel } = makeChannel(['a', 'b', 'c']);
      const toolBus = makeToolBus();

      const agent = new AgentCore(
        client,
        channel,
        toolBus,
        ctx,
        makeConfig(),
        undefined,
        noopSleep,
        undefined,
        undefined,
        undefined,
        undefined,
        mockMemoryManager as unknown as import('../memory/memory-manager').MemoryManager,
      );
      await agent.run();

      // Three user turns, but assembleInjectedHistory should only be called once.
      expect(assembleSpyFn).toHaveBeenCalledOnce();
    });
  });
});
