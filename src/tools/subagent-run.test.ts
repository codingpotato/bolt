import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSubagentRunTool } from './subagent-run';
import type { ToolContext } from './tool';
import type { AuthConfig } from '../auth/auth';
import { createNoopLogger } from '../logger';
import { NoopProgressReporter } from '../progress';

const AUTH: AuthConfig = { mode: 'api-key', credential: 'key' };
const SCRIPT = '/path/to/subagent.js';
const MODEL = 'claude-opus-4-6';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/workspace',
    log: { log: vi.fn().mockResolvedValue(undefined) },
    logger: createNoopLogger(),
    progress: new NoopProgressReporter(),
    ...overrides,
  };
}

describe('subagent_run tool', () => {
  type Payload = import('../subagent/subagent-runner').SubagentPayload;
  let lastPayload: Payload | undefined;
  const runnerSpy = vi.fn((_payload: Payload, _scriptPath: string) =>
    Promise.resolve({ output: 'sub-agent result' }),
  );
  const tool = createSubagentRunTool(AUTH, MODEL, SCRIPT, runnerSpy, () => '');

  beforeEach(() => {
    vi.clearAllMocks();
    lastPayload = undefined;
    runnerSpy.mockImplementation((payload) => {
      lastPayload = payload;
      return Promise.resolve({ output: 'sub-agent result' });
    });
  });

  it('has name subagent_run', () => {
    expect(tool.name).toBe('subagent_run');
  });

  it('returns output from the runner', async () => {
    const result = await tool.execute({ prompt: 'hello' }, makeCtx());
    expect(result.output).toBe('sub-agent result');
  });

  it('passes prompt and auth config to the runner', async () => {
    await tool.execute({ prompt: 'do the work' }, makeCtx());
    const payload = lastPayload;
    expect(payload?.prompt).toBe('do the work');
    expect(payload?.authConfig).toEqual(AUTH);
  });

  it('passes the model to the runner', async () => {
    await tool.execute({ prompt: 'task' }, makeCtx());
    const payload = lastPayload;
    expect(payload?.model).toBe(MODEL);
  });

  it('uses input allowedTools when parent has no restriction', async () => {
    const ctx = makeCtx(); // no allowedTools
    await tool.execute({ prompt: 'task', allowedTools: ['bash', 'file_read'] }, ctx);
    const payload = lastPayload;
    expect(payload?.allowedTools).toEqual(['bash', 'file_read']);
  });

  it('intersects allowedTools with parent allowedTools', async () => {
    const ctx = makeCtx({ allowedTools: ['bash', 'file_read', 'web_fetch'] });
    await tool.execute({ prompt: 'task', allowedTools: ['bash', 'file_write'] }, ctx);
    const payload = lastPayload;
    // intersection of ['bash', 'file_write'] and ['bash', 'file_read', 'web_fetch'] = ['bash']
    expect(payload?.allowedTools).toEqual(['bash']);
  });

  it('uses parent allowedTools when input has none', async () => {
    const ctx = makeCtx({ allowedTools: ['bash', 'file_read'] });
    await tool.execute({ prompt: 'task' }, ctx);
    const payload = lastPayload;
    expect(payload?.allowedTools).toEqual(['bash', 'file_read']);
  });

  it('passes undefined allowedTools when neither parent nor input restricts', async () => {
    const ctx = makeCtx(); // no allowedTools
    await tool.execute({ prompt: 'task' }, ctx); // no allowedTools in input
    const payload = lastPayload;
    expect(payload?.allowedTools).toBeUndefined();
  });

  it('returns error output when runner throws', async () => {
    runnerSpy.mockRejectedValue(new Error('child crashed'));
    const result = await tool.execute({ prompt: 'task' }, makeCtx());
    expect(result.output).toContain('child crashed');
    expect(result.error).toBe(true);
  });

  it('returns error output when runner rejects with a non-Error value', async () => {
    runnerSpy.mockRejectedValue('string rejection');
    const result = await tool.execute({ prompt: 'task' }, makeCtx());
    expect(result.output).toContain('string rejection');
    expect(result.error).toBe(true);
  });
});
