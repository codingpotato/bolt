import { readFile } from 'node:fs/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from './tool';
import {
  createVideoAddSubtitlesTool,
  countSrtEntries,
  type VideoAddSubtitlesInput,
  vttToSrt,
} from './video-add-subtitles';
import { FfmpegRunner, FfmpegError } from '../ffmpeg/ffmpeg-runner';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue('1\n00:00:01,000 --> 00:00:04,000\nHello'),
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

describe('vttToSrt', () => {
  it('converts a simple VTT file to SRT', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world

00:00:05.500 --> 00:00:08.000
Goodbye world
`;
    const { srt, count } = vttToSrt(vtt);
    expect(count).toBe(2);
    expect(srt).toContain('00:00:01,000 --> 00:00:04,000');
    expect(srt).toContain('00:00:05,500 --> 00:00:08,000');
    expect(srt).toContain('Hello world');
    expect(srt).toContain('Goodbye world');
  });

  it('strips VTT markup tags', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:03.000
<b>Bold text</b> and <i>italic</i>
`;
    const { srt, count } = vttToSrt(vtt);
    expect(count).toBe(1);
    expect(srt).toContain('Bold text and italic');
    expect(srt).not.toContain('<b>');
    expect(srt).not.toContain('<i>');
  });

  it('returns empty result for VTT with no cues', () => {
    const vtt = 'WEBVTT\n';
    const { srt, count } = vttToSrt(vtt);
    expect(count).toBe(0);
    expect(srt).toBe('');
  });
});

