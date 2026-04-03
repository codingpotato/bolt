import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FfmpegRunner, FfmpegError } from '../ffmpeg/ffmpeg-runner';
import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';

export interface VideoMergeInput {
  /** Ordered list of clip paths to concatenate (≥ 2, within workspace). */
  clips: string[];
  /** Output file path within workspace. Extension determines container. */
  outputPath: string;
  /** Force re-encode when clips have mismatched resolutions or codecs. Default: false. */
  reencode?: boolean;
}

export interface VideoMergeOutput {
  outputPath: string;
  durationMs: number;
  videoDurationSec: number;
}

/** Parse the total duration in seconds from ffmpeg stderr. */
function parseDurationSec(stderr: string): number {
  // ffmpeg prints: Duration: HH:MM:SS.mm, ...
  const match = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  if (!match) return 0;
  const h = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);
  const s = parseFloat(match[3]!);
  return h * 3600 + m * 60 + s;
}

export function createVideoMergeTool(
  runner: FfmpegRunner | null,
): Tool<VideoMergeInput, VideoMergeOutput> {
  return {
    name: 'video_merge',
    description:
      'Concatenate multiple video clips into a single output file using FFmpeg. Requires ffmpeg to be installed.',
    inputSchema: {
      type: 'object',
      properties: {
        clips: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Ordered list of clip paths to concatenate (minimum 2, all within workspace).',
        },
        outputPath: {
          type: 'string',
          description:
            'Output file path within workspace. Extension determines container (e.g. .mp4).',
        },
        reencode: {
          type: 'boolean',
          description:
            'Force re-encode when clips have mismatched resolutions or codecs. Default: false (stream-copy, faster).',
        },
      },
      required: ['clips', 'outputPath'],
    },

    async execute(input: VideoMergeInput, ctx: ToolContext): Promise<VideoMergeOutput> {
      if (!runner) {
        throw new ToolError(
          'ffmpeg is not available — install ffmpeg or set config.ffmpeg.path',
          false,
        );
      }

      if (!Array.isArray(input.clips) || input.clips.length < 2) {
        throw new ToolError('video_merge requires at least 2 clips', false);
      }

      // Validate all paths
      for (const clip of input.clips) {
        runner.assertWithinWorkspace(clip);
      }
      runner.assertWithinWorkspace(input.outputPath);

      // Write concat list to a temp file
      const listPath = join(tmpdir(), `bolt-concat-${Date.now()}.txt`);
      const listContent = input.clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n');
      await writeFile(listPath, listContent, 'utf8');

      const onProgress = (p: { frame?: number; time?: string; speed?: string }): void => {
        ctx.logger.debug('video_merge progress', { frame: p.frame, time: p.time, speed: p.speed });
      };

      try {
        const result = await runMerge(
          runner,
          listPath,
          input.outputPath,
          input.reencode ?? false,
          onProgress,
        );
        return {
          outputPath: result.outputPath,
          durationMs: result.durationMs,
          videoDurationSec: parseDurationSec(result.stderr),
        };
      } catch (err) {
        // If stream-copy failed and reencode wasn't already requested, retry with re-encode
        if (err instanceof FfmpegError && !(input.reencode ?? false)) {
          ctx.logger.debug('video_merge stream-copy failed, retrying with re-encode', {
            exitCode: err.exitCode,
          });
          try {
            const result = await runMerge(runner, listPath, input.outputPath, true, onProgress);
            return {
              outputPath: result.outputPath,
              durationMs: result.durationMs,
              videoDurationSec: parseDurationSec(result.stderr),
            };
          } catch (retryErr) {
            if (retryErr instanceof FfmpegError) {
              throw new ToolError(
                `video_merge failed: ${retryErr.message}\n${retryErr.stderr}`,
                false,
              );
            }
            throw retryErr;
          }
        }
        if (err instanceof FfmpegError) {
          throw new ToolError(`video_merge failed: ${err.message}\n${err.stderr}`, false);
        }
        throw err;
      } finally {
        await unlink(listPath).catch(() => undefined);
      }
    },
  };
}

async function runMerge(
  runner: FfmpegRunner,
  listPath: string,
  outputPath: string,
  reencode: boolean,
  onProgress: (p: { frame?: number; time?: string; speed?: string }) => void,
) {
  if (reencode) {
    const { videoCodec, crf, preset, audioCodec, audioBitrate } = runner.config;
    return runner.run(
      [
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-vf',
        'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2',
        '-c:v',
        videoCodec,
        '-crf',
        String(crf),
        '-preset',
        preset,
        '-c:a',
        audioCodec,
        '-b:a',
        audioBitrate,
        outputPath,
      ],
      { onProgress },
    );
  }
  return runner.run(['-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath], {
    onProgress,
  });
}
