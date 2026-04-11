import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NoopProgressReporter } from './progress';
import { CliProgressReporter, summariseInput } from './cli-progress';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake writable stream that captures written strings. */
function makeFakeStream(isTTY: boolean): { stream: NodeJS.WritableStream; output(): string } {
  const chunks: string[] = [];
  const stream = {
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    isTTY,
  } as unknown as NodeJS.WritableStream;
  return { stream, output: () => chunks.join('') };
}

// ---------------------------------------------------------------------------
// NoopProgressReporter
// ---------------------------------------------------------------------------

describe('NoopProgressReporter', () => {
  it('all methods are callable without throwing', () => {
    const r = new NoopProgressReporter();
    expect(() => {
      r.onSessionStart('abc', false);
      r.onThinking();
      r.onToolCall('bash', { command: 'ls' });
      r.onToolResult('bash', true, 'exit 0');
      r.onTaskStatusChange('t1', 'My task', 'completed');
      r.onContextInjection('task', 5, 't1');
      r.onContextInjection('chat', 3);
      r.onLlmCall({ messageCount: 5, injectedTokens: 1000, systemTokens: 4000, ctxTokens: 5000 });
      r.onLlmResponse({
        inputTokens: 5000,
        outputTokens: 200,
        stopReason: 'end_turn',
        windowCapacity: 200_000,
      });
      r.onMemoryCompaction(42, 'Discussion summary', ['auth', 'jwt']);
      r.onRetry(1, 3, 'ECONNREFUSED');
      r.onSubagentStart('analyze-trends', 'Search trending topics');
      r.onSubagentEnd('analyze-trends', 4200);
      r.onSubagentError('analyze-trends', 'OOM');
      r.onSubagentThinking('analyze-trends');
      r.onSubagentToolCall('analyze-trends', 'web_fetch', { url: 'https://example.com' });
      r.onSubagentToolResult('analyze-trends', 'web_fetch', true, '200 OK');
      r.onSubagentRetry('analyze-trends', 1, 3, 'ECONNREFUSED');
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CliProgressReporter — TTY / non-TTY / quiet / verbose
// ---------------------------------------------------------------------------

describe('CliProgressReporter', () => {
  describe('TTY mode (isTTY=true, quiet=false, verbose=false)', () => {
    let reporter: CliProgressReporter;
    let output: () => string;

    beforeEach(() => {
      const fake = makeFakeStream(true);
      reporter = new CliProgressReporter(fake.stream);
      output = fake.output;
    });

    it('onSessionStart writes session start line', () => {
      reporter.onSessionStart('a1b2c3d4e5f6', false);
      expect(output()).toBe('◆ Session a1b2c3d4 started\n');
    });

    it('onSessionStart writes resumed when resumed=true', () => {
      reporter.onSessionStart('a1b2c3d4e5f6', true);
      expect(output()).toContain('resumed');
    });

    it('onThinking writes thinking line and sets pending flag', () => {
      reporter.onThinking();
      expect(output()).toBe('⟳ Thinking…\n');
    });

    it('onLlmCall does not write LLM stats in non-verbose TTY mode', () => {
      const fake = makeFakeStream(true);
      reporter = new CliProgressReporter(fake.stream);
      reporter.onThinking();
      reporter.onLlmCall({ messageCount: 23, injectedTokens: 4200, systemTokens: 4000, ctxTokens: 5000 });
      // Plain "Thinking…" stays — verbose is required for detailed LLM trace
      expect(fake.output()).toBe('⟳ Thinking…\n');
      expect(fake.output()).not.toContain('msgs');
      expect(fake.output()).not.toContain('sys:');
    });

    it('onLlmResponse does not write token usage in non-verbose TTY mode', () => {
      const fake = makeFakeStream(true);
      reporter = new CliProgressReporter(fake.stream);
      reporter.onThinking();
      reporter.onLlmResponse({
        inputTokens: 12450,
        outputTokens: 234,
        stopReason: 'tool_use',
        windowCapacity: 200_000,
      });
      // Plain "Thinking…" stays — verbose is required for detailed LLM trace
      expect(fake.output()).toBe('⟳ Thinking…\n');
      expect(fake.output()).not.toContain('12,450');
    });

    it('onToolCall clears thinking line and writes tool block', () => {
      const fake = makeFakeStream(true);
      reporter = new CliProgressReporter(fake.stream);
      reporter.onThinking();
      reporter.onToolCall('bash', { command: 'npm test' });
      const out = fake.output();
      // Should contain erase sequence followed by tool info
      expect(out).toContain('\x1b[1A\x1b[2K');
      expect(out).toContain('⚙  bash');
      expect(out).toContain('$ npm test');
    });

    it('onToolResult writes success line', () => {
      reporter.onToolResult('bash', true, 'exit 0');
      expect(output()).toContain('✓');
      expect(output()).toContain('completed');
      expect(output()).toContain('exit 0');
    });

    it('onToolResult writes error line on failure', () => {
      reporter.onToolResult('bash', false, 'file not found');
      expect(output()).toContain('✗');
      expect(output()).toContain('error');
      expect(output()).toContain('file not found');
    });

    it('onTaskStatusChange writes task line', () => {
      reporter.onTaskStatusChange('t1', 'Write tests', 'completed');
      expect(output()).toBe('◆ Task "Write tests" → completed\n');
    });

    it('onContextInjection writes task injection line', () => {
      reporter.onContextInjection('task', 12, 't1');
      expect(output()).toContain('Loaded 12 messages from task "t1"');
    });

    it('onContextInjection writes chat injection line', () => {
      reporter.onContextInjection('chat', 5);
      expect(output()).toContain('Loaded 5 messages from previous chat session');
    });

    it('onMemoryCompaction writes compaction line with summary and tags', () => {
      reporter.onMemoryCompaction(42, 'Auth discussion summary', ['auth', 'jwt']);
      expect(output()).toBe('⟳ Compacted 42 msgs → "Auth discussion summary" [auth, jwt]\n');
    });

    it('onMemoryCompaction truncates long summaries at 60 chars', () => {
      const long = 'x'.repeat(80);
      reporter.onMemoryCompaction(10, long, []);
      expect(output()).toContain(`${'x'.repeat(60)}…`);
      expect(output()).not.toContain(`${'x'.repeat(61)}`);
    });

    it('onRetry writes retry warning', () => {
      reporter.onRetry(1, 3, 'ECONNREFUSED');
      expect(output()).toBe('⚠  API error, retrying (1/3): ECONNREFUSED\n');
    });

    it('onSubagentStart clears thinking and writes subagent start line', () => {
      const fake = makeFakeStream(true);
      reporter = new CliProgressReporter(fake.stream);
      reporter.onThinking();
      reporter.onSubagentStart('analyze-trends', 'Search trending topics on social media');
      const out = fake.output();
      expect(out).toContain('\x1b[1A\x1b[2K');
      expect(out).toContain('⟳ Subagent: analyze-trends');
      expect(out).toContain('Search trending topics on social media');
    });

    it('onSubagentStart truncates long descriptions at 80 chars', () => {
      const desc = 'x'.repeat(100);
      reporter.onSubagentStart('my-skill', desc);
      expect(output()).toContain(`${'x'.repeat(80)}…`);
      expect(output()).not.toContain(`${'x'.repeat(81)}`);
    });

    it('onSubagentEnd writes done line with duration', () => {
      reporter.onSubagentEnd('analyze-trends', 8240);
      expect(output()).toBe('  ✓ Subagent done: analyze-trends (8240ms)\n');
    });

    it('onSubagentError clears thinking and writes error line', () => {
      const fake = makeFakeStream(true);
      reporter = new CliProgressReporter(fake.stream);
      reporter.onThinking();
      reporter.onSubagentError('analyze-trends', 'process exited with code 1');
      const out = fake.output();
      expect(out).toContain('\x1b[1A\x1b[2K');
      expect(out).toContain('✗ Subagent failed: analyze-trends');
      expect(out).toContain('process exited with code 1');
    });

    it('onSubagentError truncates long error messages at 120 chars', () => {
      const err = 'e'.repeat(200);
      reporter.onSubagentError('my-skill', err);
      expect(output()).toContain(`${'e'.repeat(120)}…`);
      expect(output()).not.toContain(`${'e'.repeat(121)}`);
    });

    it('clearPendingThinking erases the thinking line', () => {
      const fake = makeFakeStream(true);
      reporter = new CliProgressReporter(fake.stream);
      reporter.onThinking();
      reporter.clearPendingThinking();
      expect(fake.output()).toContain('\x1b[1A\x1b[2K');
    });

    it('clearPendingThinking does nothing if no thinking line is pending', () => {
      const fake = makeFakeStream(true);
      const writeSpy = fake.stream.write as ReturnType<typeof vi.fn>;
      reporter = new CliProgressReporter(fake.stream);
      reporter.clearPendingThinking();
      // write should not have been called for the erase sequence
      expect(writeSpy).not.toHaveBeenCalledWith('\x1b[1A\x1b[2K');
    });

    it('onSubagentThinking writes indented thinking line', () => {
      reporter.onSubagentThinking('write-blog-post');
      expect(output()).toBe('  ⟳ Thinking…\n');
    });

    it('onSubagentToolCall writes indented tool block', () => {
      reporter.onSubagentToolCall('write-blog-post', 'bash', { command: 'npm test' });
      expect(output()).toContain('  ⚙  bash');
      expect(output()).toContain('     $ npm test');
    });

    it('onSubagentToolResult writes indented success result', () => {
      reporter.onSubagentToolResult('write-blog-post', 'bash', true, 'exit 0');
      expect(output()).toContain('     ✓ completed');
      expect(output()).toContain('exit 0');
    });

    it('onSubagentToolResult writes indented error result', () => {
      reporter.onSubagentToolResult('write-blog-post', 'bash', false, 'exit 1');
      expect(output()).toContain('     ✗ error');
      expect(output()).toContain('exit 1');
    });

    it('onSubagentRetry writes indented retry line', () => {
      reporter.onSubagentRetry('write-blog-post', 1, 3, 'ECONNREFUSED');
      expect(output()).toBe('  ⚠  API error, retrying (1/3): ECONNREFUSED\n');
    });
  });

  describe('non-TTY mode (isTTY=false, verbose=false, quiet=false)', () => {
    let reporter: CliProgressReporter;
    let writeSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      const fake = makeFakeStream(false);
      writeSpy = fake.stream.write as ReturnType<typeof vi.fn>;
      reporter = new CliProgressReporter(fake.stream);
    });

    it('onSessionStart suppresses output', () => {
      reporter.onSessionStart('abc', false);
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('onThinking suppresses output', () => {
      reporter.onThinking();
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('onToolCall suppresses output', () => {
      reporter.onToolCall('bash', { command: 'ls' });
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('--quiet flag (isTTY=true, quiet=true)', () => {
    it('suppresses all output even on a TTY', () => {
      const fake = makeFakeStream(true);
      const writeSpy = fake.stream.write as ReturnType<typeof vi.fn>;
      const reporter = new CliProgressReporter(fake.stream, false, true);

      reporter.onSessionStart('abc', false);
      reporter.onThinking();
      reporter.onLlmCall({ messageCount: 5, injectedTokens: 1000, systemTokens: 4000, ctxTokens: 5000 });
      reporter.onLlmResponse({
        inputTokens: 5000,
        outputTokens: 100,
        stopReason: 'end_turn',
        windowCapacity: 200_000,
      });
      reporter.onToolCall('bash', { command: 'ls' });
      reporter.onToolResult('bash', true, 'ok');
      reporter.onTaskStatusChange('t1', 'My task', 'completed');
      reporter.onMemoryCompaction(5, 'summary', []);
      reporter.onRetry(1, 3, 'err');

      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('--verbose flag (isTTY=false, verbose=true)', () => {
    it('emits output even in non-TTY mode', () => {
      const fake = makeFakeStream(false);
      const reporter = new CliProgressReporter(fake.stream, true, false);

      reporter.onSessionStart('abc123', false);
      expect(fake.output()).toContain('started');
    });

    it('onLlmCall writes context stats in verbose mode', () => {
      const fake = makeFakeStream(false);
      const reporter = new CliProgressReporter(fake.stream, true, false);
      reporter.onThinking();
      reporter.onLlmCall({ messageCount: 23, injectedTokens: 4200, systemTokens: 4000, ctxTokens: 5000 });
      const out = fake.output();
      expect(out).toContain('\x1b[1A\x1b[2K');
      expect(out).toContain('⟳ Thinking…');
      expect(out).toContain('23 msgs');
      expect(out).toContain('sys:');
      expect(out).toContain('ctx:');
      expect(out).toContain('inj:');
      expect(out).toContain('4,000');
      expect(out).toContain('5,000');
      expect(out).toContain('4,200');
    });

    it('onLlmResponse writes token usage in verbose mode', () => {
      const fake = makeFakeStream(false);
      const reporter = new CliProgressReporter(fake.stream, true, false);
      reporter.onThinking();
      reporter.onLlmResponse({
        inputTokens: 12450,
        outputTokens: 234,
        stopReason: 'tool_use',
        windowCapacity: 200_000,
      });
      const out = fake.output();
      expect(out).toContain('\x1b[1A\x1b[2K');
      expect(out).toContain('12,450');
      expect(out).toContain('234');
      expect(out).toContain('tool_use');
    });
  });
});

// ---------------------------------------------------------------------------
// summariseInput
// ---------------------------------------------------------------------------

describe('summariseInput', () => {
  it('bash: shows $ command', () => {
    expect(summariseInput('bash', { command: 'npm test' })).toBe('$ npm test');
  });

  it('bash: truncates command at 120 chars', () => {
    const long = 'x'.repeat(200);
    expect(summariseInput('bash', { command: long })).toBe(`$ ${'x'.repeat(120)}`);
  });

  it('file_read: shows path', () => {
    expect(summariseInput('file_read', { path: 'src/foo.ts' })).toBe('src/foo.ts');
  });

  it('file_write: shows path', () => {
    expect(summariseInput('file_write', { path: 'out/bar.js' })).toBe('out/bar.js');
  });

  it('file_edit: shows path', () => {
    expect(summariseInput('file_edit', { path: 'src/baz.ts' })).toBe('src/baz.ts');
  });

  it('web_fetch: shows url', () => {
    expect(summariseInput('web_fetch', { url: 'https://example.com' })).toBe('https://example.com');
  });

  it('web_fetch: truncates url at 120 chars', () => {
    const url = 'https://example.com/' + 'a'.repeat(200);
    expect(summariseInput('web_fetch', { url })).toHaveLength(120);
  });

  it('task_create: shows quoted title', () => {
    expect(summariseInput('task_create', { title: 'Do something' })).toBe('"Do something"');
  });

  it('task_update: shows id → status', () => {
    expect(summariseInput('task_update', { id: 'abc', status: 'completed' })).toBe(
      'abc → completed',
    );
  });

  it('memory_search: shows quoted query', () => {
    expect(summariseInput('memory_search', { query: 'auth patterns' })).toBe('"auth patterns"');
  });

  it('memory_write: shows first 80 chars of content', () => {
    const content = 'x'.repeat(100);
    expect(summariseInput('memory_write', { content })).toBe('x'.repeat(80));
  });

  it('default: shows first 120 chars of JSON', () => {
    const input = { big: 'x'.repeat(200) };
    const result = summariseInput('unknown_tool', input);
    expect(result.length).toBeLessThanOrEqual(120);
  });
});
