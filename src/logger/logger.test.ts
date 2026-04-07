import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, createNoopLogger, createTraceLogger, createNoopTraceLogger } from './logger';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wait for fire-and-forget file I/O operations to settle. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

/** Delay for a given number of milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the last JSON line from a log file. */
async function readLastEntry(logPath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const content = await readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return undefined;
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return undefined;
    return JSON.parse(lastLine) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Read all JSON entries from a log file. */
async function readAllEntries(logPath: string): Promise<Record<string, unknown>[]> {
  try {
    const content = await readFile(logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createLogger', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'logger-test-'));
    logPath = join(tempDir, 'test.log');
  });

  // ── entry format ──────────────────────────────────────────────────────────

  describe('log entry format', () => {
    it('writes a JSON line ending with \\n to the configured file path', async () => {
      const logger = createLogger('debug', logPath);
      logger.info('hello');
      await flush();

      const content = await readFile(logPath, 'utf-8');
      expect(content).toBeTruthy();
      expect(content.endsWith('\n')).toBe(true);
    });

    it('entry is valid JSON', async () => {
      const logger = createLogger('debug', logPath);
      logger.info('hello');
      await flush();

      const content = await readFile(logPath, 'utf-8');
      expect(() => JSON.parse(content.trim())).not.toThrow();
    });

    it('entry contains ts, level, and message fields', async () => {
      const logger = createLogger('debug', logPath);
      logger.warn('something happened');
      await flush();

      const entry = await readLastEntry(logPath);
      expect(entry!).toHaveProperty('ts');
      expect(entry!).toHaveProperty('level');
      expect(entry!).toHaveProperty('message');
    });

    it('ts is a valid ISO 8601 timestamp', async () => {
      const logger = createLogger('debug', logPath);
      logger.info('time check');
      await flush();

      const entry = await readLastEntry(logPath);
      const ts = entry!['ts'] as string;
      expect(new Date(ts).toISOString()).toBe(ts);
    });

    it('level field matches the method called', async () => {
      const logger = createLogger('debug', logPath);
      logger.warn('test warn');
      await flush();

      const entry = await readLastEntry(logPath);
      expect(entry!['level']).toBe('warn');
    });

    it('message field contains the supplied message', async () => {
      const logger = createLogger('debug', logPath);
      logger.info('my message');
      await flush();

      const entry = await readLastEntry(logPath);
      expect(entry!['message']).toBe('my message');
    });

    it('meta fields are spread into the entry at the top level', async () => {
      const logger = createLogger('debug', logPath);
      logger.info('request sent', { requestId: 'abc-123', model: 'claude-test' });
      await flush();

      const entry = await readLastEntry(logPath);
      expect(entry!['requestId']).toBe('abc-123');
      expect(entry!['model']).toBe('claude-test');
    });

    it('entry without meta has only ts, level, and message', async () => {
      const logger = createLogger('debug', logPath);
      logger.debug('bare message');
      await flush();

      const entry = await readLastEntry(logPath);
      expect(Object.keys(entry!).sort()).toEqual(['level', 'message', 'ts'].sort());
    });
  });

  // ── level filtering ───────────────────────────────────────────────────────

  describe('level filtering', () => {
    it('drops entries below the configured level', async () => {
      const logger = createLogger('warn', logPath);
      logger.debug('too low');
      logger.info('also too low');
      await flush();

      const entries = await readAllEntries(logPath);
      expect(entries).toHaveLength(0);
    });

    it('writes entries at the configured level', async () => {
      const logger = createLogger('warn', logPath);
      logger.warn('exactly at threshold');
      await flush();

      const entries = await readAllEntries(logPath);
      expect(entries).toHaveLength(1);
    });

    it('writes entries above the configured level', async () => {
      const logger = createLogger('warn', logPath);
      logger.error('above threshold');
      await flush();

      const entries = await readAllEntries(logPath);
      expect(entries).toHaveLength(1);
    });

    it('debug logger writes all four levels', async () => {
      const logger = createLogger('debug', logPath);
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      await flush();

      const entries = await readAllEntries(logPath);
      expect(entries).toHaveLength(4);
    });

    it('error logger only writes error entries', async () => {
      const logger = createLogger('error', logPath);
      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');
      await flush();

      const entries = await readAllEntries(logPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]!['level']).toBe('error');
    });

    it('each level method writes the correct level string', async () => {
      const logger = createLogger('debug', logPath);
      for (const level of ['debug', 'info', 'warn', 'error'] as const) {
        logger[level](`${level} message`);
        await flush();
        const entry = await readLastEntry(logPath);
        expect(entry?.['level']).toBe(level);
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
      const logger = createLogger('debug', logPath);
      logger.debug('test', { empty: {} });
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('empty={}');
    });

    it('formats non-empty objects as stringified JSON', () => {
      const logger = createLogger('debug', logPath);
      logger.debug('test', { data: { key: 'value' } });
      const output = String(stderrSpy.mock.calls[0]![0]);
      expect(output).toContain('data=');
      expect(output).toContain('key');
    });

    it('formats arrays as stringified JSON', () => {
      const logger = createLogger('debug', logPath);
      logger.debug('test', { items: [1, 2, 3] });
      const output = String(stderrSpy.mock.calls[0]![0]);
      expect(output).toContain('items=');
      expect(output).toContain('[');
    });

    it('formats numbers correctly', () => {
      const logger = createLogger('debug', logPath);
      logger.debug('test', { count: 42 });
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('count=42');
    });

    it('formats booleans correctly', () => {
      const logger = createLogger('debug', logPath);
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
      const logger = createLogger('debug', logPath);
      logger.error('something broke');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('something broke');
    });

    it('stderr output includes the [bolt] ERROR prefix in production mode', async () => {
      const logger = createLogger('info', logPath);
      logger.error('boom');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('[bolt] ERROR:');
    });

    it('debug entries write pretty output to stderr in debug mode', async () => {
      const logger = createLogger('debug', logPath);
      logger.debug('quiet');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('DBG');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('quiet');
    });

    it('info entries write pretty output to stderr in debug mode', async () => {
      const logger = createLogger('debug', logPath);
      logger.info('informational');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('INF');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('informational');
    });

    it('warn entries write pretty output to stderr in debug mode', async () => {
      const logger = createLogger('debug', logPath);
      logger.warn('warning');
      expect(stderrSpy).toHaveBeenCalledOnce();
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('WRN');
      expect(String(stderrSpy.mock.calls[0]![0])).toContain('warning');
    });

    it('production mode only writes error to stderr', async () => {
      const logger = createLogger('info', logPath);
      logger.debug('quiet');
      logger.info('informational');
      logger.warn('warning');
      expect(stderrSpy).not.toHaveBeenCalled();
    });
  });

  // ── directory creation ────────────────────────────────────────────────────

  describe('directory creation', () => {
    it('creates the log directory on the first write', async () => {
      const nestedLogPath = join(tempDir, 'nested', 'deep', 'test.log');
      const logger = createLogger('debug', nestedLogPath);
      logger.info('first write');
      await flush();

      const content = await readFile(nestedLogPath, 'utf-8');
      expect(content).toContain('first write');
    });

    it('creates the directory only once across multiple writes', async () => {
      const nestedLogPath = join(tempDir, 'nested', 'test.log');
      const logger = createLogger('debug', nestedLogPath);
      logger.info('a');
      logger.info('b');
      logger.info('c');
      await flush();

      const entries = await readAllEntries(nestedLogPath);
      expect(entries).toHaveLength(3);
    });

    it('does not create the directory when all entries are filtered out', async () => {
      const nestedLogPath = join(tempDir, 'filtered', 'test.log');
      const logger = createLogger('error', nestedLogPath);
      logger.debug('filtered');
      await flush();

      // Directory should not exist since entry was filtered out
      try {
        await readFile(nestedLogPath, 'utf-8');
        expect(true).toBe(false); // Should have thrown
      } catch (err: unknown) {
        const e = err as { code?: string };
        expect(e.code).toBe('ENOENT');
      }
    });
  });

  // ── error resilience ──────────────────────────────────────────────────────

  describe('error resilience', () => {
    it('swallows file write errors without throwing to the caller', async () => {
      // Write to a read-only location to trigger error
      const logger = createLogger('debug', '/root/read-only.log');

      // Should not throw — fire-and-forget
      expect(() => logger.info('test')).not.toThrow();
      await flush(); // let the promise settle
    });

    it('swallows mkdir errors without throwing to the caller', async () => {
      // Write to a location where we can't create directories
      const logger = createLogger('debug', '/root/nested/deep/test.log');

      expect(() => logger.info('test')).not.toThrow();
      await flush();
    });
  });
});

