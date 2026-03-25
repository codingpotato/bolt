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

  it('onThinking emits thinking message', () => {
    const { reporter, sent } = makeReporter();
    reporter.onThinking();
    expect(sent[0]).toBe('⟳ Thinking…');
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

  it('onMemoryCompaction emits compacting message', () => {
    const { reporter, sent } = makeReporter();
    reporter.onMemoryCompaction(42);
    expect(sent[0]).toBe('⟳ Compacting 42 messages…');
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
