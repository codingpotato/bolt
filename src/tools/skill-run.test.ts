import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSkillRunTool, buildSkillPrompt } from './skill-run';
import { ToolError } from './tool';
import type { ToolContext } from './tool';
import type { Skill } from '../skills/skill-loader';
import type { AuthConfig } from '../auth/auth';
import { createNoopLogger } from '../logger';
import { NoopProgressReporter } from '../progress';

const AUTH: AuthConfig = { mode: 'api-key', credential: 'key' };
const SCRIPT = '/path/to/subagent.js';
const MODEL = 'claude-opus-4-6';

const BLOG_SKILL: Skill = {
  name: 'write-blog-post',
  description: 'Draft a blog post',
  systemPrompt: 'You are a skilled content writer.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'The topic' },
      tone: { type: 'string', enum: ['professional', 'casual'] },
    },
    required: ['topic'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      post: { type: 'string', description: 'Finished blog post' },
    },
    required: ['post'],
  },
  allowedTools: ['web_fetch', 'web_search'],
};

const REVIEW_SKILL: Skill = {
  name: 'review-code',
  description: 'Review code',
  systemPrompt: 'You are a code reviewer.',
  inputSchema: {
    type: 'object',
    properties: {
      diff: { type: 'string', description: 'The diff to review' },
    },
    required: ['diff'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      approved: { type: 'boolean' },
    },
    required: ['summary', 'approved'],
  },
};

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/workspace',
    log: { log: vi.fn().mockResolvedValue(undefined) },
    logger: createNoopLogger(),
    progress: new NoopProgressReporter(),
    ...overrides,
  };
}

type Payload = import('../subagent/subagent-runner').SubagentPayload;

