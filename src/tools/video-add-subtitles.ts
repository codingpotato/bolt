import { readFile, writeFile, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { FfmpegRunner, FfmpegError } from '../ffmpeg/ffmpeg-runner';
import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';

export interface VideoAddSubtitlesInput {
  /** Input video file path (within workspace root). */
  videoPath: string;
  /** Subtitle file path (within workspace root). Supported: .srt, .vtt, .ass. */
  subtitlesPath: string;
  /** Output file path (within workspace root). */
  outputPath: string;
  /**
   * "soft": embed as a selectable track (default, lossless).
   * "hard": burn subtitles into video frames (re-encode required).
   */
  mode?: 'soft' | 'hard';
  /** BCP-47 language code for the subtitle track (soft mode only). Default: "und". */
  language?: string;
  /** Font size for hard-burned subtitles (hard mode only). Default: 24. */
  fontSize?: number;
  /** Font color for hard-burned subtitles in CSS hex format (hard mode only). Default: "#ffffff". */
  fontColor?: string;
}

export interface VideoAddSubtitlesOutput {
  outputPath: string;
  durationMs: number;
  subtitleCount: number;
}

const SUPPORTED_FORMATS = new Set(['.srt', '.vtt', '.ass']);

/**
 * Convert a CSS hex color like "#ffffff" to the ABGR format ffmpeg force_style expects:
 * force_style='PrimaryColour=&H00FFFFFF&'
 * Alpha is hardcoded to 00 (fully opaque).
 */
function cssHexToAbgr(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new ToolError(
      `Invalid fontColor "${hex}". Must be a CSS hex color like "#ffffff".`,
      false,
    );
  }
  const clean = hex.replace('#', '');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `00${b}${g}${r}`.toUpperCase();
}

/**
 * Convert a WebVTT string to SubRip (SRT) format.
 * Returns the SRT text and the number of cues.
 */
export function vttToSrt(vtt: string): { srt: string; count: number } {
  const lines = vtt.split(/\r?\n/);
  const cues: string[] = [];
  let i = 0;

  // Skip WEBVTT header and any metadata blocks (no '-->' line)
  while (i < lines.length && !lines[i]!.includes('-->')) i++;

  while (i < lines.length) {
    const line = lines[i]!.trim();
    if (!line.includes('-->')) {
      i++;
      continue;
    }

    // Timing line: 00:00:01.500 --> 00:00:04.000 [optional cue settings]
    const parts = line.split('-->');
    const startRaw = parts[0]!.trim().replace(/\./g, ',');
    const endRaw = parts[1]!.trim().replace(/\s.*$/, '').replace(/\./g, ',');
    const timing = `${startRaw} --> ${endRaw}`;

    // Collect cue text lines until blank line or end of file
    const textLines: string[] = [];
    i++;
    while (i < lines.length && lines[i]!.trim() !== '') {
      // Strip inline VTT timestamp tags like <00:00:01.000> and markup tags <b>, <i>, etc.
      const cleaned = lines[i]!.replace(/<[^>]+>/g, '');
      textLines.push(cleaned);
      i++;
    }

    if (textLines.length > 0) {
      const cueNum = cues.length + 1;
      cues.push(`${cueNum}\n${timing}\n${textLines.join('\n')}`);
    }
  }

  return { srt: cues.join('\n\n') + (cues.length > 0 ? '\n' : ''), count: cues.length };
}

/** Count the number of entries in an SRT file (sequences of: number, timing, text, blank). */
export function countSrtEntries(srt: string): number {
  // Each entry starts with a line containing only a number
  return (srt.match(/^\d+\s*$/gm) ?? []).length;
}

