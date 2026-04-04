import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadAgentPrompt,
  ensureAgentFile,
  appendSkillsCatalog,
  appendToolsReference,
  estimateTokenCount,
  assembleSystemPrompt,
  extractPromptSections,
} from './agent-prompt';
import type { Config } from '../config/config';
import type { Skill } from '../skills/skill-loader';
import type { Tool } from '../tools/tool';

vi.mock('node:fs/promises');
vi.mock('node:fs');
vi.mock('../assets', () => ({
  BUILTIN_AGENT_MD: '/builtin/AGENT.md',
  BUILTIN_SKILLS_DIR: '/builtin/skills',
  BUILTIN_WORKFLOWS_DIR: '/builtin/workflows',
}));

function makeConfig(overrides: Partial<Config['agentPrompt']> = {}): Config {
  return {
    model: 'claude-test',
    dataDir: '.bolt',
    logLevel: 'info',
    workspace: { root: '/workspace' },
    auth: {},
    local: {},
    agentPrompt: {
      projectFile: '/workspace/.bolt/AGENT.md',
      suggestionsPath: '.bolt/suggestions',
      maxTokens: 8000,
      watchForChanges: true,
      ...overrides,
    },
    memory: {
      compactThreshold: 0.8,
      keepRecentMessages: 10,
      storePath: 'memory',
      sessionPath: 'sessions',
      taskHistoryMessages: 20,
      taskHistoryTokenBudget: 20000,
      injectRecentChat: true,
      searchBackend: 'keyword',
    },
    search: { provider: 'searxng' as const, maxResults: 10 },
    tasks: { maxSubtaskDepth: 5, maxRetries: 3 },
    tools: { timeoutMs: 30000, allowedTools: [] },
    comfyui: {
      servers: [],
      workflows: { text2img: 'img1', img2video: 'vid1' },
      pollIntervalMs: 2000,
      timeoutMs: 300000,
      maxConcurrentPerServer: 2,
    },
    ffmpeg: {
      videoCodec: 'libx264',
      crf: 23,
      preset: 'fast',
      audioCodec: 'aac',
      audioBitrate: '128k',
    },
    codeWorkflows: { testFixRetries: 3 },
    cli: { progress: true, verbose: false },
    channels: { web: { enabled: false, port: 3000, mode: 'http' as const } },
  };
}

describe('loadAgentPrompt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads .bolt/AGENT.md when it exists', async () => {
    const { readFile } = await import('node:fs/promises');
    const fs = await import('node:fs');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue('# My Agent\n\nYou are helpful.' as never);

    const result = await loadAgentPrompt(makeConfig());
    expect(result).toBe('# My Agent\n\nYou are helpful.');
  });
});

describe('ensureAgentFile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('copies built-in when file does not exist', async () => {
    const { copyFile, mkdir } = await import('node:fs/promises');
    const fs = await import('node:fs');
    vi.mocked(fs.existsSync).mockReturnValueOnce(false).mockReturnValueOnce(true);
    vi.mocked(copyFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);

    await ensureAgentFile(makeConfig());
    expect(copyFile).toHaveBeenCalled();
  });

  it('does nothing when file exists', async () => {
    const { copyFile } = await import('node:fs/promises');
    const fs = await import('node:fs');
    vi.mocked(fs.existsSync).mockReturnValue(true);

    await ensureAgentFile(makeConfig());
    expect(copyFile).not.toHaveBeenCalled();
  });
});

describe('appendSkillsCatalog', () => {
  it('appends a skills table when skills are provided', () => {
    const skills: Skill[] = [
      {
        name: 'write-blog',
        description: 'Write a blog post',
        systemPrompt: '',
        inputSchema: {},
        outputSchema: {},
      },
      {
        name: 'review-code',
        description: 'Review code',
        systemPrompt: '',
        inputSchema: {},
        outputSchema: {},
      },
    ];
    const result = appendSkillsCatalog('# Base', skills);
    expect(result).toContain('## Available Skills');
    expect(result).toContain('`write-blog`');
    expect(result).toContain('`review-code`');
  });

  it('returns prompt unchanged when no skills', () => {
    expect(appendSkillsCatalog('# Base', [])).toBe('# Base');
  });
});

