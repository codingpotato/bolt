import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, createNoopLogger, createTraceLogger, createNoopTraceLogger } from './logger';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
}));

import * as fsPromises from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOG_PATH = '/tmp/test-bolt.log';
const LOG_DIR = '/tmp';

/** Flush the microtask queue so fire-and-forget promises settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Parse the first JSON line passed to appendFile. */
function lastEntry(): Record<string, unknown> {
  const calls = vi.mocked(fsPromises.appendFile).mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('appendFile was not called');
  return JSON.parse(last[1] as string) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createLogger', () => {
  beforeEach(() => {
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsPromises.appendFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── entry format ──────────────────────────────────────────────────────────

  describe('log entry format', () => {
    it('writes a JSON line ending with \\n to the configured file path', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('hello');
      await flush();

      expect(fsPromises.appendFile).toHaveBeenCalledOnce();
      const [path, content] = vi.mocked(fsPromises.appendFile).mock.calls[0]!;
      expect(path).toBe(LOG_PATH);
      expect((content as string).endsWith('\n')).toBe(true);
    });

    it('entry is valid JSON', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('hello');
      await flush();

      const [, content] = vi.mocked(fsPromises.appendFile).mock.calls[0]!;
      expect(() => JSON.parse(content as string)).not.toThrow();
    });

    it('entry contains ts, level, and message fields', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.warn('something happened');
      await flush();

      const entry = lastEntry();
      expect(entry).toHaveProperty('ts');
      expect(entry).toHaveProperty('level');
      expect(entry).toHaveProperty('message');
    });

    it('ts is a valid ISO 8601 timestamp', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('time check');
      await flush();

      const entry = lastEntry();
      const ts = entry['ts'] as string;
      expect(new Date(ts).toISOString()).toBe(ts);
    });

    it('level field matches the method called', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.warn('test warn');
      await flush();

      expect(lastEntry()['level']).toBe('warn');
    });

    it('message field contains the supplied message', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('my message');
      await flush();

      expect(lastEntry()['message']).toBe('my message');
    });

    it('meta fields are spread into the entry at the top level', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('request sent', { requestId: 'abc-123', model: 'claude-test' });
      await flush();

      const entry = lastEntry();
      expect(entry['requestId']).toBe('abc-123');
      expect(entry['model']).toBe('claude-test');
    });

    it('entry without meta has only ts, level, and message', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.debug('bare message');
      await flush();

      const entry = lastEntry();
      expect(Object.keys(entry).sort()).toEqual(['level', 'message', 'ts'].sort());
    });
  });

  // ── level filtering ───────────────────────────────────────────────────────

  describe('level filtering', () => {
    it('drops entries below the configured level', async () => {
      const logger = createLogger('warn', LOG_PATH);
      logger.debug('too low');
      logger.info('also too low');
      await flush();

      expect(fsPromises.appendFile).not.toHaveBeenCalled();
    });

    it('writes entries at the configured level', async () => {
      const logger = createLogger('warn', LOG_PATH);
      logger.warn('exactly at threshold');
      await flush();

      expect(fsPromises.appendFile).toHaveBeenCalledOnce();
    });

    it('writes entries above the configured level', async () => {
      const logger = createLogger('warn', LOG_PATH);
      logger.error('above threshold');
      await flush();

      expect(fsPromises.appendFile).toHaveBeenCalledOnce();
    });

    it('debug logger writes all four levels', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      await flush();

      expect(fsPromises.appendFile).toHaveBeenCalledTimes(4);
    });

    it('error logger only writes error entries', async () => {
      const logger = createLogger('error', LOG_PATH);
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      await flush();

      expect(fsPromises.appendFile).toHaveBeenCalledTimes(1);
      expect(lastEntry()['level']).toBe('error');
    });

    it('each level method writes the correct level string', async () => {
      const logger = createLogger('debug', LOG_PATH);
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        vi.mocked(fsPromises.appendFile).mockClear();
        logger[level](`${level} message`);
        await flush();
        expect(lastEntry()['level']).toBe(level);
      }
    });
  });

  // ── metadata formatting ───────────────────────────────────────────────────

  describe('metadata formatting in stderr', () => {
    let stderrSpy: { mockRestore(): void; mock: { calls: unknown[][] } };

    beforeEach(() => {
      stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true) as unknown as typeof stderrSpy;
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it('formats empty objects as {}', () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.debug('test', { empty: {} });
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('empty={}');
    });

    it('formats non-empty objects as stringified JSON', () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.debug('test', { data: { key: 'value' } });
      const output = String(stderrSpy.mock.calls[0]![0]);
      expect(output).toContain('data=');
      expect(output).toContain('key');
    });

    it('formats arrays as stringified JSON', () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.debug('test', { items: [1, 2, 3] });
      const output = String(stderrSpy.mock.calls[0]![0]);
      expect(output).toContain('items=');
      expect(output).toContain('[');
    });

    it('formats numbers correctly', () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.debug('test', { count: 42 });
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('count=42');
    });

    it('formats booleans correctly', () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.debug('test', { enabled: true });
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('enabled=true');
    });
  });

  // ── stderr routing ────────────────────────────────────────────────────────

  describe('stderr routing', () => {
    let stderrSpy: { mockRestore(): void; mock: { calls: unknown[][] } };

    beforeEach(() => {
      stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true) as unknown as typeof stderrSpy;
    });

    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it('error-level entries write to stderr', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.error('something broke');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('something broke');
    });

    it('stderr output includes the [bolt] ERROR prefix in production mode', async () => {
      const logger = createLogger('info', LOG_PATH);
      logger.error('boom');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('[bolt] ERROR:');
    });

    it('debug entries write pretty output to stderr in debug mode', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.debug('quiet');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('DBG');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('quiet');
    });

    it('info entries write pretty output to stderr in debug mode', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('informational');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('INF');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('informational');
    });

    it('warn entries write pretty output to stderr in debug mode', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.warn('warning');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('WRN');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('warning');
    });

    it('production mode only writes error to stderr', async () => {
      const logger = createLogger('info', LOG_PATH);
      logger.debug('quiet');
      logger.info('informational');
      logger.warn('warning');
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  // ── directory creation ────────────────────────────────────────────────────

  describe('directory creation', () => {
    it('creates the log directory on the first write', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('first write');
      await flush();

      expect(fsPromises.mkdir).toHaveBeenCalledOnce();
      expect(fsPromises.mkdir).toHaveBeenCalledWith(LOG_DIR, { recursive: true });
    });

    it('creates the directory only once across multiple writes', async () => {
      const logger = createLogger('debug', LOG_PATH);
      logger.info('a');
      logger.info('b');
      logger.info('c');
      await flush();

      expect(fsPromises.mkdir).toHaveBeenCalledOnce();
    });

    it('does not create the directory when all entries are filtered out', async () => {
      const logger = createLogger('error', LOG_PATH);
      logger.debug('filtered');
      await flush();

      expect(fsPromises.mkdir).not.toHaveBeenCalled();
    });
  });

  // ── error resilience ──────────────────────────────────────────────────────

  describe('error resilience', () => {
    it('swallows file write errors without throwing to the caller', async () => {
      vi.mocked(fsPromises.appendFile).mockRejectedValue(new Error('disk full'));
      const logger = createLogger('debug', LOG_PATH);

      // Should not throw — fire-and-forget
      expect(() => logger.info('test')).not.toThrow();
      await flush(); // let the promise settle
    });

    it('swallows mkdir errors without throwing to the caller', async () => {
      vi.mocked(fsPromises.mkdir).mockRejectedValue(new Error('permission denied'));
      const logger = createLogger('debug', LOG_PATH);

      expect(() => logger.info('test')).not.toThrow();
      await flush();
    });
  });
});