// ---------------------------------------------------------------------------

describe('createNoopLogger', () => {
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
  let tempDir: string;

  beforeEach(async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'trace-test-'));
    tempDir = tmp;
  });

  const readTraceFile = async (): Promise<string> => {
    const tracePath = join(tempDir, '.bolt/trace.log');
    await delay(10); // Wait for async file write
    try {
      return await readFile(tracePath, 'utf-8');
    } catch {
      return '';
    }
  };

  describe('systemPrompt', () => {
    it('writes trace entry to trace file with SYSTEM PROMPT title', async () => {
      const logger = createTraceLogger(tempDir);
      logger.systemPrompt('sample prompt content', {
        model: 'claude-test',
        chars: 1000,
        tokens: 200,
        base: { chars: 500, tokens: 100 },
        skills: { chars: 300, tokens: 60, count: 3 },
        tools: { chars: 200, tokens: 40, count: 5 },
      });

      const output = await readTraceFile();
      expect(output).toContain('SYSTEM PROMPT');
      expect(output).toContain('═══════════════════════════════════════════════════════════════════════════');
    });

    it('includes model, chars, and tokens in header line', async () => {
      const logger = createTraceLogger(tempDir);
      logger.systemPrompt('prompt', {
        model: 'gpt-4',
        chars: 5000,
        tokens: 1200,
        base: { chars: 2000, tokens: 500 },
        skills: { chars: 2000, tokens: 400, count: 5 },
        tools: { chars: 1000, tokens: 300, count: 10 },
      });

      const output = await readTraceFile();
      expect(output).toContain('model=gpt-4');
      expect(output).toContain('chars=5000');
      expect(output).toContain('tokens=1200');
    });

    it('includes base/skills/tools breakdown', async () => {
      const logger = createTraceLogger(tempDir);
      logger.systemPrompt('prompt', {
        model: 'test',
        chars: 1000,
        tokens: 100,
        base: { chars: 400, tokens: 80 },
        skills: { chars: 300, tokens: 15, count: 3 },
        tools: { chars: 300, tokens: 5, count: 7 },
      });

      const output = await readTraceFile();
      expect(output).toContain('base=400ch/80tok');
      expect(output).toContain('skills=3×300ch/15tok');
      expect(output).toContain('tools=7×300ch/5tok');
    });

    it('includes the prompt content', async () => {
      const logger = createTraceLogger(tempDir);
      const content = 'You are a helpful assistant.';
      logger.systemPrompt(content, {
        model: 'test',
        chars: 28,
        tokens: 5,
        base: { chars: 28, tokens: 5 },
        skills: { chars: 0, tokens: 0, count: 0 },
        tools: { chars: 0, tokens: 0, count: 0 },
      });

      const output = await readTraceFile();
      expect(output).toContain(content);
    });

    it('writes full content to file (untruncated)', async () => {
      const logger = createTraceLogger(tempDir);
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

      const output = await readTraceFile();
      // File contains full content, untruncated
      expect(output).toContain('line 0');
      expect(output).toContain('line 99');
    });
  });

  describe('llmRequest', () => {
    it('writes trace entry to trace file with LLM REQUEST title', async () => {
      const logger = createTraceLogger(tempDir);
      logger.llmRequest('User message', {
        model: 'claude-test',
        messages: 3,
        tools: 5,
        systemTokens: 600,
        ctxTokens: 400,
        windowCapacity: 200000,
      });

      const output = await readTraceFile();
      expect(output).toContain('LLM REQUEST');
      expect(output).toContain('═══════════════════════════════════════════════════════════════════════════');
    });

    it('includes model, messages, tools, and window usage', async () => {
      const logger = createTraceLogger(tempDir);
      logger.llmRequest('msg', {
        model: 'test-model',
        messages: 5,
        tools: 12,
        systemTokens: 700,
        ctxTokens: 1000,
        windowCapacity: 200000,
      });

      const output = await readTraceFile();
      expect(output).toContain('model=test-model');
      expect(output).toContain('messages=5');
      expect(output).toContain('tools=12');
      expect(output).toContain('window=1700 / 200000 (0.9%)');
    });

    it('shows system and context tokens separately', async () => {
      const logger = createTraceLogger(tempDir);
      logger.llmRequest('msg', {
        model: 'test',
        messages: 2,
        tools: 3,
        systemTokens: 1000,
        ctxTokens: 800,
        windowCapacity: 200000,
      });

      const output = await readTraceFile();
      expect(output).toContain('system=1000tok');
      expect(output).toContain('messages=800tok');
    });

    it('includes the last message content', async () => {
      const logger = createTraceLogger(tempDir);
      const lastMsg = '{"role":"user","content":"What should I write?"}';
      logger.llmRequest(lastMsg, {
        model: 'test',
        messages: 2,
        tools: 1,
        systemTokens: 100,
        ctxTokens: 200,
        windowCapacity: 200000,
      });

      const output = await readTraceFile();
      expect(output).toContain('role');
      expect(output).toContain('user');
    });
  });

  describe('llmResponse', () => {
    it('writes trace entry to trace file with LLM RESPONSE title', async () => {
      const logger = createTraceLogger(tempDir);
      logger.llmResponse('Here is the response.', {
        model: 'claude-test',
        inputTokens: 500,
        outputTokens: 250,
        stopReason: 'end_turn',
        windowCapacity: 200000,
      });

      const output = await readTraceFile();
      expect(output).toContain('LLM RESPONSE');
      expect(output).toContain('═══════════════════════════════════════════════════════════════════════════');
    });

    it('includes model and token information', async () => {
      const logger = createTraceLogger(tempDir);
      logger.llmResponse('response text', {
        model: 'gpt-test',
        inputTokens: 800,
        outputTokens: 300,
        stopReason: 'end_turn',
        windowCapacity: 200000,
      });

      const output = await readTraceFile();
      expect(output).toContain('model=gpt-test');
      expect(output).toContain('inputTokens=800');
      expect(output).toContain('outputTokens=300');
      expect(output).toContain('stopReason=end_turn');
      expect(output).toContain('window=800 / 200000 (0.4%)');
    });

    it('calculates window percentage correctly', async () => {
      const logger = createTraceLogger(tempDir);
      logger.llmResponse('text', {
        model: 'test',
        inputTokens: 1000,
        outputTokens: 100,
        stopReason: 'max_tokens',
        windowCapacity: 200000,
      });

      const output = await readTraceFile();
      // 1000 / 200000 = 0.5%
      expect(output).toContain('0.5%');
    });

    it('includes the response content', async () => {
      const logger = createTraceLogger(tempDir);
      const content = 'Here is my response to your question.';
      logger.llmResponse(content, {
        model: 'test',
        inputTokens: 100,
        outputTokens: 50,
        stopReason: 'end_turn',
        windowCapacity: 200000,
      });

      const output = await readTraceFile();
      expect(output).toContain(content);
    });

    it('writes full content to file (untruncated)', async () => {
      const logger = createTraceLogger(tempDir);
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

      const output = await readTraceFile();
      // File contains full content, untruncated
      expect(output).toContain('response line 0');
      expect(output).toContain('response line 99');
    });
  });

  describe('formatting', () => {
    it('uses separator lines with ═ characters', async () => {
      const logger = createTraceLogger(tempDir);
      logger.systemPrompt('content', {
        model: 'test',
        chars: 100,
        tokens: 20,
        base: { chars: 100, tokens: 20 },
        skills: { chars: 0, tokens: 0, count: 0 },
        tools: { chars: 0, tokens: 0, count: 0 },
      });

      const output = await readTraceFile();
      expect(output).toContain('═══════════════════════════════════════════════════════════════════════════');
    });

    it('includes header line with entry type and metadata', async () => {
      const logger = createTraceLogger(tempDir);
      logger.llmRequest('msg', {
        model: 'test',
        messages: 1,
        tools: 0,
        systemTokens: 100,
        ctxTokens: 50,
        windowCapacity: 200000,
      });

      const output = await readTraceFile();
      expect(output).toContain('LLM REQUEST: model=test messages=1 tools=0');
    });

    it('includes window usage on separate line', async () => {
      const logger = createTraceLogger(tempDir);
      logger.llmResponse('text', {
        model: 'test',
        inputTokens: 100,
        outputTokens: 50,
        stopReason: 'end_turn',
        windowCapacity: 200000,
      });

      const output = await readTraceFile();
      expect(output).toContain('window=100 / 200000 (0.1%)');
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
