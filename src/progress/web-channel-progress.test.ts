import { describe, it, expect } from 'vitest';
import { WebChannelProgressReporter } from './web-channel-progress';
import type { SubagentStatusEvent, SubagentProgressEvent } from './web-channel-progress';

function makeReporter(): { reporter: WebChannelProgressReporter; sent: string[] } {
  const sent: string[] = [];
  const reporter = new WebChannelProgressReporter((text) => sent.push(text));
  return { reporter, sent };
}

function makeReporterWithStatus(): {
  reporter: WebChannelProgressReporter;
  sent: string[];
  events: SubagentStatusEvent[];
} {
  const sent: string[] = [];
  const events: SubagentStatusEvent[] = [];
  const reporter = new WebChannelProgressReporter(
    (text) => sent.push(text),
    (event) => events.push(event),
  );
  return { reporter, sent, events };
}

function makeReporterWithProgress(): {
  reporter: WebChannelProgressReporter;
  sent: string[];
  progress: SubagentProgressEvent[];
} {
  const sent: string[] = [];
  const progress: SubagentProgressEvent[] = [];
  const reporter = new WebChannelProgressReporter(
    (text) => sent.push(text),
    undefined,
    (event) => progress.push(event),
  );
  return { reporter, sent, progress };
}

describe('WebChannelProgressReporter', () => {
  it('onSessionStart emits started message', () => {
    const { reporter, sent } = makeReporter();
    reporter.onSessionStart('a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx', false);
    expect(sent[0]).toBe('◆ Session a1b2c3d4 started');
  });

  it('onSessionStart emits resumed message', () => {
    const { reporter, sent } = makeReporter();
    reporter.onSessionStart('a1b2c3d4-xxxx-xxxx-xxxx-xxxxxxxxxxxx', true);
    expect(sent[0]).toBe('◆ Session a1b2c3d4 resumed');
  });

  it('onThinking emits nothing (onLlmCall provides richer output)', () => {
    const { reporter, sent } = makeReporter();
    reporter.onThinking();
    expect(sent).toHaveLength(0);
  });

  it('onToolCall emits tool name and summarised input', () => {
    const { reporter, sent } = makeReporter();
    reporter.onToolCall('bash', { command: 'npm test' });
    expect(sent[0]).toBe('⚙ bash\n   $ npm test');
  });

  it('onToolResult emits success result', () => {
    const { reporter, sent } = makeReporter();
    reporter.onToolResult('bash', true, 'exit 0');
    expect(sent[0]).toBe('   ✓ completed  exit 0');
  });

  it('onToolResult emits error result', () => {
    const { reporter, sent } = makeReporter();
    reporter.onToolResult('bash', false, 'exit 1');
    expect(sent[0]).toBe('   ✗ error  exit 1');
  });

  it('onTaskStatusChange emits task status', () => {
    const { reporter, sent } = makeReporter();
    reporter.onTaskStatusChange('t1', 'Write tests', 'completed');
    expect(sent[0]).toBe('◆ Task "Write tests" → completed');
  });

  it('onContextInjection emits task source message', () => {
    const { reporter, sent } = makeReporter();
    reporter.onContextInjection('task', 5, 'task-123');
    expect(sent[0]).toBe('  ↳ Loaded 5 messages from task "task-123"');
  });

  it('onContextInjection emits chat source message', () => {
    const { reporter, sent } = makeReporter();
    reporter.onContextInjection('chat', 3);
    expect(sent[0]).toBe('  ↳ Loaded 3 messages from previous chat session');
  });

  it('onMemoryCompaction emits compaction summary with tags', () => {
    const { reporter, sent } = makeReporter();
    reporter.onMemoryCompaction(42, 'Auth discussion summary', ['auth', 'jwt']);
    expect(sent[0]).toBe('⟳ Compacted 42 msgs → "Auth discussion summary" [auth, jwt]');
  });

  it('onLlmCall emits context stats', () => {
    const { reporter, sent } = makeReporter();
    reporter.onLlmCall({ messageCount: 23, injectedTokens: 4200, systemTokens: 4000, ctxTokens: 5000 });
    expect(sent[0]).toContain('23 msgs');
    expect(sent[0]).toContain('sys:');
    expect(sent[0]).toContain('ctx:');
    expect(sent[0]).toContain('inj:');
    expect(sent[0]).toContain('4,000');
    expect(sent[0]).toContain('5,000');
    expect(sent[0]).toContain('4,200');
  });

  it('onLlmResponse emits token usage', () => {
    const { reporter, sent } = makeReporter();
    reporter.onLlmResponse({
      inputTokens: 12450,
      outputTokens: 234,
      stopReason: 'tool_use',
      windowCapacity: 200_000,
    });
    expect(sent[0]).toContain('12,450');
    expect(sent[0]).toContain('234');
    expect(sent[0]).toContain('tool_use');
  });

  it('onRetry emits retry message', () => {
    const { reporter, sent } = makeReporter();
    reporter.onRetry(1, 3, 'connect ECONNREFUSED');
    expect(sent[0]).toBe('⚠ API error, retrying (1/3): connect ECONNREFUSED');
  });

  it('swallows errors from sendProgress without throwing', () => {
    const reporter = new WebChannelProgressReporter(() => {
      throw new Error('send failed');
    });
    expect(() => reporter.onThinking()).not.toThrow();
  });

  it('onSubagentStart emits text progress line', () => {
    const { reporter, sent } = makeReporter();
    reporter.onSubagentStart('analyze-trends', 'Search trending topics on social media');
    expect(sent[0]).toContain('⟳ Subagent: analyze-trends');
    expect(sent[0]).toContain('Search trending topics');
  });

  it('onSubagentStart truncates description at 80 chars', () => {
    const { reporter, sent } = makeReporter();
    reporter.onSubagentStart('my-skill', 'x'.repeat(100));
    expect(sent[0]).toContain('x'.repeat(80) + '…');
    expect(sent[0]).not.toContain('x'.repeat(81));
  });

  it('onSubagentStart emits structured starting event', () => {
    const { reporter, events } = makeReporterWithStatus();
    reporter.onSubagentStart('analyze-trends', 'Search trending topics');
    expect(events[0]).toEqual({ skill: 'analyze-trends', status: 'starting' });
  });

  it('onSubagentEnd emits text progress line with duration', () => {
    const { reporter, sent } = makeReporter();
    reporter.onSubagentEnd('analyze-trends', 8240);
    expect(sent[0]).toBe('  ✓ Subagent done: analyze-trends (8240ms)');
  });

  it('onSubagentEnd emits structured done event with durationMs', () => {
    const { reporter, events } = makeReporterWithStatus();
    reporter.onSubagentEnd('analyze-trends', 8240);
    expect(events[0]).toEqual({ skill: 'analyze-trends', status: 'done', durationMs: 8240 });
  });

  it('onSubagentError emits text progress line', () => {
    const { reporter, sent } = makeReporter();
    reporter.onSubagentError('analyze-trends', 'process exited with code 1');
    expect(sent[0]).toContain('✗ Subagent failed: analyze-trends');
    expect(sent[0]).toContain('process exited with code 1');
  });

  it('onSubagentError emits structured failed event with error', () => {
    const { reporter, events } = makeReporterWithStatus();
    reporter.onSubagentError('analyze-trends', 'OOM');
    expect(events[0]).toEqual({ skill: 'analyze-trends', status: 'failed', error: 'OOM' });
  });

  it('onSubagentStart swallows errors from sendSubagentStatus without throwing', () => {
    const reporter = new WebChannelProgressReporter(
      () => {},
      () => { throw new Error('broadcast failed'); },
    );
    expect(() => reporter.onSubagentStart('s', 'desc')).not.toThrow();
  });

  it('onSubagentEnd swallows errors from sendSubagentStatus without throwing', () => {
    const reporter = new WebChannelProgressReporter(
      () => {},
      () => { throw new Error('broadcast failed'); },
    );
    expect(() => reporter.onSubagentEnd('s', 100)).not.toThrow();
  });

  it('onSubagentError swallows errors from sendSubagentStatus without throwing', () => {
    const reporter = new WebChannelProgressReporter(
      () => {},
      () => { throw new Error('broadcast failed'); },
    );
    expect(() => reporter.onSubagentError('s', 'err')).not.toThrow();
  });

  it('works without sendSubagentStatus callback', () => {
    const sent: string[] = [];
    const reporter = new WebChannelProgressReporter((text) => sent.push(text));
    expect(() => {
      reporter.onSubagentStart('s', 'desc');
      reporter.onSubagentEnd('s', 100);
      reporter.onSubagentError('s', 'err');
    }).not.toThrow();
    expect(sent).toHaveLength(3);
  });

  describe('forwarded sub-agent progress events', () => {
    it('onSubagentThinking emits indented text and structured event', () => {
      const { reporter, sent, progress } = makeReporterWithProgress();
      reporter.onSubagentThinking('write-blog-post');
      expect(sent[0]).toBe('  ⟳ Thinking…');
      expect(progress[0]).toEqual({ type: 'subagent_progress', skill: 'write-blog-post', event: 'thinking' });
    });

    it('onSubagentToolCall emits indented text and structured event', () => {
      const { reporter, sent, progress } = makeReporterWithProgress();
      reporter.onSubagentToolCall('write-blog-post', 'bash', { command: 'npm test' });
      expect(sent[0]).toContain('  ⚙ bash');
      expect(sent[0]).toContain('$ npm test');
      expect(progress[0]).toMatchObject({
        type: 'subagent_progress',
        skill: 'write-blog-post',
        event: 'tool_call',
        tool: 'bash',
      });
    });

    it('onSubagentToolResult emits indented text and structured event', () => {
      const { reporter, sent, progress } = makeReporterWithProgress();
      reporter.onSubagentToolResult('write-blog-post', 'bash', true, 'exit 0');
      expect(sent[0]).toContain('✓ completed');
      expect(progress[0]).toEqual({
        type: 'subagent_progress',
        skill: 'write-blog-post',
        event: 'tool_result',
        tool: 'bash',
        success: true,
        summary: 'exit 0',
      });
    });

    it('onSubagentToolResult success=false emits error variant', () => {
      const { reporter, sent, progress } = makeReporterWithProgress();
      reporter.onSubagentToolResult('write-blog-post', 'bash', false, 'exit 1');
      expect(sent[0]).toContain('✗ error');
      expect(progress[0]).toMatchObject({ success: false, summary: 'exit 1' });
    });

    it('onSubagentRetry emits indented text and structured event', () => {
      const { reporter, sent, progress } = makeReporterWithProgress();
      reporter.onSubagentRetry('write-blog-post', 2, 3, 'ECONNREFUSED');
      expect(sent[0]).toBe('  ⚠ API error, retrying (2/3): ECONNREFUSED');
      expect(progress[0]).toEqual({
        type: 'subagent_progress',
        skill: 'write-blog-post',
        event: 'retry',
        attempt: 2,
        maxAttempts: 3,
        reason: 'ECONNREFUSED',
      });
    });

    it('works without sendSubagentProgress callback', () => {
      const sent: string[] = [];
      const reporter = new WebChannelProgressReporter((text) => sent.push(text));
      expect(() => {
        reporter.onSubagentThinking('s');
        reporter.onSubagentToolCall('s', 'bash', {});
        reporter.onSubagentToolResult('s', 'bash', true, 'ok');
        reporter.onSubagentRetry('s', 1, 3, 'err');
      }).not.toThrow();
      expect(sent).toHaveLength(4);
    });

    it('swallows errors from sendSubagentProgress without throwing', () => {
      const reporter = new WebChannelProgressReporter(
        () => {},
        undefined,
        () => { throw new Error('broadcast failed'); },
      );
      expect(() => reporter.onSubagentThinking('s')).not.toThrow();
    });
  });
});