// ---------------------------------------------------------------------------

describe('createNoopLogger', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('never calls appendFile', async () => {
    const logger = createNoopLogger();
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    await flush();

    expect(fsPromises.appendFile).not.toHaveBeenCalled();
  });

  it('all four methods are callable without throwing', () => {
    const logger = createNoopLogger();
    expect(() => {
      logger.debug('d', { x: 1 });
      logger.info('i', { x: 1 });
      logger.warn('w', { x: 1 });
      logger.error('e', { x: 1 });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('createTraceLogger', () => {
  let stderrSpy: { mockRestore(): void; mock: { calls: unknown[][] } };

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true) as unknown as typeof stderrSpy;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.clearAllMocks();
  });

  describe('systemPrompt', () => {
    it('writes bordered block to stderr with SYSTEM PROMPT title', () => {
      const logger = createTraceLogger();
      logger.systemPrompt('sample prompt content', {
        model: 'claude-test',
        chars: 1000,
        tokens: 200,
        base: { chars: 500, tokens: 100 },
        skills: { chars: 300, tokens: 60, count: 3 },
        tools: { chars: 200, tokens: 40, count: 5 },
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('SYSTEM PROMPT');
      expect(output).toContain('╔══');
      expect(output).toContain('╚═');
    });

    it('includes model, chars, and tokens in header line', () => {
      const logger = createTraceLogger();
      logger.systemPrompt('prompt', {
        model: 'gpt-4',
        chars: 5000,
        tokens: 1200,
        base: { chars: 2000, tokens: 500 },
        skills: { chars: 2000, tokens: 400, count: 5 },
        tools: { chars: 1000, tokens: 300, count: 10 },
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('model=gpt-4');
      expect(output).toContain('chars=5000');
      expect(output).toContain('tokens=1200');
    });

    it('includes base/skills/tools breakdown', () => {
      const logger = createTraceLogger();
      logger.systemPrompt('prompt', {
        model: 'test',
        chars: 1000,
        tokens: 100,
        base: { chars: 400, tokens: 80 },
        skills: { chars: 300, tokens: 15, count: 3 },
        tools: { chars: 300, tokens: 5, count: 7 },
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('base=400ch/80tok');
      expect(output).toContain('skills=3×300ch/15tok');
      expect(output).toContain('tools=7×300ch/5tok');
    });

    it('includes the prompt content', () => {
      const logger = createTraceLogger();
      const content = 'You are a helpful assistant.';
      logger.systemPrompt(content, {
        model: 'test',
        chars: 28,
        tokens: 5,
        base: { chars: 28, tokens: 5 },
        skills: { chars: 0, tokens: 0, count: 0 },
        tools: { chars: 0, tokens: 0, count: 0 },
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain(content);
    });

    it('truncates content to 60 lines', () => {
      const logger = createTraceLogger();
      const lines = Array(100)
        .fill(null)
        .map((_, i) => `line ${i}`);
      const content = lines.join('\n');

      logger.systemPrompt(content, {
        model: 'test',
        chars: content.length,
        tokens: 100,
        base: { chars: content.length, tokens: 100 },
        skills: { chars: 0, tokens: 0, count: 0 },
        tools: { chars: 0, tokens: 0, count: 0 },
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      // Should contain lines from the start but not all 100 lines
      expect(output).toContain('line 0');
      expect(output).not.toContain('line 99');
    });
  });

  describe('llmRequest', () => {
    it('writes bordered block to stderr with LLM REQUEST title', () => {
      const logger = createTraceLogger();
      logger.llmRequest('User message', {
        model: 'claude-test',
        messages: 3,
        tools: 5,
        systemTokens: 600,
        ctxTokens: 400,
        windowCapacity: 200000,
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('LLM REQUEST');
      expect(output).toContain('╔══');
      expect(output).toContain('╚═');
    });

    it('includes model, messages, tools, and window usage', () => {
      const logger = createTraceLogger();
      logger.llmRequest('msg', {
        model: 'test-model',
        messages: 5,
        tools: 12,
        systemTokens: 700,
        ctxTokens: 1000,
        windowCapacity: 200000,
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('model=test-model');
      expect(output).toContain('messages=5');
      expect(output).toContain('tools=12');
      expect(output).toContain('window=1000 / 200000 (0.5%)');
    });

    it('shows system and context tokens separately', () => {
      const logger = createTraceLogger();
      logger.llmRequest('msg', {
        model: 'test',
        messages: 2,
        tools: 3,
        systemTokens: 1000,
        ctxTokens: 800,
        windowCapacity: 200000,
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('system=1000tok');
      expect(output).toContain('context=800tok');
    });

    it('includes the last message content', () => {
      const logger = createTraceLogger();
      const lastMsg = '{"role":"user","content":"What should I write?"}';
      logger.llmRequest(lastMsg, {
        model: 'test',
        messages: 2,
        tools: 1,
        systemTokens: 100,
        ctxTokens: 200,
        windowCapacity: 200000,
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('role');
      expect(output).toContain('user');
    });
  });

  describe('llmResponse', () => {
    it('writes bordered block to stderr with LLM RESPONSE title', () => {
      const logger = createTraceLogger();
      logger.llmResponse('Here is the response.', {
        model: 'claude-test',
        inputTokens: 500,
        outputTokens: 250,
        stopReason: 'end_turn',
        windowCapacity: 200000,
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('LLM RESPONSE');
      expect(output).toContain('╔══');
      expect(output).toContain('╚═');
    });

    it('includes model and token information', () => {
      const logger = createTraceLogger();
      logger.llmResponse('response text', {
        model: 'gpt-test',
        inputTokens: 800,
        outputTokens: 300,
        stopReason: 'end_turn',
        windowCapacity: 200000,
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('model=gpt-test');
      expect(output).toContain('inputTokens=800 / 200000 (0.4%)');
      expect(output).toContain('outputTokens=300');
      expect(output).toContain('stopReason=end_turn');
    });

    it('calculates window percentage correctly', () => {
      const logger = createTraceLogger();
      logger.llmResponse('text', {
        model: 'test',
        inputTokens: 1000,
        outputTokens: 100,
        stopReason: 'max_tokens',
        windowCapacity: 200000,
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      // 1000 / 200000 = 0.5%
      expect(output).toContain('0.5%');
    });

    it('includes the response content', () => {
      const logger = createTraceLogger();
      const content = 'Here is my response to your question.';
      logger.llmResponse(content, {
        model: 'test',
        inputTokens: 100,
        outputTokens: 50,
        stopReason: 'end_turn',
        windowCapacity: 200000,
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain(content);
    });

    it('truncates content to 60 lines', () => {
      const logger = createTraceLogger();
      const lines = Array(100)
        .fill(null)
        .map((_, i) => `response line ${i}`);
      const content = lines.join('\n');

      logger.llmResponse(content, {
        model: 'test',
        inputTokens: 200,
        outputTokens: 100,
        stopReason: 'end_turn',
        windowCapacity: 200000,
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('response line 0');
      expect(output).not.toContain('response line 99');
    });
  });

  describe('border and formatting', () => {
    it('draws proper top border with ╔ and ╗', () => {
      const logger = createTraceLogger();
      logger.systemPrompt('content', {
        model: 'test',
        chars: 100,
        tokens: 20,
        base: { chars: 100, tokens: 20 },
        skills: { chars: 0, tokens: 0, count: 0 },
        tools: { chars: 0, tokens: 0, count: 0 },
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('╔══');
      expect(output).toContain('╗');
    });

    it('draws proper bottom border with ╚ and ═', () => {
      const logger = createTraceLogger();
      logger.llmRequest('msg', {
        model: 'test',
        messages: 1,
        tools: 0,
        systemTokens: 100,
        ctxTokens: 50,
        windowCapacity: 200000,
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('╚═');
      expect(output).toContain('╝');
    });

    it('draws proper divider with ╟ and ─ and ╢', () => {
      const logger = createTraceLogger();
      logger.llmResponse('text', {
        model: 'test',
        inputTokens: 100,
        outputTokens: 50,
        stopReason: 'end_turn',
        windowCapacity: 200000,
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('╟─');
      expect(output).toContain('╢');
    });

    it('uses ║ for vertical borders on content lines', () => {
      const logger = createTraceLogger();
      logger.systemPrompt('test content\nline 2', {
        model: 'test',
        chars: 25,
        tokens: 5,
        base: { chars: 25, tokens: 5 },
        skills: { chars: 0, tokens: 0, count: 0 },
        tools: { chars: 0, tokens: 0, count: 0 },
      });

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      // Should have multiple lines with ║
      const lines = output.split('\n');
      const borderLines = lines.filter((line) => line.includes('║'));
      expect(borderLines.length).toBeGreaterThan(2);
    });
  });
});

// ---------------------------------------------------------------------------

describe('createNoopTraceLogger', () => {
  let stderrSpy: { mockRestore(): void; mock: { calls: unknown[][] } };

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true) as unknown as typeof stderrSpy;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('never writes to stderr', () => {
    const logger = createNoopTraceLogger();
    logger.systemPrompt('prompt', {
      model: 'test',
      chars: 100,
      tokens: 20,
      base: { chars: 100, tokens: 20 },
      skills: { chars: 0, tokens: 0, count: 0 },
      tools: { chars: 0, tokens: 0, count: 0 },
    });
    logger.llmRequest('msg', {
      model: 'test',
      messages: 1,
      tools: 0,
      systemTokens: 100,
      ctxTokens: 50,
      windowCapacity: 200000,
    });
    logger.llmResponse('response', {
      model: 'test',
      inputTokens: 100,
      outputTokens: 50,
      stopReason: 'end_turn',
      windowCapacity: 200000,
    });

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('all three methods are callable without throwing', () => {
    const logger = createNoopTraceLogger();
    expect(() => {
      logger.systemPrompt('p', {
        model: 't',
        chars: 1,
        tokens: 1,
        base: { chars: 1, tokens: 1 },
        skills: { chars: 0, tokens: 0, count: 0 },
        tools: { chars: 0, tokens: 0, count: 0 },
      });
      logger.llmRequest('m', {
        model: 't',
        messages: 1,
        tools: 0,
        systemTokens: 1,
        ctxTokens: 1,
        windowCapacity: 1,
      });
      logger.llmResponse('r', {
        model: 't',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end_turn',
        windowCapacity: 1,
      });
    }).not.toThrow();
  });
});
