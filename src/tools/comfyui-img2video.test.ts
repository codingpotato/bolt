import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from './tool';
import { createComfyUIImg2VideoTool, type ComfyUIImg2VideoInput } from './comfyui-img2video';

describe('comfyuiImg2VideoTool', () => {
  let mockPool: {
    selectServer: ReturnType<typeof vi.fn>;
    uploadImage: ReturnType<typeof vi.fn>;
    loadWorkflow: ReturnType<typeof vi.fn>;
    queueWorkflow: ReturnType<typeof vi.fn>;
    pollResult: ReturnType<typeof vi.fn>;
    downloadOutput: ReturnType<typeof vi.fn>;
  };
  let tool: ReturnType<typeof createComfyUIImg2VideoTool>;
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool = {
      selectServer: vi.fn().mockResolvedValue({ url: 'http://comfy:8188', weight: 1 }),
      uploadImage: vi.fn().mockResolvedValue('uploaded-image.png'),
      loadWorkflow: vi.fn().mockReturnValue({
        workflow: {},
        patchmap: {
          outputNode: '75',
          imageNode: '269',
          imageField: 'image',
          params: {
            prompt: [{ nodeId: '267:266', field: 'value' }],
            negativePrompt: [{ nodeId: '267:247', field: 'text' }],
            width: [{ nodeId: '267:257', field: 'value' }],
            height: [{ nodeId: '267:258', field: 'value' }],
            frames: [{ nodeId: '267:225', field: 'value' }],
            fps: [{ nodeId: '267:260', field: 'value' }],
            seed: [
              { nodeId: '267:216', field: 'noise_seed' },
              { nodeId: '267:237', field: 'noise_seed' },
            ],
          },
        },
      }),
      queueWorkflow: vi.fn().mockResolvedValue('prompt-456'),
      pollResult: vi.fn().mockResolvedValue({
        files: [{ filename: 'output.mp4', subfolder: 'output', type: 'output' }],
      }),
      downloadOutput: vi.fn().mockResolvedValue(undefined),
    };

    tool = createComfyUIImg2VideoTool(mockPool as never, 300000);

    const mockLogger = { log: vi.fn().mockResolvedValue(undefined) };
    const mockProgress = {
      onSessionStart: vi.fn(),
      onThinking: vi.fn(),
      onToolCall: vi.fn(),
      onToolResult: vi.fn(),
      onTaskStatusChange: vi.fn(),
      onContextInjection: vi.fn(),
      onMemoryCompaction: vi.fn(),
      onRetry: vi.fn(),
    };

    ctx = {
      cwd: '/workspace',
      log: mockLogger,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      progress: mockProgress,
    };
  });

  it('has the name "comfyui_img2video"', () => {
    expect(tool.name).toBe('comfyui_img2video');
  });

  it('has inputSchema with required imagePath and prompt fields', () => {
    expect(tool.inputSchema.required).toContain('imagePath');
    expect(tool.inputSchema.required).toContain('prompt');
  });

  it('uploads image, generates a video and returns outputPath and durationMs', async () => {
    const input: ComfyUIImg2VideoInput = { imagePath: 'input.png', prompt: 'camera pans left' };
    const result = await tool.execute(input, ctx);

    expect(mockPool.uploadImage).toHaveBeenCalledWith('input.png', expect.anything());
    expect(result.outputPath).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses custom outputPath when provided', async () => {
    const input: ComfyUIImg2VideoInput = {
      imagePath: 'test.png',
      prompt: 'motion',
      outputPath: 'custom-video.mp4',
    };
    await tool.execute(input, ctx);

    expect(mockPool.downloadOutput).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'output.mp4' }),
      expect.objectContaining({ url: 'http://comfy:8188' }),
      'custom-video.mp4',
    );
  });

  it('uploads image to server, queues workflow, polls, and downloads', async () => {
    await tool.execute({ imagePath: 'test.png', prompt: 'panning shot' }, ctx);

    expect(mockPool.uploadImage).toHaveBeenCalledWith('test.png', expect.anything());
    expect(mockPool.selectServer).toHaveBeenCalled();
    expect(mockPool.queueWorkflow).toHaveBeenCalled();
    expect(mockPool.pollResult).toHaveBeenCalledWith(
      'prompt-456',
      expect.anything(),
      expect.any(Number),
    );
    expect(mockPool.downloadOutput).toHaveBeenCalled();
  });

  it('throws ToolError when no output files are produced', async () => {
    mockPool.pollResult = vi.fn().mockResolvedValue({ files: [] });

    await expect(tool.execute({ imagePath: 'test.png', prompt: 'motion' }, ctx)).rejects.toThrow(
      'Workflow completed but produced no output files',
    );
  });
});
