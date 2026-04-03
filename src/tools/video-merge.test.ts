import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from './tool';
import { createVideoMergeTool, parseDurationSec, type VideoMergeInput } from './video-merge';
import { FfmpegRunner, FfmpegError } from '../ffmpeg/ffmpeg-runner';

describe('videoMergeTool', () => {
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
  let tool: ReturnType<typeof createVideoMergeTool>;
  let ctx: ToolContext;

  const successResult = {
    outputPath: '/workspace/output.mp4',
    durationMs: 500,
    stderr: 'Duration: 00:00:10.50, start: 0.000000, bitrate: 1000 kb/s',
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

    tool = createVideoMergeTool(mockRunner as unknown as FfmpegRunner);

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
        onRetry: vi.fn(),
      },
    };
  });

  it('has the name "video_merge"', () => {
    expect(tool.name).toBe('video_merge');
  });

  it('has inputSchema with required clips and outputPath fields', () => {
    expect(tool.inputSchema.required).toContain('clips');
    expect(tool.inputSchema.required).toContain('outputPath');
  });

  it('throws ToolError when fewer than 2 clips are provided', async () => {
    const input: VideoMergeInput = { clips: ['clip1.mp4'], outputPath: 'out.mp4' };
    await expect(tool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('at least 2 clips'),
      retryable: false,
    });
  });

  it('throws ToolError when clips array is empty', async () => {
    const input: VideoMergeInput = { clips: [], outputPath: 'out.mp4' };
    await expect(tool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('at least 2 clips'),
      retryable: false,
    });
  });

  it('validates all paths are within workspace', async () => {
    const input: VideoMergeInput = {
      clips: ['clip1.mp4', 'clip2.mp4'],
      outputPath: 'out.mp4',
    };
    const result = await tool.execute(input, ctx);

    expect(mockRunner.assertWithinWorkspace).toHaveBeenCalledWith('clip1.mp4');
    expect(mockRunner.assertWithinWorkspace).toHaveBeenCalledWith('clip2.mp4');
    expect(mockRunner.assertWithinWorkspace).toHaveBeenCalledWith('out.mp4');
    expect(result.outputPath).toBe('/workspace/output.mp4');
    expect(result.videoDurationSec).toBeGreaterThan(0);
  });

  it('uses stream-copy by default (no re-encode)', async () => {
    const input: VideoMergeInput = {
      clips: ['a.mp4', 'b.mp4'],
      outputPath: 'merged.mp4',
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0];
    expect(callArgs).toContain('-c');
    expect(callArgs).toContain('copy');
  });

  it('uses re-encode when reencode is true', async () => {
    const input: VideoMergeInput = {
      clips: ['a.mp4', 'b.mp4'],
      outputPath: 'merged.mp4',
      reencode: true,
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0];
    expect(callArgs).toContain('-c:v');
    expect(callArgs).toContain('libx264');
    expect(callArgs).toContain('-crf');
  });

  it('retries with re-encode when stream-copy fails', async () => {
    mockRunner.run
      .mockRejectedValueOnce(new FfmpegError('codec mismatch', 'error', 1))
      .mockResolvedValueOnce(successResult);

    const input: VideoMergeInput = {
      clips: ['a.mp4', 'b.mp4'],
      outputPath: 'merged.mp4',
    };
    const result = await tool.execute(input, ctx);

    expect(mockRunner.run).toHaveBeenCalledTimes(2);
    const retryArgs = mockRunner.run.mock.calls[1]![0]!;
    expect(retryArgs).toContain('-c:v');
    expect(result.outputPath).toBe('/workspace/output.mp4');
  });

  it('throws ToolError when ffmpeg fails and re-encode also fails', async () => {
    mockRunner.run
      .mockRejectedValueOnce(new FfmpegError('stream-copy failed', 'err1', 1))
      .mockRejectedValueOnce(new FfmpegError('re-encode also failed', 'err2', 1));

    const input: VideoMergeInput = {
      clips: ['a.mp4', 'b.mp4'],
      outputPath: 'merged.mp4',
    };
    await expect(tool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('video_merge failed'),
      retryable: false,
    });
  });

  it('throws non-retryable ToolError when runner is null', async () => {
    const nullTool = createVideoMergeTool(null);
    const input: VideoMergeInput = {
      clips: ['a.mp4', 'b.mp4'],
      outputPath: 'merged.mp4',
    };
    await expect(nullTool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('ffmpeg is not available'),
      retryable: false,
    });
  });
});

describe('parseDurationSec', () => {
  it('parses a standard duration string', () => {
    const stderr = 'Duration: 00:00:10.50, start: 0.000000, bitrate: 1000 kb/s';
    expect(parseDurationSec(stderr)).toBe(10.5);
  });

  it('parses hours, minutes, and seconds', () => {
    const stderr = 'Duration: 01:30:45.25, start: 0.000000';
    expect(parseDurationSec(stderr)).toBe(1 * 3600 + 30 * 60 + 45.25);
  });

  it('returns 0 when Duration line is missing', () => {
    const stderr = 'some random ffmpeg output';
    expect(parseDurationSec(stderr)).toBe(0);
  });

  it('returns 0 for malformed duration', () => {
    const stderr = 'Duration: not-a-time';
    expect(parseDurationSec(stderr)).toBe(0);
  });
});