export function createVideoAddSubtitlesTool(
  runner: FfmpegRunner | null,
): Tool<VideoAddSubtitlesInput, VideoAddSubtitlesOutput> {
  return {
    name: 'video_add_subtitles',
    description:
      'Embed a subtitle file (SRT/VTT/ASS) into a video using FFmpeg. Supports soft (selectable track) and hard (burned-in) modes. Requires ffmpeg.',
    inputSchema: {
      type: 'object',
      properties: {
        videoPath: { type: 'string', description: 'Input video file path (within workspace).' },
        subtitlesPath: {
          type: 'string',
          description:
            'Subtitle file path (within workspace). Supported formats: .srt, .vtt, .ass.',
        },
        outputPath: { type: 'string', description: 'Output file path (within workspace).' },
        mode: {
          type: 'string',
          enum: ['soft', 'hard'],
          description: '"soft" embeds as a selectable track (default); "hard" burns into frames.',
        },
        language: {
          type: 'string',
          description: 'BCP-47 language code for the subtitle track (soft mode). Default: "und".',
        },
        fontSize: {
          type: 'number',
          description: 'Font size for hard-burned subtitles. Default: 24.',
        },
        fontColor: {
          type: 'string',
          description:
            'Font color for hard-burned subtitles in CSS hex format (e.g. "#ffffff"). Default: "#ffffff".',
        },
      },
      required: ['videoPath', 'subtitlesPath', 'outputPath'],
    },

    async execute(
      input: VideoAddSubtitlesInput,
      ctx: ToolContext,
    ): Promise<VideoAddSubtitlesOutput> {
      if (!runner) {
        throw new ToolError(
          'ffmpeg is not available — install ffmpeg or set config.ffmpeg.path',
          false,
        );
      }

      const mode = input.mode ?? 'soft';
      const language = input.language ?? 'und';
      const fontSize = input.fontSize ?? 24;
      const fontColor = input.fontColor ?? '#ffffff';

      runner.assertWithinWorkspace(input.videoPath);
      runner.assertWithinWorkspace(input.subtitlesPath);
      runner.assertWithinWorkspace(input.outputPath);

      const ext = extname(input.subtitlesPath).toLowerCase();
      if (!SUPPORTED_FORMATS.has(ext)) {
        throw new ToolError(
          `Unsupported subtitle format "${ext}". Supported: .srt, .vtt, .ass`,
          false,
        );
      }

      const onProgress = (p: { frame?: number; time?: string; speed?: string }): void => {
        ctx.logger.debug('video_add_subtitles progress', {
          frame: p.frame,
          time: p.time,
          speed: p.speed,
        });
        ctx.progress.onToolCall('video_add_subtitles', {
          frame: p.frame,
          time: p.time,
          speed: p.speed,
        });
      };

      // .vtt must be converted to .srt before passing to ffmpeg
      let effectiveSubPath = input.subtitlesPath;
      let tmpSrtPath: string | undefined;
      let subtitleCount = 0;

      try {
        if (ext === '.vtt') {
          const vttContent = await readFile(input.subtitlesPath, 'utf8');
          const { srt, count } = vttToSrt(vttContent);
          subtitleCount = count;
          tmpSrtPath = join(tmpdir(), `bolt-subs-${Date.now()}.srt`);
          await writeFile(tmpSrtPath, srt, 'utf8');
          effectiveSubPath = tmpSrtPath;
        } else {
          const content = await readFile(input.subtitlesPath, 'utf8');
          subtitleCount = countSrtEntries(content);
        }

        let args: string[];
        if (mode === 'soft') {
          args = [
            '-i',
            input.videoPath,
            '-i',
            effectiveSubPath,
            '-c:v',
            'copy',
            '-c:a',
            'copy',
            '-c:s',
            'mov_text',
            '-metadata:s:s:0',
            `language=${language}`,
            input.outputPath,
          ];
        } else {
          // hard mode: burn subtitles into frames
          const abgr = cssHexToAbgr(fontColor);
          // ASS files: use the dedicated `ass` filter which renders ASS styles faithfully.
          // SRT/VTT: use the `subtitles` filter with force_style for font size and colour.
          const filterArg =
            ext === '.ass'
              ? `ass=${effectiveSubPath}`
              : `subtitles=${effectiveSubPath}:force_style='FontSize=${fontSize},PrimaryColour=&H${abgr}&'`;
          args = ['-i', input.videoPath, '-vf', filterArg, '-c:a', 'copy', input.outputPath];
        }

        try {
          const result = await runner.run(args, { onProgress });
          return { outputPath: result.outputPath, durationMs: result.durationMs, subtitleCount };
        } catch (err) {
          if (err instanceof FfmpegError) {
            throw new ToolError(`video_add_subtitles failed: ${err.message}\n${err.stderr}`, false);
          }
          throw err;
        }
      } finally {
        if (tmpSrtPath) {
          await unlink(tmpSrtPath).catch(() => undefined);
        }
      }
    },
  };
}
