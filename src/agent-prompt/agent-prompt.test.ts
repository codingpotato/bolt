import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { readFile as ReadFileFn } from 'node:fs/promises';
import { loadAgentPrompt, DEFAULT_SYSTEM_PROMPT } from './agent-prompt';
import type { Config } from '../config/config';

vi.mock('node:fs/promises');
vi.mock('node:os');

function makeConfig(overrides?: Partial<Config['agentPrompt']>): Config {
  return {
    model: 'claude-test',
    dataDir: '.bolt',
    logLevel: 'info',
    auth: {},
    local: {},
    agentPrompt: {
      projectFile: '.bolt/AGENT.md',
      userFile: '~/.bolt/AGENT.md',
      suggestionsPath: '.bolt/suggestions',
      ...overrides,
    },
    memory: { compactThreshold: 0.8, keepRecentMessages: 10, storePath: 'memory', searchBackend: 'keyword' },
    tasks: { maxSubtaskDepth: 5, maxRetries: 3 },
    tools: { timeoutMs: 30000, allowedTools: [] },
    codeWorkflows: { testFixRetries: 3 },
    channels: { web: { enabled: false, port: 3000, mode: 'websocket' } },
  };
}

const ENOENT = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

describe('loadAgentPrompt', () => {
  let readFile: MockInstance<typeof ReadFileFn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const os = await import('node:os');
    vi.mocked(os.homedir).mockReturnValue('/home/testuser');

    const fs = await import('node:fs/promises');
    readFile = vi.mocked(fs.readFile) as MockInstance<typeof ReadFileFn>;
    readFile.mockRejectedValue(ENOENT);
  });

  it('returns built-in default when no AGENT.md files exist', async () => {
    const result = await loadAgentPrompt(makeConfig());
    expect(result).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('returns user-level content when only the user file exists', async () => {
    readFile.mockImplementation(async (path) => {
      if (path === '/home/testuser/.bolt/AGENT.md') return 'user rules';
      throw ENOENT;
    });

    const result = await loadAgentPrompt(makeConfig());
    expect(result).toBe('user rules');
  });

  it('returns project-level content when only the project file exists', async () => {
    readFile.mockImplementation(async (path) => {
      if (path === '.bolt/AGENT.md') return 'project rules';
      throw ENOENT;
    });

    const result = await loadAgentPrompt(makeConfig());
    expect(result).toBe('project rules');
  });

  it('concatenates user-level then project-level when both files exist', async () => {
    readFile.mockImplementation(async (path) => {
      if (path === '/home/testuser/.bolt/AGENT.md') return 'user rules';
      if (path === '.bolt/AGENT.md') return 'project rules';
      throw ENOENT;
    });

    const result = await loadAgentPrompt(makeConfig());
    expect(result).toBe('user rules\n\nproject rules');
  });

  it('expands tilde in user file path before reading', async () => {
    await loadAgentPrompt(makeConfig());
    expect(readFile).toHaveBeenCalledWith('/home/testuser/.bolt/AGENT.md', 'utf8');
  });

  it('respects config override for userFile', async () => {
    readFile.mockImplementation(async (path) => {
      if (path === '/custom/user.md') return 'custom user';
      throw ENOENT;
    });

    const result = await loadAgentPrompt(makeConfig({ userFile: '/custom/user.md' }));
    expect(result).toBe('custom user');
  });

  it('respects config override for projectFile', async () => {
    readFile.mockImplementation(async (path) => {
      if (path === '/custom/project.md') return 'custom project';
      throw ENOENT;
    });

    const result = await loadAgentPrompt(makeConfig({ projectFile: '/custom/project.md' }));
    expect(result).toBe('custom project');
  });

  it('propagates non-ENOENT errors', async () => {
    readFile.mockRejectedValue(new Error('Permission denied'));

    await expect(loadAgentPrompt(makeConfig())).rejects.toThrow('Permission denied');
  });
});
