import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUserReviewTool } from './user-review';
import { ToolError } from './tool';
import type { ToolContext } from './tool';
import type { Channel, UserReviewResponse } from '../channels';
import { createNoopLogger } from '../logger';
import { NoopProgressReporter } from '../progress';

vi.mock('node:fs/promises');

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/workspace',
    log: { log: vi.fn().mockResolvedValue(undefined) },
    logger: createNoopLogger(),
    progress: new NoopProgressReporter(),
    ...overrides,
  };
}

function makeChannel(response: UserReviewResponse): Channel {
  return {
    receive: vi.fn() as Channel['receive'],
    send: vi.fn().mockResolvedValue(undefined),
    requestReview: vi.fn().mockResolvedValue(response),
  };
}

const baseInput = {
  content: 'Scene 1: hero walks in',
  contentType: 'script' as const,
  question: 'Does this script look good?',
};

describe('user_review tool', () => {
  const tool = createUserReviewTool();

  it('has name "user_review"', () => {
    expect(tool.name).toBe('user_review');
  });

  it('has inputSchema with required content, contentType, question fields', () => {
    expect(tool.inputSchema.required).toContain('content');
    expect(tool.inputSchema.required).toContain('contentType');
    expect(tool.inputSchema.required).toContain('question');
  });

  describe('channel.requestReview delegation', () => {
    it('delegates to channel.requestReview when available', async () => {
      const channel = makeChannel({ approved: true });
      const ctx = makeCtx({ channel });

      const result = await tool.execute(baseInput, ctx);

      expect(channel.requestReview).toHaveBeenCalledWith({
        content: baseInput.content,
        contentType: baseInput.contentType,
        question: baseInput.question,
        mediaFiles: undefined,
      });
      expect(result).toEqual({ approved: true });
    });

    it('passes mediaFiles to requestReview', async () => {
      const channel = makeChannel({ approved: false, feedback: 'too dark' });
      const ctx = makeCtx({ channel });

      // Mock fs.access to succeed
      const { access } = await import('node:fs/promises');
      vi.mocked(access).mockResolvedValue(undefined);

      const result = await tool.execute({ ...baseInput, mediaFiles: ['output/image.png'] }, ctx);

      expect(channel.requestReview).toHaveBeenCalledWith(
        expect.objectContaining({ mediaFiles: ['output/image.png'] }),
      );
      expect(result).toEqual({ approved: false, feedback: 'too dark' });
    });

    it('returns approved: false with feedback from requestReview', async () => {
      const channel = makeChannel({ approved: false, feedback: 'needs more detail' });
      const ctx = makeCtx({ channel });

      const result = await tool.execute(baseInput, ctx);

      expect(result.approved).toBe(false);
      expect(result.feedback).toBe('needs more detail');
    });
  });

  describe('ctx.confirm fallback', () => {
    it('uses confirm fallback when channel has no requestReview', async () => {
      const channel: Channel = { receive: vi.fn() as Channel['receive'], send: vi.fn() };
      const confirm = vi.fn().mockResolvedValue(true);
      const ctx = makeCtx({ channel, confirm });

      const result = await tool.execute(baseInput, ctx);

      expect(confirm).toHaveBeenCalled();
      expect(result).toEqual({ approved: true });
    });

    it('uses confirm fallback when no channel is present', async () => {
      const confirm = vi.fn().mockResolvedValue(false);
      const ctx = makeCtx({ confirm });

      const result = await tool.execute(baseInput, ctx);

      expect(confirm).toHaveBeenCalled();
      expect(result).toEqual({ approved: false });
    });

    it('confirm message includes contentType and question', async () => {
      const confirm = vi.fn().mockResolvedValue(true);
      const ctx = makeCtx({ confirm });

      await tool.execute(baseInput, ctx);

      const message: string = confirm.mock.calls[0]?.[0] as string;
      expect(message).toContain('script');
      expect(message).toContain('Does this script look good?');
    });

    it('confirm message includes content', async () => {
      const confirm = vi.fn().mockResolvedValue(true);
      const ctx = makeCtx({ confirm });

      await tool.execute(baseInput, ctx);

      const message: string = confirm.mock.calls[0]?.[0] as string;
      expect(message).toContain('Scene 1: hero walks in');
    });
  });

  describe('non-interactive context', () => {
    it('throws a non-retryable ToolError when no channel and no confirm', async () => {
      const ctx = makeCtx();

      await expect(tool.execute(baseInput, ctx)).rejects.toSatisfy(
        (err) => err instanceof ToolError && err.retryable === false,
      );
    });
  });

  describe('mediaFiles validation', () => {
    beforeEach(async () => {
      const { access } = await import('node:fs/promises');
      vi.mocked(access).mockReset();
    });

    it('throws a non-retryable ToolError when a mediaFile does not exist', async () => {
      const { access } = await import('node:fs/promises');
      vi.mocked(access).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const confirm = vi.fn().mockResolvedValue(true);
      const ctx = makeCtx({ confirm });

      await expect(
        tool.execute({ ...baseInput, mediaFiles: ['missing.png'] }, ctx),
      ).rejects.toSatisfy(
        (err) =>
          err instanceof ToolError &&
          err.retryable === false &&
          err.message.includes('missing.png'),
      );
    });

    it('proceeds when all mediaFiles exist', async () => {
      const { access } = await import('node:fs/promises');
      vi.mocked(access).mockResolvedValue(undefined);

      const channel = makeChannel({ approved: true });
      const ctx = makeCtx({ channel });

      await expect(
        tool.execute({ ...baseInput, mediaFiles: ['image.png', 'video.mp4'] }, ctx),
      ).resolves.toEqual({ approved: true });
    });

    it('validates all mediaFiles — stops at first missing file', async () => {
      const { access } = await import('node:fs/promises');
      vi.mocked(access)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const ctx = makeCtx({ confirm: vi.fn() });

      await expect(
        tool.execute({ ...baseInput, mediaFiles: ['exists.png', 'missing.png'] }, ctx),
      ).rejects.toBeInstanceOf(ToolError);
    });

    it('skips validation when mediaFiles is absent', async () => {
      const { access } = await import('node:fs/promises');
      const channel = makeChannel({ approved: true });
      const ctx = makeCtx({ channel });

      await tool.execute(baseInput, ctx);

      expect(access).not.toHaveBeenCalled();
    });

    it('skips validation when mediaFiles is empty array', async () => {
      const { access } = await import('node:fs/promises');
      const channel = makeChannel({ approved: true });
      const ctx = makeCtx({ channel });

      await tool.execute({ ...baseInput, mediaFiles: [] }, ctx);

      expect(access).not.toHaveBeenCalled();
    });
  });
});
