import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTraceLogger, createNoopTraceLogger } from './trace-logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type StderrSpy = { mockRestore(): void; mock: { calls: unknown[][] } };

function capturedOutput(spy: StderrSpy): string {
  return (spy.mock.calls as [string][]).map(([s]) => s).join('');
}

// Strip ANSI escape sequences so assertions don't depend on colour codes.
function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeStderrSpy(): StderrSpy {
  return vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(() => true) as unknown as StderrSpy;
}

// ---------------------------------------------------------------------------
// createTraceLogger
// ---------------------------------------------------------------------------

describe('createTraceLogger', () => {
  let spy: StderrSpy;

  beforeEach(() => {
    spy = makeStderrSpy();
  });

  afterEach(() => {
    spy.mockRestore();
  });

  // ── systemPrompt ───────────────────────────────────────────────────────────

  describe('systemPrompt()', () => {
    it('writes to stderr', () => {
      const logger = createTraceLogger();
      logger.systemPrompt('You are bolt.', 'claude-opus-4-6');
      expect(spy).toHaveBeenCalled();
    });

    it('output contains SYSTEM PROMPT header', () => {
      const logger = createTraceLogger();
      logger.systemPrompt('You are bolt.', 'claude-opus-4-6');
      expect(strip(capturedOutput(spy))).toContain('SYSTEM PROMPT');
    });

    it('output contains the model name', () => {
      const logger = createTraceLogger();
      logger.systemPrompt('You are bolt.', 'claude-opus-4-6');
      expect(strip(capturedOutput(spy))).toContain('claude-opus-4-6');
    });

    it('output contains the prompt length', () => {
      const logger = createTraceLogger();
      const prompt = 'You are bolt.';
      logger.systemPrompt(prompt, 'claude-opus-4-6');
      expect(strip(capturedOutput(spy))).toContain(`length=${prompt.length}`);
    });

    it('output contains the prompt text', () => {
      const logger = createTraceLogger();
      logger.systemPrompt('You are bolt.', 'claude-opus-4-6');
      expect(strip(capturedOutput(spy))).toContain('You are bolt.');
    });

    it('truncates a very long prompt to maxBodyLines', () => {
      const logger = createTraceLogger();
      const longPrompt = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
      logger.systemPrompt(longPrompt, 'model');
      expect(strip(capturedOutput(spy))).toContain('(truncated)');
    });

    it('output contains box-drawing border characters', () => {
      const logger = createTraceLogger();
      logger.systemPrompt('test', 'model');
      const out = strip(capturedOutput(spy));
      expect(out).toContain('╔');
      expect(out).toContain('╚');
    });
  });

  // ── llmRequest ─────────────────────────────────────────────────────────────

  describe('llmRequest()', () => {
    it('writes to stderr', () => {
      const logger = createTraceLogger();
      logger.llmRequest([{ role: 'user', content: 'Hello' }], 'claude-opus-4-6');
      expect(spy).toHaveBeenCalled();
    });

    it('output contains LLM REQUEST header', () => {
      const logger = createTraceLogger();
      logger.llmRequest([{ role: 'user', content: 'Hello' }], 'claude-opus-4-6');
      expect(strip(capturedOutput(spy))).toContain('LLM REQUEST');
    });

    it('output contains model name', () => {
      const logger = createTraceLogger();
      logger.llmRequest([{ role: 'user', content: 'Hello' }], 'claude-opus-4-6');
      expect(strip(capturedOutput(spy))).toContain('claude-opus-4-6');
    });

    it('output contains message count', () => {
      const logger = createTraceLogger();
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ];
      logger.llmRequest(messages, 'model');
      expect(strip(capturedOutput(spy))).toContain('messages=2');
    });

    it('shows tool count when tools are provided', () => {
      const logger = createTraceLogger();
      logger.llmRequest([{ role: 'user', content: 'Hi' }], 'model', [1, 2, 3]);
      expect(strip(capturedOutput(spy))).toContain('tools=3');
    });

    it('shows tools=0 when no tools provided', () => {
      const logger = createTraceLogger();
      logger.llmRequest([{ role: 'user', content: 'Hi' }], 'model');
      expect(strip(capturedOutput(spy))).toContain('tools=0');
    });

    it('shows the last message content', () => {
      const logger = createTraceLogger();
      logger.llmRequest([{ role: 'user', content: 'What is the weather?' }], 'model');
      expect(strip(capturedOutput(spy))).toContain('What is the weather?');
    });

    it('shows the last message role', () => {
      const logger = createTraceLogger();
      logger.llmRequest([{ role: 'assistant', content: 'I can help.' }], 'model');
      expect(strip(capturedOutput(spy))).toContain('[assistant]');
    });

    it('handles an empty messages array without throwing', () => {
      const logger = createTraceLogger();
      expect(() => logger.llmRequest([], 'model')).not.toThrow();
    });

    it('renders content blocks in the last message', () => {
      const logger = createTraceLogger();
      const messages = [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'id1', content: 'result text' }],
        },
      ];
      logger.llmRequest(messages, 'model');
      expect(strip(capturedOutput(spy))).toContain('tool_result');
    });
  });

  // ── llmResponse ────────────────────────────────────────────────────────────

  describe('llmResponse()', () => {
    it('writes to stderr', () => {
      const logger = createTraceLogger();
      logger.llmResponse({
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'text', text: 'Hello!' }],
      });
      expect(spy).toHaveBeenCalled();
    });

    it('output contains LLM RESPONSE header', () => {
      const logger = createTraceLogger();
      logger.llmResponse({ stop_reason: 'end_turn', usage: {}, content: [] });
      expect(strip(capturedOutput(spy))).toContain('LLM RESPONSE');
    });

    it('output contains stop_reason', () => {
      const logger = createTraceLogger();
      logger.llmResponse({ stop_reason: 'tool_use', usage: {}, content: [] });
      expect(strip(capturedOutput(spy))).toContain('stop=tool_use');
    });

    it('output contains token counts', () => {
      const logger = createTraceLogger();
      logger.llmResponse({
        stop_reason: 'end_turn',
        usage: { input_tokens: 1240, output_tokens: 312 },
        content: [],
      });
      const out = strip(capturedOutput(spy));
      expect(out).toContain('in=1240');
      expect(out).toContain('out=312');
    });

    it('output contains text block content', () => {
      const logger = createTraceLogger();
      logger.llmResponse({
        stop_reason: 'end_turn',
        usage: {},
        content: [{ type: 'text', text: 'Here is my answer.' }],
      });
      expect(strip(capturedOutput(spy))).toContain('Here is my answer.');
    });

    it('output contains tool_use block name and input', () => {
      const logger = createTraceLogger();
      logger.llmResponse({
        stop_reason: 'tool_use',
        usage: {},
        content: [{ type: 'tool_use', name: 'bash', input: { command: 'ls' } }],
      });
      const out = strip(capturedOutput(spy));
      expect(out).toContain('bash');
      expect(out).toContain('ls');
    });

    it('handles missing fields without throwing', () => {
      const logger = createTraceLogger();
      expect(() => logger.llmResponse({})).not.toThrow();
    });
  });

  // ── toolCall ───────────────────────────────────────────────────────────────

  describe('toolCall()', () => {
    it('writes to stderr', () => {
      const logger = createTraceLogger();
      logger.toolCall('bash', 'toolu_abc', { command: 'ls' });
      expect(spy).toHaveBeenCalled();
    });

    it('output contains TOOL CALL header with tool name', () => {
      const logger = createTraceLogger();
      logger.toolCall('bash', 'toolu_abc', { command: 'ls' });
      expect(strip(capturedOutput(spy))).toContain('TOOL CALL: bash');
    });

    it('output contains the call id', () => {
      const logger = createTraceLogger();
      logger.toolCall('bash', 'toolu_xyz', { command: 'ls' });
      expect(strip(capturedOutput(spy))).toContain('toolu_xyz');
    });

    it('output contains JSON-formatted object input', () => {
      const logger = createTraceLogger();
      logger.toolCall('bash', 'id1', { command: 'echo hello' });
      expect(strip(capturedOutput(spy))).toContain('echo hello');
    });

    it('handles non-object input without throwing', () => {
      const logger = createTraceLogger();
      expect(() => logger.toolCall('bash', 'id1', 'raw string input')).not.toThrow();
    });
  });

  // ── toolResult ─────────────────────────────────────────────────────────────

  describe('toolResult()', () => {
    it('writes to stderr', () => {
      const logger = createTraceLogger();
      logger.toolResult('bash', 'toolu_abc', 'output text');
      expect(spy).toHaveBeenCalled();
    });

    it('success result contains ✓ in header', () => {
      const logger = createTraceLogger();
      logger.toolResult('bash', 'id1', 'ok', false);
      expect(strip(capturedOutput(spy))).toContain('TOOL RESULT ✓: bash');
    });

    it('error result contains ✗ in header', () => {
      const logger = createTraceLogger();
      logger.toolResult('bash', 'id1', 'error msg', true);
      expect(strip(capturedOutput(spy))).toContain('TOOL RESULT ✗: bash');
    });

    it('output contains the result text', () => {
      const logger = createTraceLogger();
      logger.toolResult('bash', 'id1', 'command output here');
      expect(strip(capturedOutput(spy))).toContain('command output here');
    });

    it('output contains the call id', () => {
      const logger = createTraceLogger();
      logger.toolResult('bash', 'toolu_999', 'output');
      expect(strip(capturedOutput(spy))).toContain('toolu_999');
    });

    it('serializes non-string results as JSON', () => {
      const logger = createTraceLogger();
      logger.toolResult('bash', 'id1', { exitCode: 0, stdout: 'hi' });
      expect(strip(capturedOutput(spy))).toContain('exitCode');
    });

    it('defaults isError to false when omitted', () => {
      const logger = createTraceLogger();
      logger.toolResult('bash', 'id1', 'output');
      expect(strip(capturedOutput(spy))).toContain('✓');
    });
  });

  // ── subagentDispatch ───────────────────────────────────────────────────────

  describe('subagentDispatch()', () => {
    it('writes to stderr', () => {
      const logger = createTraceLogger();
      logger.subagentDispatch('Do a task', 'claude-opus-4-6');
      expect(spy).toHaveBeenCalled();
    });

    it('output contains SUBAGENT DISPATCH header', () => {
      const logger = createTraceLogger();
      logger.subagentDispatch('Do a task', 'model');
      expect(strip(capturedOutput(spy))).toContain('SUBAGENT DISPATCH');
    });

    it('output contains model name', () => {
      const logger = createTraceLogger();
      logger.subagentDispatch('Do a task', 'claude-opus-4-6');
      expect(strip(capturedOutput(spy))).toContain('claude-opus-4-6');
    });

    it('output contains allowed tools when provided', () => {
      const logger = createTraceLogger();
      logger.subagentDispatch('Do a task', 'model', ['bash', 'file_read']);
      const out = strip(capturedOutput(spy));
      expect(out).toContain('bash');
      expect(out).toContain('file_read');
    });

    it('shows "all" when no allowed tools specified', () => {
      const logger = createTraceLogger();
      logger.subagentDispatch('Do a task', 'model');
      expect(strip(capturedOutput(spy))).toContain('all');
    });

    it('output contains the prompt text', () => {
      const logger = createTraceLogger();
      logger.subagentDispatch('Write a viral post about AI', 'model');
      expect(strip(capturedOutput(spy))).toContain('Write a viral post about AI');
    });
  });

  // ── subagentResult ─────────────────────────────────────────────────────────

  describe('subagentResult()', () => {
    it('writes to stderr', () => {
      const logger = createTraceLogger();
      logger.subagentResult('Done.', 5000);
      expect(spy).toHaveBeenCalled();
    });

    it('output contains SUBAGENT RESULT header', () => {
      const logger = createTraceLogger();
      logger.subagentResult('Done.', 5000);
      expect(strip(capturedOutput(spy))).toContain('SUBAGENT RESULT');
    });

    it('output contains duration', () => {
      const logger = createTraceLogger();
      logger.subagentResult('Done.', 12345);
      expect(strip(capturedOutput(spy))).toContain('12345ms');
    });

    it('output contains the result text', () => {
      const logger = createTraceLogger();
      logger.subagentResult('Here are the trending topics.', 1000);
      expect(strip(capturedOutput(spy))).toContain('Here are the trending topics.');
    });

    it('output contains output length', () => {
      const logger = createTraceLogger();
      const output = 'Done.';
      logger.subagentResult(output, 1000);
      expect(strip(capturedOutput(spy))).toContain(`length=${output.length}`);
    });
  });

  // ── formatContent branch coverage ──────────────────────────────────────────

  describe('formatContent (via llmRequest)', () => {
    it('handles text content block', () => {
      const logger = createTraceLogger();
      logger.llmRequest(
        [{ role: 'assistant', content: [{ type: 'text', text: 'I will help.' }] }],
        'model',
      );
      expect(strip(capturedOutput(spy))).toContain('I will help.');
    });

    it('handles tool_use content block', () => {
      const logger = createTraceLogger();
      logger.llmRequest(
        [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'bash', input: { command: 'ls' } }],
          },
        ],
        'model',
      );
      const out = strip(capturedOutput(spy));
      expect(out).toContain('tool_use');
      expect(out).toContain('bash');
    });

    it('handles tool_result content block', () => {
      const logger = createTraceLogger();
      logger.llmRequest(
        [
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'id1', content: 'result output' }],
          },
        ],
        'model',
      );
      const out = strip(capturedOutput(spy));
      expect(out).toContain('tool_result');
      expect(out).toContain('id1');
    });

    it('handles unknown content block type via JSON fallback', () => {
      const logger = createTraceLogger();
      logger.llmRequest(
        [{ role: 'user', content: [{ type: 'image', source: { url: 'http://x.com/img.png' } }] }],
        'model',
      );
      expect(strip(capturedOutput(spy))).toContain('image');
    });

    it('handles non-array, non-string content via JSON fallback', () => {
      const logger = createTraceLogger();
      logger.llmRequest([{ role: 'user', content: { unexpected: true } }], 'model');
      expect(spy).toHaveBeenCalled();
    });

    it('handles non-object elements in content array', () => {
      const logger = createTraceLogger();
      logger.llmRequest([{ role: 'user', content: [42, null] }], 'model');
      expect(spy).toHaveBeenCalled();
    });
  });

  // ── drawBlock edge cases ───────────────────────────────────────────────────

  describe('drawBlock (via systemPrompt)', () => {
    it('renders a block with no body without throwing', () => {
      // toolCall with empty object produces minimal body
      const logger = createTraceLogger();
      logger.llmResponse({ stop_reason: 'end_turn', usage: {}, content: [] });
      expect(spy).toHaveBeenCalled();
    });

    it('renders separator only when both meta and body are present', () => {
      const logger = createTraceLogger();
      logger.systemPrompt('body text here', 'model');
      // Should have separator ╟ because meta (model=...) + body (prompt) are both present
      expect(strip(capturedOutput(spy))).toContain('╟');
    });

    it('handles header longer than inner width without throwing', () => {
      const logger = createTraceLogger();
      const veryLongToolName = 'a'.repeat(200);
      expect(() => logger.toolCall(veryLongToolName, 'id', {})).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// createNoopTraceLogger
// ---------------------------------------------------------------------------

describe('createNoopTraceLogger', () => {
  it('all methods are callable without throwing', () => {
    const logger = createNoopTraceLogger();
    expect(() => {
      logger.systemPrompt('prompt', 'model');
      logger.llmRequest([{ role: 'user', content: 'hi' }], 'model', []);
      logger.llmResponse({ stop_reason: 'end_turn', usage: {}, content: [] });
      logger.toolCall('bash', 'id', { command: 'ls' });
      logger.toolResult('bash', 'id', 'output', false);
      logger.subagentDispatch('prompt', 'model', ['bash']);
      logger.subagentResult('output', 1000);
    }).not.toThrow();
  });

  it('never writes to stderr', () => {
    const spy = makeStderrSpy();
    const logger = createNoopTraceLogger();
    logger.systemPrompt('prompt', 'model');
    logger.llmRequest([], 'model');
    logger.llmResponse({});
    logger.toolCall('bash', 'id', {});
    logger.toolResult('bash', 'id', 'output');
    logger.subagentDispatch('prompt', 'model');
    logger.subagentResult('output', 0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
