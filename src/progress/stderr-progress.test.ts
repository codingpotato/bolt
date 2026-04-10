import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StderrProgressReporter } from './stderr-progress';

describe('StderrProgressReporter', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const written: string[] = [];

  beforeEach(() => {
    written.length = 0;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  function lastLine(): Record<string, unknown> {
    const last = written[written.length - 1];
    expect(last).toBeDefined();
    expect(last).toMatch(/^PROGRESS:/);
    return JSON.parse(last!.slice('PROGRESS:'.length)) as Record<string, unknown>;
  }

  describe('forwarded events', () => {
    it('onThinking writes PROGRESS:onThinking line to stderr', () => {
      const r = new StderrProgressReporter();
      r.onThinking();
      expect(lastLine()).toEqual({ event: 'onThinking' });
    });

    it('onToolCall writes PROGRESS:onToolCall line with name and input', () => {
      const r = new StderrProgressReporter();
      r.onToolCall('bash', { command: 'npm test' });
      const line = lastLine();
      expect(line['event']).toBe('onToolCall');
      expect(line['name']).toBe('bash');
      expect(line['input']).toEqual({ command: 'npm test' });
    });

    it('onToolResult writes PROGRESS:onToolResult line with success=true', () => {
      const r = new StderrProgressReporter();
      r.onToolResult('bash', true, 'exit 0');
      const line = lastLine();
      expect(line['event']).toBe('onToolResult');
      expect(line['name']).toBe('bash');
      expect(line['success']).toBe(true);
      expect(line['summary']).toBe('exit 0');
    });

    it('onToolResult writes PROGRESS:onToolResult line with success=false', () => {
      const r = new StderrProgressReporter();
      r.onToolResult('file_read', false, 'not found');
      const line = lastLine();
      expect(line['success']).toBe(false);
      expect(line['summary']).toBe('not found');
    });

    it('onRetry writes PROGRESS:onRetry line with attempt info', () => {
      const r = new StderrProgressReporter();
      r.onRetry(2, 3, 'ECONNREFUSED');
      const line = lastLine();
      expect(line['event']).toBe('onRetry');
      expect(line['attempt']).toBe(2);
      expect(line['maxAttempts']).toBe(3);
      expect(line['reason']).toBe('ECONNREFUSED');
    });

    it('each PROGRESS line ends with a newline', () => {
      const r = new StderrProgressReporter();
      r.onThinking();
      expect(written[written.length - 1]).toMatch(/\n$/);
    });

    it('each PROGRESS line is valid JSON after the prefix', () => {
      const r = new StderrProgressReporter();
      r.onToolCall('web_fetch', { url: 'https://example.com' });
      const raw = written[written.length - 1]!;
      expect(() => JSON.parse(raw.slice('PROGRESS:'.length))).not.toThrow();
    });
  });

  describe('suppressed events — no stderr output', () => {
    it('onSessionStart writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onSessionStart('abc', false);
      expect(written).toHaveLength(0);
    });

    it('onLlmCall writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onLlmCall({ messageCount: 5, injectedTokens: 100, systemTokens: 1000, ctxTokens: 2000 });
      expect(written).toHaveLength(0);
    });

    it('onLlmResponse writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onLlmResponse({ inputTokens: 1000, outputTokens: 100, stopReason: 'end_turn', windowCapacity: 200_000 });
      expect(written).toHaveLength(0);
    });

    it('onTaskStatusChange writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onTaskStatusChange('t1', 'My task', 'completed');
      expect(written).toHaveLength(0);
    });

    it('onContextInjection writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onContextInjection('task', 5, 't1');
      expect(written).toHaveLength(0);
    });

    it('onMemoryCompaction writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onMemoryCompaction(42, 'summary', ['tag1']);
      expect(written).toHaveLength(0);
    });

    it('onSubagentStart writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onSubagentStart('skill', 'desc');
      expect(written).toHaveLength(0);
    });

    it('onSubagentEnd writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onSubagentEnd('skill', 1000);
      expect(written).toHaveLength(0);
    });

    it('onSubagentError writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onSubagentError('skill', 'oops');
      expect(written).toHaveLength(0);
    });

    it('onSubagentThinking writes nothing (not a top-level sub-agent event)', () => {
      const r = new StderrProgressReporter();
      r.onSubagentThinking('skill');
      expect(written).toHaveLength(0);
    });

    it('onSubagentToolCall writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onSubagentToolCall('skill', 'bash', {});
      expect(written).toHaveLength(0);
    });

    it('onSubagentToolResult writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onSubagentToolResult('skill', 'bash', true, 'ok');
      expect(written).toHaveLength(0);
    });

    it('onSubagentRetry writes nothing', () => {
      const r = new StderrProgressReporter();
      r.onSubagentRetry('skill', 1, 3, 'err');
      expect(written).toHaveLength(0);
    });
  });

  it('implements ProgressReporter — all methods callable without throwing', () => {
    const r = new StderrProgressReporter();
    expect(() => {
      r.onSessionStart('abc', false);
      r.onThinking();
      r.onLlmCall({ messageCount: 5, injectedTokens: 100, systemTokens: 1000, ctxTokens: 2000 });
      r.onLlmResponse({ inputTokens: 1000, outputTokens: 100, stopReason: 'end_turn', windowCapacity: 200_000 });
      r.onToolCall('bash', { command: 'ls' });
      r.onToolResult('bash', true, 'exit 0');
      r.onTaskStatusChange('t1', 'My task', 'completed');
      r.onContextInjection('task', 5, 't1');
      r.onMemoryCompaction(42, 'summary', ['tag']);
      r.onRetry(1, 3, 'reason');
      r.onSubagentStart('skill', 'desc');
      r.onSubagentEnd('skill', 1000);
      r.onSubagentError('skill', 'err');
      r.onSubagentThinking('skill');
      r.onSubagentToolCall('skill', 'bash', {});
      r.onSubagentToolResult('skill', 'bash', true, 'ok');
      r.onSubagentRetry('skill', 1, 3, 'reason');
    }).not.toThrow();
  });
});
