import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRunSkillSlashCommand } from './run-skill-slash-command';
import type { Skill } from './skill-loader';
import type { SlashContext } from '../slash-commands/slash-commands';
import type { AuthConfig } from '../auth/auth';

const AUTH: AuthConfig = { mode: 'api-key', credential: 'key' };
const MODEL = 'claude-opus-4-6';
const SCRIPT = '/path/to/subagent.js';
const EXEC = process.execPath;

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
    properties: { post: { type: 'string' } },
    required: ['post'],
  },
  allowedTools: ['web_fetch', 'web_search'],
};

const SIMPLE_SKILL: Skill = {
  name: 'summarize',
  description: 'Summarize text',
  systemPrompt: 'Summarize the input.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  outputSchema: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
};

type Payload = import('../subagent/subagent-runner').SubagentPayload;

function makeCtx(): { ctx: SlashContext; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue(undefined);
  return { ctx: { send, sessionId: 'session-1' }, send };
}

describe('createRunSkillSlashCommand', () => {
  let lastPayload: Payload | undefined;
  const runnerSpy = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    lastPayload = undefined;
    runnerSpy.mockImplementation((payload: Payload) => {
      lastPayload = payload;
      return Promise.resolve({ output: '{"post":"Hello world"}' });
    });
  });

  const cmd = createRunSkillSlashCommand(
    [BLOG_SKILL, SIMPLE_SKILL],
    AUTH,
    MODEL,
    SCRIPT,
    EXEC,
    runnerSpy,
  );

  it('has name "run-skill"', () => {
    expect(cmd.name).toBe('run-skill');
  });

  it('has a description', () => {
    expect(cmd.description).toBeTruthy();
  });

  describe('missing skill name', () => {
    it('sends usage message when no args given', async () => {
      const { ctx, send } = makeCtx();
      await cmd.execute([], ctx);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toContain('Usage:');
    });

    it('lists available skill names in the usage message', async () => {
      const { ctx, send } = makeCtx();
      await cmd.execute([], ctx);
      const msg = send.mock.calls[0]?.[0] as string;
      expect(msg).toContain('write-blog-post');
      expect(msg).toContain('summarize');
    });

    it('does not call the runner', async () => {
      const { ctx } = makeCtx();
      await cmd.execute([], ctx);
      expect(runnerSpy).not.toHaveBeenCalled();
    });

    it('returns empty SlashResult', async () => {
      const { ctx } = makeCtx();
      const result = await cmd.execute([], ctx);
      expect(result).toEqual({});
    });
  });

  describe('unknown skill', () => {
    it('sends error message for unknown skill', async () => {
      const { ctx, send } = makeCtx();
      await cmd.execute(['no-such-skill'], ctx);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toContain('no-such-skill');
    });

    it('does not call the runner', async () => {
      const { ctx } = makeCtx();
      await cmd.execute(['no-such-skill'], ctx);
      expect(runnerSpy).not.toHaveBeenCalled();
    });
  });

  describe('invalid argument format', () => {
    it('sends error when key does not start with --', async () => {
      const { ctx, send } = makeCtx();
      await cmd.execute(['write-blog-post', 'topic', 'TS'], ctx);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toContain('Invalid argument');
    });

    it('sends error when a key has no paired value', async () => {
      const { ctx, send } = makeCtx();
      // odd number of remaining args: '--topic' with no value
      await cmd.execute(['write-blog-post', '--topic'], ctx);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toContain('Invalid argument');
    });
  });

  describe('missing required args', () => {
    it('sends error listing missing fields', async () => {
      const { ctx, send } = makeCtx();
      await cmd.execute(['write-blog-post'], ctx);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toContain('--topic');
    });

    it('does not call the runner', async () => {
      const { ctx } = makeCtx();
      await cmd.execute(['write-blog-post'], ctx);
      expect(runnerSpy).not.toHaveBeenCalled();
    });
  });

  describe('successful execution', () => {
    it('calls the runner with the skill system prompt', async () => {
      const { ctx } = makeCtx();
      await cmd.execute(['write-blog-post', '--topic', 'TypeScript'], ctx);
      expect(lastPayload?.systemPrompt).toBe(BLOG_SKILL.systemPrompt);
    });

    it('calls the runner with authConfig and model', async () => {
      const { ctx } = makeCtx();
      await cmd.execute(['write-blog-post', '--topic', 'TypeScript'], ctx);
      expect(lastPayload?.authConfig).toEqual(AUTH);
      expect(lastPayload?.model).toBe(MODEL);
    });

    it('includes skill name and args in the runner prompt', async () => {
      const { ctx } = makeCtx();
      await cmd.execute(['write-blog-post', '--topic', 'TypeScript'], ctx);
      expect(lastPayload?.prompt).toContain('write-blog-post');
      expect(lastPayload?.prompt).toContain('TypeScript');
    });

    it('passes skill allowedTools to the runner', async () => {
      const { ctx } = makeCtx();
      await cmd.execute(['write-blog-post', '--topic', 'TypeScript'], ctx);
      expect(lastPayload?.allowedTools).toEqual(['web_fetch', 'web_search']);
    });

    it('omits allowedTools when skill has none', async () => {
      runnerSpy.mockImplementation((payload: Payload) => {
        lastPayload = payload;
        return Promise.resolve({ output: '{"summary":"short"}' });
      });
      const { ctx } = makeCtx();
      await cmd.execute(['summarize', '--text', 'hello'], ctx);
      expect(lastPayload?.allowedTools).toBeUndefined();
    });

    it('sends the runner output to the user', async () => {
      const { ctx, send } = makeCtx();
      await cmd.execute(['write-blog-post', '--topic', 'TypeScript'], ctx);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toBe('{"post":"Hello world"}');
    });

    it('returns empty SlashResult (no exit)', async () => {
      const { ctx } = makeCtx();
      const result = await cmd.execute(['write-blog-post', '--topic', 'TypeScript'], ctx);
      expect(result).toEqual({});
    });
  });

  describe('runner failure', () => {
    it('sends error message when runner throws', async () => {
      runnerSpy.mockRejectedValue(new Error('process crashed'));
      const { ctx, send } = makeCtx();
      await cmd.execute(['write-blog-post', '--topic', 'TS'], ctx);
      expect(send).toHaveBeenCalledOnce();
      expect(send.mock.calls[0]?.[0]).toContain('process crashed');
    });

    it('includes the skill name in the failure message', async () => {
      runnerSpy.mockRejectedValue(new Error('OOM'));
      const { ctx, send } = makeCtx();
      await cmd.execute(['write-blog-post', '--topic', 'TS'], ctx);
      expect(send.mock.calls[0]?.[0]).toContain('write-blog-post');
    });

    it('returns empty SlashResult even on failure', async () => {
      runnerSpy.mockRejectedValue(new Error('crash'));
      const { ctx } = makeCtx();
      const result = await cmd.execute(['write-blog-post', '--topic', 'TS'], ctx);
      expect(result).toEqual({});
    });
  });
});
