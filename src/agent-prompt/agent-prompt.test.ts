import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { readFile as ReadFileFn } from 'node:fs/promises';
import { loadAgentPrompt } from './agent-prompt';
import { BUILTIN_AGENT_MD } from '../assets';
import type { Config } from '../config/config';

vi.mock('node:fs/promises');
vi.mock('node:os');
vi.mock('../assets', () => ({
  BUILTIN_AGENT_MD: '/builtin/AGENT.md',
  BUILTIN_SKILLS_DIR: '/builtin/skills',
  BUILTIN_WORKFLOWS_DIR: '/builtin/workflows',
}));

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
    memory: { compactThreshold: 0.8, keepRecentMessages: 10, storePath: 'memory', sessionPath: 'sessions', taskHistoryMessages: 20, taskHistoryTokenBudget: 20000, injectRecentChat: true, searchBackend: 'keyword' },
    search: { provider: 'searxng' as const, maxResults: 10 },
    tasks: { maxSubtaskDepth: 5, maxRetries: 3 },
    tools: { timeoutMs: 30000, allowedTools: [] },
    comfyui: { servers: [], workflows: { text2img: 'image_z_image_turbo', img2video: 'video_ltx2_3_i2v' }, pollIntervalMs: 2000, timeoutMs: 300000, maxConcurrentPerServer: 2 },
    codeWorkflows: { testFixRetries: 3 },
    cli: { progress: true, verbose: false },
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
    readFile.mockImplementation(async (path) => {
      if (path === BUILTIN_AGENT_MD) return 'built-in prompt';
      throw ENOENT;
    });
  });

  it('returns built-in default when no AGENT.md files exist', async () => {
    const result = await loadAgentPrompt(makeConfig());
    expect(result).toBe('built-in prompt');
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