describe('appendToolsReference', () => {
  it('appends a tools table when tools are provided', () => {
    const tools: Tool[] = [
      {
        name: 'file_read',
        description: 'Read a file',
        inputSchema: {},
        async execute() {
          return {} as never;
        },
      },
      {
        name: 'bash',
        description: 'Run shell commands',
        inputSchema: {},
        async execute() {
          return {} as never;
        },
      },
    ];
    const result = appendToolsReference('# Base', tools);
    expect(result).toContain('## Available Tools');
    expect(result).toContain('`file_read`');
    expect(result).toContain('`bash`');
  });

  it('returns prompt unchanged when no tools', () => {
    expect(appendToolsReference('# Base', [])).toBe('# Base');
  });
});

describe('estimateTokenCount', () => {
  it('estimates tokens using 1.3x word count', () => {
    expect(estimateTokenCount('hello world')).toBe(3);
    expect(estimateTokenCount('one two three four five')).toBe(7);
  });

  it('handles empty string', () => {
    expect(estimateTokenCount('')).toBe(0);
    expect(estimateTokenCount('   ')).toBe(0);
  });
});

describe('assembleSystemPrompt', () => {
  beforeEach(() => vi.clearAllMocks());

  it('combines AGENT.md + skills + tools', async () => {
    const { readFile } = await import('node:fs/promises');
    const fs = await import('node:fs');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue('# Agent Rules' as never);

    const skills: Skill[] = [
      {
        name: 'write-blog',
        description: 'Write a blog post',
        systemPrompt: '',
        inputSchema: {},
        outputSchema: {},
      },
    ];
    const tools: Tool[] = [
      {
        name: 'file_read',
        description: 'Read a file',
        inputSchema: {},
        async execute() {
          return {} as never;
        },
      },
    ];

    const result = await assembleSystemPrompt(makeConfig(), skills, tools);
    expect(result).toContain('# Agent Rules');
    expect(result).toContain('## Available Skills');
    expect(result).toContain('## Available Tools');
  });
});

describe('extractPromptSections', () => {
  const samplePrompt = `# Agent

## Operating Modes

Chat mode for quick questions.
Task-driven for multi-step goals.

## Tools

Some tools section.

## Safety Rules

Always validate paths.
Never run dangerous commands.

## Communication Style

Be concise.

## Other Section

Some other content.
`;

  it('extracts named sections', () => {
    const result = extractPromptSections(samplePrompt, [
      'Safety Rules',
      'Communication Style',
      'Operating Modes',
    ]);
    expect(result['Safety Rules']).toContain('Always validate paths');
    expect(result['Communication Style']).toContain('Be concise');
    expect(result['Operating Modes']).toContain('Chat mode');
  });

  it('skips missing sections', () => {
    const result = extractPromptSections(samplePrompt, ['Missing Section']);
    expect(result['Missing Section']).toBeUndefined();
  });

  it('stops at next top-level section header', () => {
    const result = extractPromptSections(samplePrompt, ['Operating Modes']);
    expect(result['Operating Modes']).toContain('Chat mode');
    expect(result['Operating Modes']).not.toContain('## Tools');
  });

  it('returns empty object when no sections match', () => {
    const result = extractPromptSections('# Empty', ['Safety Rules']);
    expect(result).toEqual({});
  });
});

describe('assembleSystemPrompt with custom path', () => {
  beforeEach(() => vi.clearAllMocks());

  it('respects config override for projectFile', async () => {
    const { readFile } = await import('node:fs/promises');
    const fs = await import('node:fs');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(readFile).mockResolvedValue('custom content' as never);

    const result = await assembleSystemPrompt(
      makeConfig({ projectFile: '/custom/project.md' }),
      [],
      [],
    );
    expect(result).toBe('custom content');
    expect(readFile).toHaveBeenCalledWith('/custom/project.md', 'utf8');
  });
});
