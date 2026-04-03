import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from './tool';
import { createVideoAddAudioTool, type VideoAddAudioInput } from './video-add-audio';
import { FfmpegRunner, FfmpegError } from '../ffmpeg/ffmpeg-runner';

describe('videoAddAudioTool', () => {
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
  let tool: ReturnType<typeof createVideoAddAudioTool>;
  let ctx: ToolContext;

  const successResult = {
    outputPath: '/workspace/output.mp4',
    durationMs: 300,
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

    tool = createVideoAddAudioTool(mockRunner as unknown as FfmpegRunner);

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

  it('has the name "video_add_audio"', () => {
    expect(tool.name).toBe('video_add_audio');
  });

  it('has inputSchema with required videoPath, audioPath, and outputPath fields', () => {
    expect(tool.inputSchema.required).toContain('videoPath');
    expect(tool.inputSchema.required).toContain('audioPath');
    expect(tool.inputSchema.required).toContain('outputPath');
  });

  it('validates all paths are within workspace', async () => {
    const input: VideoAddAudioInput = {
      videoPath: 'video.mp4',
      audioPath: 'audio.mp3',
      outputPath: 'output.mp4',
    };
    await tool.execute(input, ctx);

    expect(mockRunner.assertWithinWorkspace).toHaveBeenCalledWith('video.mp4');
    expect(mockRunner.assertWithinWorkspace).toHaveBeenCalledWith('audio.mp3');
    expect(mockRunner.assertWithinWorkspace).toHaveBeenCalledWith('output.mp4');
  });

  it('uses replace mode by default', async () => {
    const input: VideoAddAudioInput = {
      videoPath: 'video.mp4',
      audioPath: 'audio.mp3',
      outputPath: 'output.mp4',
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0];
    // Replace mode uses -map 0:v:0 -map 1:a:0
    expect(callArgs).toContain('-map');
    expect(callArgs).toContain('0:v:0');
    expect(callArgs).toContain('1:a:0');
  });

  it('uses mix mode with amix filter when mode is "mix"', async () => {
    const input: VideoAddAudioInput = {
      videoPath: 'video.mp4',
      audioPath: 'audio.mp3',
      outputPath: 'output.mp4',
      mode: 'mix',
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0] as string[];
    const filterArg = callArgs.find((a: string) => a.includes('amix'));
    expect(filterArg).toBeDefined();
    expect(filterArg).toContain('amix=inputs=2');
  });

  it('respects audioVolume and originalVolume in mix mode', async () => {
    const input: VideoAddAudioInput = {
      videoPath: 'video.mp4',
      audioPath: 'audio.mp3',
      outputPath: 'output.mp4',
      mode: 'mix',
      audioVolume: 0.5,
      originalVolume: 0.8,
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0] as string[];
    const filterArg = callArgs.find((a: string) => a.includes('amix'));
    expect(filterArg).toContain('volume=0.8');
    expect(filterArg).toContain('volume=0.5');
  });

  it('throws ToolError when audioVolume is out of range', async () => {
    const input: VideoAddAudioInput = {
      videoPath: 'video.mp4',
      audioPath: 'audio.mp3',
      outputPath: 'output.mp4',
      audioVolume: 3.0,
    };
    await expect(tool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('audioVolume must be between 0.0 and 2.0'),
      retryable: false,
    });
  });

  it('throws ToolError when originalVolume is out of range', async () => {
    const input: VideoAddAudioInput = {
      videoPath: 'video.mp4',
      audioPath: 'audio.mp3',
      outputPath: 'output.mp4',
      mode: 'mix',
      originalVolume: -0.5,
    };
    await expect(tool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('originalVolume must be between 0.0 and 2.0'),
      retryable: false,
    });
  });

  it('throws non-retryable ToolError when runner is null', async () => {
    const nullTool = createVideoAddAudioTool(null);
    const input: VideoAddAudioInput = {
      videoPath: 'video.mp4',
      audioPath: 'audio.mp3',
      outputPath: 'output.mp4',
    };
    await expect(nullTool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('ffmpeg is not available'),
      retryable: false,
    });
  });

  it('throws ToolError when ffmpeg run fails', async () => {
    mockRunner.run.mockRejectedValue(new FfmpegError('invalid audio codec', 'error details', 1));

    const input: VideoAddAudioInput = {
      videoPath: 'video.mp4',
      audioPath: 'audio.mp3',
      outputPath: 'output.mp4',
    };
    await expect(tool.execute(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('video_add_audio failed'),
      retryable: false,
    });
  });

  it('uses fitToVideo with stream_loop in mix mode by default', async () => {
    const input: VideoAddAudioInput = {
      videoPath: 'video.mp4',
      audioPath: 'audio.mp3',
      outputPath: 'output.mp4',
      mode: 'mix',
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0] as string[];
    expect(callArgs).toContain('-stream_loop');
    expect(callArgs).toContain('-1');
  });

  it('omits stream_loop when fitToVideo is false', async () => {
    const input: VideoAddAudioInput = {
      videoPath: 'video.mp4',
      audioPath: 'audio.mp3',
      outputPath: 'output.mp4',
      mode: 'mix',
      fitToVideo: false,
    };
    await tool.execute(input, ctx);

    const callArgs = mockRunner.run.mock.calls[0]![0] as string[];
    expect(callArgs).not.toContain('-stream_loop');
  });
});
