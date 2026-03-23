import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAgentSuggestTool } from './agent-suggest';
import type { SuggestionStore } from '../suggestions/suggestion-store';
import type { ToolContext } from './tool';
import { createNoopLogger } from '../logger';
import { NoopProgressReporter } from '../progress';

type WriteArg = Parameters<SuggestionStore['write']>[0];

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/workspace',
    log: { log: vi.fn().mockResolvedValue(undefined) },
    logger: createNoopLogger(),
    progress: new NoopProgressReporter(),
    ...overrides,
  };
}

describe('agent_suggest tool', () => {
  let lastWritten: WriteArg | undefined;
  const writeSpy = vi.fn((entry: WriteArg): Promise<string> => {
    lastWritten = entry;
    return Promise.resolve('suggestion-id-1');
  });
  const mockStore = { write: writeSpy } as unknown as SuggestionStore;
  const SUGGESTIONS_DIR = '/data/suggestions';
  const tool = createAgentSuggestTool(mockStore, SUGGESTIONS_DIR);

  beforeEach(() => {
    vi.clearAllMocks();
    lastWritten = undefined;
    writeSpy.mockImplementation((entry: WriteArg): Promise<string> => {
      lastWritten = entry;
      return Promise.resolve('suggestion-id-1');
    });
  });

  it('has name agent_suggest', () => {
    expect(tool.name).toBe('agent_suggest');
  });

  it('returns suggestionId and path', async () => {
    const result = await tool.execute(
      { target: 'AGENT.md', scope: 'project', content: 'new rule', reason: 'observed pattern' },
      makeCtx(),
    );
    expect(result.suggestionId).toBe('suggestion-id-1');
    expect(result.path).toBe(`${SUGGESTIONS_DIR}/suggestion-id-1.json`);
  });

  it('writes suggestion with correct fields', async () => {
    await tool.execute(
      { target: 'AGENT.md', scope: 'user', content: 'prefer tabs', reason: 'consistent style' },
      makeCtx({ sessionId: 'session-abc', activeTaskId: 'task-42' }),
    );
    const written = lastWritten;
    expect(written).toMatchObject({
      target: 'AGENT.md',
      scope: 'user',
      content: 'prefer tabs',
      reason: 'consistent style',
      sessionId: 'session-abc',
      taskId: 'task-42',
      status: 'pending',
    });
  });

  it('omits taskId when no active task', async () => {
    await tool.execute(
      { target: 'AGENT.md', scope: 'project', content: 'rule', reason: 'reason' },
      makeCtx({ sessionId: 'session-1' }),
    );
    const written = lastWritten;
    expect(written?.taskId).toBeUndefined();
  });

  it('uses empty string for sessionId when context has none', async () => {
    await tool.execute(
      { target: 'AGENT.md', scope: 'project', content: 'rule', reason: 'reason' },
      makeCtx(),
    );
    const written = lastWritten;
    expect(written?.sessionId).toBe('');
  });
});
