import { describe, it, expect } from 'vitest';
import { WebChannelProgressReporter } from './web-channel-progress';

function makeReporter(): { reporter: WebChannelProgressReporter; sent: string[] } {
  const sent: string[] = [];
  const reporter = new WebChannelProgressReporter((text) => sent.push(text));
  return { reporter, sent };
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
});
