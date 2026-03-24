import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';
import type { ContentType } from '../channels';

export interface UserReviewInput {
  content: string;
  contentType: ContentType;
  question: string;
  mediaFiles?: string[];
}

export interface UserReviewOutput {
  approved: boolean;
  feedback?: string;
}

export function createUserReviewTool(): Tool<UserReviewInput, UserReviewOutput> {
  return {
    name: 'user_review',
    description:
      'Present content to the user for approval or feedback before proceeding with expensive operations. ' +
      'Returns whether the user approved and any feedback they provided.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to present for review.',
        },
        contentType: {
          type: 'string',
          enum: ['script', 'storyboard', 'image_prompt', 'video_prompt', 'image', 'video', 'text'],
          description: 'Type hint for rendering the content.',
        },
        question: {
          type: 'string',
          description: 'The question or instruction to show the reviewer.',
        },
        mediaFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file paths for media to preview (images, videos).',
        },
      },
      required: ['content', 'contentType', 'question'],
    },

    async execute(input: UserReviewInput, ctx: ToolContext): Promise<UserReviewOutput> {
      // Validate mediaFiles exist before presenting anything to the user.
      if (input.mediaFiles && input.mediaFiles.length > 0) {
        for (const filePath of input.mediaFiles) {
          const resolved = resolve(ctx.cwd, filePath);
          try {
            await access(resolved);
          } catch {
            throw new ToolError(`mediaFiles: file not found: ${filePath}`, false);
          }
        }
      }

      // Delegate to channel.requestReview when available.
      if (ctx.channel?.requestReview) {
        return ctx.channel.requestReview({
          content: input.content,
          contentType: input.contentType,
          question: input.question,
          mediaFiles: input.mediaFiles,
        });
      }

      // Fallback: use ctx.confirm for a simple approve/reject prompt.
      if (ctx.confirm) {
        const message =
          `[${input.contentType}] ${input.question}\n\n` +
          `${input.content}`;
        const approved = await ctx.confirm(message);
        return { approved };
      }

      throw new ToolError(
        'user_review requires an interactive channel or confirm callback — ' +
          'it cannot be used in non-interactive (sub-agent) contexts',
        false,
      );
    },
  };
}
