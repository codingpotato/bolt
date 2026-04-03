import { FfmpegRunner, FfmpegError } from '../ffmpeg/ffmpeg-runner';
import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';

export interface VideoAddAudioInput {
  /** Input video file path (within workspace root). */
  videoPath: string;
  /** Audio file to add (within workspace root). Supports mp3, aac, wav, ogg. */
  audioPath: string;
  /** Output file path (within workspace root). */
  outputPath: string;
  /**
   * How to handle audio:
   * - "replace": discard existing audio, use provided audio only (default)
   * - "mix": mix provided audio with existing video audio
   */
  mode?: 'replace' | 'mix';
  /** Volume of the added audio track (0.0–2.0). Default: 1.0. */
  audioVolume?: number;
  /** Volume of the original video audio when mode is "mix" (0.0–2.0). Default: 1.0. */
  originalVolume?: number;
  /** Trim/loop added audio to match video duration. Default: true. */
  fitToVideo?: boolean;
}

export interface VideoAddAudioOutput {
  outputPath: string;
  durationMs: number;
}

export function createVideoAddAudioTool(runner: FfmpegRunner | null): Tool<VideoAddAudioInput, VideoAddAudioOutput> {
  return {
    name: 'video_add_audio',
    description:
      'Add or mix an audio track into a video file using FFmpeg. Supports replace and mix modes. Requires ffmpeg.',
    inputSchema: {
      type: 'object',
      properties: {
        videoPath: { type: 'string', description: 'Input video file path (within workspace).' },
        audioPath: {
          type: 'string',
          description: 'Audio file to add (within workspace). Supports mp3, aac, wav, ogg.',
        },
        outputPath: { type: 'string', description: 'Output file path (within workspace).' },
        mode: {
          type: 'string',
          enum: ['replace', 'mix'],
          description: '"replace" discards original audio; "mix" blends it with the new track. Default: "replace".',
        },
        audioVolume: {
          type: 'number',
          description: 'Volume of the added audio (0.0–2.0). Default: 1.0.',
        },
        originalVolume: {
          type: 'number',
          description: 'Volume of the original video audio in mix mode (0.0–2.0). Default: 1.0.',
        },
        fitToVideo: {
          type: 'boolean',
          description: 'Trim or loop added audio to match video duration. Default: true.',
        },
      },
      required: ['videoPath', 'audioPath', 'outputPath'],
    },

    async execute(input: VideoAddAudioInput, ctx: ToolContext): Promise<VideoAddAudioOutput> {
      if (!runner) {
        throw new ToolError('ffmpeg is not available — install ffmpeg or set config.ffmpeg.path', false);
      }

      const mode = input.mode ?? 'replace';
      const audioVolume = input.audioVolume ?? 1.0;
      const originalVolume = input.originalVolume ?? 1.0;
      const fitToVideo = input.fitToVideo ?? true;

      if (audioVolume < 0 || audioVolume > 2) {
        throw new ToolError('audioVolume must be between 0.0 and 2.0', false);
      }
      if (originalVolume < 0 || originalVolume > 2) {
        throw new ToolError('originalVolume must be between 0.0 and 2.0', false);
      }

      runner.assertWithinWorkspace(input.videoPath);
      runner.assertWithinWorkspace(input.audioPath);
      runner.assertWithinWorkspace(input.outputPath);

      const { audioCodec, audioBitrate } = runner.config;
      const onProgress = (p: { frame?: number; time?: string; speed?: string }): void => {
        ctx.logger.debug('video_add_audio progress', { frame: p.frame, time: p.time, speed: p.speed });
      };

      let args: string[];
      if (mode === 'replace') {
        args = [
          '-i', input.videoPath,
          '-i', input.audioPath,
          '-map', '0:v:0', '-map', '1:a:0',
          '-c:v', 'copy', '-c:a', audioCodec, '-b:a', audioBitrate,
          '-shortest',
          input.outputPath,
        ];
      } else {
        // mix mode: blend original and added audio with amix
        const streamLoop = fitToVideo ? ['-stream_loop', '-1', '-i', input.audioPath] : ['-i', input.audioPath];
        args = [
          '-i', input.videoPath,
          ...streamLoop,
          '-filter_complex',
          `[0:a]volume=${originalVolume}[orig];[1:a]volume=${audioVolume}[added];[orig][added]amix=inputs=2:duration=first[aout]`,
          '-map', '0:v:0', '-map', '[aout]',
          '-c:v', 'copy', '-c:a', audioCodec, '-b:a', audioBitrate,
          '-shortest',
          input.outputPath,
        ];
      }

      try {
        const result = await runner.run(args, { onProgress });
        return { outputPath: result.outputPath, durationMs: result.durationMs };
      } catch (err) {
        if (err instanceof FfmpegError) {
          throw new ToolError(`video_add_audio failed: ${err.message}\n${err.stderr}`, false);
        }
        throw err;
      }
    },
  };
}