describe('videoAddSubtitlesTool', () => {
  let mockRunner: {
    assertWithinWorkspace: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    config: {
      videoCodec: string;
      crf: number;
      preset: string;
      audioCodec: string;
      audioBitrate: string;
    };
  };
  let tool: ReturnType<typeof createVideoAddSubtitlesTool>;
  let ctx: ToolContext;

  const successResult = {
    outputPath: '/workspace/output.mp4',
    durationMs: 400,
    stderr: '',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockRunner = {
      assertWithinWorkspace: vi.fn(),
      run: vi.fn().mockResolvedValue(successResult),
      config: {
        videoCodec: 'libx264',
        crf: 23,
        preset: 'medium',
        audioCodec: 'aac',
        audioBitrate: '192k',
      },
    };

    tool = createVideoAddSubtitlesTool(mockRunner as unknown as FfmpegRunner);

    ctx = {
      cwd: '/workspace',
      log: { log: vi.fn().mockResolvedValue(undefined) },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      progress: {
        onSessionStart: vi.fn(),
        onThinking: vi.fn(),
        onToolCall: vi.fn(),
        onToolResult: vi.fn(),
        onTaskStatusChange: vi.fn(),
        onContextInjection: vi.fn(),
        onMemoryCompaction: vi.fn(),
        onLlmCall: vi.fn(),
        onLlmResponse: vi.fn(),
        onRetry: vi.fn(),
        onSubagentStart: vi.fn(),
        onSubagentEnd: vi.fn(),
        onSubagentError: vi.fn(),
        onSubagentThinking: vi.fn(),
        onSubagentToolCall: vi.fn(),
        onSubagentToolResult: vi.fn(),
        onSubagentRetry: vi.fn(),
      },
    };
  });

  it('has the name "video_add_subtitles"', () => {
    expect(tool.name).toBe('video_add_subtitles');
  });

  it('has inputSchema with required videoPath, subtitlesPath, and outputPath fields', () => {
    expect(tool.inputSchema.required).toContain('videoPath');
    expect(tool.inputSchema.required).toContain('subtitlesPath');
    expect(tool.inputSchema.required).toContain('outputPath');
  });

  it('validates all paths are within workspace', async () => {
    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.srt',
      outputPath: 'output.mp4',
    };
    await tool.execute(input, ctx);

    expect(mockRunner.assertWithinWorkspace).toHaveBeenCalledWith('video.mp4');
    expect(mockRunner.assertWithinWorkspace).toHaveBeenCalledWith('subs.srt');
    expect(mockRunner.assertWithinWorkspace).toHaveBeenCalledWith('output.mp4');
  });

  it('uses soft mode by default (mov_text)', async () => {
    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.srt',
      outputPath: 'output.mp4',
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0] as string[];
    expect(callArgs).toContain('-c:s');
    expect(callArgs).toContain('mov_text');
    expect(callArgs).toContain('language=und');
  });

  it('uses hard mode with subtitles filter when mode is "hard"', async () => {
    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.srt',
      outputPath: 'output.mp4',
      mode: 'hard',
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0] as string[];
    const vfArg = callArgs.find((a: string) => a.includes('subtitles='));
    expect(vfArg).toBeDefined();
    expect(vfArg).toContain('force_style');
  });

  it('uses custom fontSize and fontColor in hard mode', async () => {
    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.srt',
      outputPath: 'output.mp4',
      mode: 'hard',
      fontSize: 32,
      fontColor: '#ff0000',
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0] as string[];
    const vfArg = callArgs.find((a: string) => a.includes('subtitles='));
    expect(vfArg).toContain('FontSize=32');
    expect(vfArg).toContain('PrimaryColour=&H000000FF&');
  });

  it('does not apply force_style for ASS files in hard mode', async () => {
    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.ass',
      outputPath: 'output.mp4',
      mode: 'hard',
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0] as string[];
    const vfArg = callArgs.find((a: string) => a.includes('subtitles='));
    expect(vfArg).toBeDefined();
    expect(vfArg).not.toContain('force_style');
  });

  it('throws ToolError for unsupported subtitle formats', async () => {
    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.txt',
      outputPath: 'output.mp4',
    };
    await expect(tool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Unsupported subtitle format'),
      retryable: false,
    });
  });

  it('throws non-retryable ToolError when runner is null', async () => {
    const nullTool = createVideoAddSubtitlesTool(null);
    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.srt',
      outputPath: 'output.mp4',
    };
    await expect(nullTool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('ffmpeg is not available'),
      retryable: false,
    });
  });

  it('throws ToolError when ffmpeg run fails', async () => {
    mockRunner.run.mockRejectedValue(
      new FfmpegError('subtitle encoding error', 'error details', 1),
    );

    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.srt',
      outputPath: 'output.mp4',
    };
    await expect(tool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('video_add_subtitles failed'),
      retryable: false,
    });
  });

  it('uses custom language in soft mode', async () => {
    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.srt',
      outputPath: 'output.mp4',
      language: 'en',
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0] as string[];
    expect(callArgs).toContain('language=en');
  });

  it('returns subtitleCount in output', async () => {
    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.srt',
      outputPath: 'output.mp4',
    };
    const result = await tool.execute(input, ctx);

    expect(result.subtitleCount).toBeGreaterThanOrEqual(0);
  });

  it('throws ToolError when readFile fails for .srt', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('EACCES: permission denied'));

    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.srt',
      outputPath: 'output.mp4',
    };
    await expect(tool.execute(input, ctx)).rejects.toThrow();
  });

  it('throws ToolError when readFile fails for .vtt', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(new Error('ENOENT: no such file'));

    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.vtt',
      outputPath: 'output.mp4',
    };
    await expect(tool.execute(input, ctx)).rejects.toThrow();
  });

  it('throws ToolError for invalid fontColor in hard mode', async () => {
    const input: VideoAddSubtitlesInput = {
      videoPath: 'video.mp4',
      subtitlesPath: 'subs.srt',
      outputPath: 'output.mp4',
      mode: 'hard',
      fontColor: 'notahex',
    };
    await expect(tool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Invalid fontColor'),
      retryable: false,
    });
  });
});

describe('countSrtEntries', () => {
  it('counts entries in a valid SRT string', () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
Hello

2
00:00:05,000 --> 00:00:08,000
World
`;
    expect(countSrtEntries(srt)).toBe(2);
  });

  it('returns 0 for empty string', () => {
    expect(countSrtEntries('')).toBe(0);
  });

  it('returns 0 for SRT with no numbered entries', () => {
    expect(countSrtEntries('just some text')).toBe(0);
  });

  it('counts a single entry', () => {
    const srt = `1
00:00:00,000 --> 00:00:02,000
One entry
`;
    expect(countSrtEntries(srt)).toBe(1);
  });
});