describe('skill_run tool', () => {
  let lastPayload: Payload | undefined;
  const runnerSpy = vi.fn();

  function makeValidOutput(skill: Skill): string {
    if (skill.name === 'write-blog-post') return JSON.stringify({ post: 'Hello world' });
    return JSON.stringify({ summary: 'Looks good', approved: true });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    lastPayload = undefined;
    runnerSpy.mockImplementation((payload: Payload) => {
      lastPayload = payload;
      return Promise.resolve({ output: makeValidOutput(BLOG_SKILL) });
    });
  });

  const tool = createSkillRunTool([BLOG_SKILL, REVIEW_SKILL], AUTH, MODEL, SCRIPT, runnerSpy, "");

  it('has name skill_run', () => {
    expect(tool.name).toBe('skill_run');
  });

  describe('unknown skill', () => {
    it('throws ToolError for unknown skill name', async () => {
      await expect(
        tool.execute({ name: 'does-not-exist', args: {} }, makeCtx()),
      ).rejects.toThrow(ToolError);
    });

    it('error message names the unknown skill', async () => {
      await expect(
        tool.execute({ name: 'no-such-skill', args: {} }, makeCtx()),
      ).rejects.toThrow(/no-such-skill/);
    });
  });

  describe('input validation', () => {
    it('throws ToolError when a required arg is missing', async () => {
      await expect(
        tool.execute({ name: 'write-blog-post', args: {} }, makeCtx()),
      ).rejects.toThrow(ToolError);
    });

    it('error message names the missing field', async () => {
      await expect(
        tool.execute({ name: 'write-blog-post', args: {} }, makeCtx()),
      ).rejects.toThrow(/topic/);
    });

    it('accepts valid args with all required fields present', async () => {
      const result = await tool.execute(
        { name: 'write-blog-post', args: { topic: 'TypeScript' } },
        makeCtx(),
      );
      expect(result.result).toBeDefined();
    });

    it('accepts optional fields alongside required', async () => {
      const result = await tool.execute(
        { name: 'write-blog-post', args: { topic: 'TypeScript', tone: 'casual' } },
        makeCtx(),
      );
      expect(result.result).toBeDefined();
    });
  });

  describe('sub-agent execution', () => {
    it('passes systemPrompt from skill to the runner', async () => {
      await tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, makeCtx());
      expect(lastPayload?.systemPrompt).toBe(BLOG_SKILL.systemPrompt);
    });

    it('passes authConfig to the runner', async () => {
      await tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, makeCtx());
      expect(lastPayload?.authConfig).toEqual(AUTH);
    });

    it('passes model to the runner', async () => {
      await tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, makeCtx());
      expect(lastPayload?.model).toBe(MODEL);
    });

    it('includes the skill name and args in the prompt', async () => {
      await tool.execute(
        { name: 'write-blog-post', args: { topic: 'TypeScript generics' } },
        makeCtx(),
      );
      expect(lastPayload?.prompt).toContain('write-blog-post');
      expect(lastPayload?.prompt).toContain('TypeScript generics');
    });

    it('includes the output schema in the prompt', async () => {
      await tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, makeCtx());
      expect(lastPayload?.prompt).toContain('post');
    });
  });

  describe('allowlist resolution', () => {
    it('uses skill allowedTools when parent has no restriction', async () => {
      await tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, makeCtx());
      expect(lastPayload?.allowedTools).toEqual(['web_fetch', 'web_search']);
    });

    it('intersects skill allowedTools with parent allowedTools', async () => {
      const ctx = makeCtx({ allowedTools: ['web_fetch', 'bash'] });
      await tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, ctx);
      // intersection of ['web_fetch', 'web_search'] and ['web_fetch', 'bash'] = ['web_fetch']
      expect(lastPayload?.allowedTools).toEqual(['web_fetch']);
    });

    it('uses parent allowedTools when skill has none', async () => {
      const ctx = makeCtx({ allowedTools: ['file_read', 'bash'] });
      runnerSpy.mockImplementation((payload: Payload) => {
        lastPayload = payload;
        return Promise.resolve({ output: JSON.stringify({ summary: 'ok', approved: true }) });
      });
      await tool.execute({ name: 'review-code', args: { diff: 'diff text' } }, ctx);
      expect(lastPayload?.allowedTools).toEqual(['file_read', 'bash']);
    });

    it('passes undefined allowedTools when neither skill nor parent restricts', async () => {
      runnerSpy.mockImplementation((payload: Payload) => {
        lastPayload = payload;
        return Promise.resolve({ output: JSON.stringify({ summary: 'ok', approved: true }) });
      });
      await tool.execute({ name: 'review-code', args: { diff: 'diff text' } }, makeCtx());
      expect(lastPayload?.allowedTools).toBeUndefined();
    });
  });

  describe('output validation', () => {
    it('returns parsed result on valid JSON output', async () => {
      const result = await tool.execute(
        { name: 'write-blog-post', args: { topic: 'TS' } },
        makeCtx(),
      );
      expect(result.result).toEqual({ post: 'Hello world' });
    });

    it('throws ToolError when sub-agent produces non-JSON output', async () => {
      runnerSpy.mockResolvedValue({ output: 'sorry, I cannot do that' });
      await expect(
        tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, makeCtx()),
      ).rejects.toThrow(ToolError);
    });

    it('non-JSON error mentions the skill name', async () => {
      runnerSpy.mockResolvedValue({ output: 'not json' });
      await expect(
        tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, makeCtx()),
      ).rejects.toThrow(/write-blog-post/);
    });

    it('throws ToolError when required output field is missing', async () => {
      runnerSpy.mockResolvedValue({ output: JSON.stringify({ wrong_field: 'x' }) });
      await expect(
        tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, makeCtx()),
      ).rejects.toThrow(ToolError);
    });

    it('output validation error mentions the missing field', async () => {
      runnerSpy.mockResolvedValue({ output: JSON.stringify({ wrong_field: 'x' }) });
      await expect(
        tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, makeCtx()),
      ).rejects.toThrow(/post/);
    });
  });

  describe('sub-agent failure', () => {
    it('throws a retryable ToolError when runner throws', async () => {
      runnerSpy.mockRejectedValue(new Error('process crashed'));
      await expect(
        tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, makeCtx()),
      ).rejects.toThrow(ToolError);
    });

    it('retryable ToolError includes the original error message', async () => {
      runnerSpy.mockRejectedValue(new Error('OOM'));
      let caught: ToolError | undefined;
      try {
        await tool.execute({ name: 'write-blog-post', args: { topic: 'TS' } }, makeCtx());
      } catch (e) {
        caught = e as ToolError;
      }
      expect(caught).toBeDefined();
      expect(caught?.message).toContain('OOM');
      expect(caught?.retryable).toBe(true);
    });
  });

  describe('buildSkillPrompt', () => {
    it('includes the skill name', () => {
      const schema = { type: 'object', properties: { out: { type: 'string' } }, required: ['out'] };
      const prompt = buildSkillPrompt('my-skill', { key: 'val' }, schema);
      expect(prompt).toContain('my-skill');
    });

    it('includes serialized args', () => {
      const schema = { type: 'object', properties: {} };
      const prompt = buildSkillPrompt('s', { topic: 'TypeScript' }, schema);
      expect(prompt).toContain('TypeScript');
    });

    it('includes the output schema', () => {
      const schema = { type: 'object', properties: { result: { type: 'string' } }, required: ['result'] };
      const prompt = buildSkillPrompt('s', {}, schema);
      expect(prompt).toContain('"result"');
    });
  });
});
