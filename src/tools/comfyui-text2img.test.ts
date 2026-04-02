import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from './tool';
import { createComfyUIText2ImgTool, type ComfyUIText2ImgInput } from './comfyui-text2img';

describe('comfyuiText2ImgTool', () => {
  let mockPool: {
    selectServer: ReturnType<typeof vi.fn>;
    loadWorkflow: ReturnType<typeof vi.fn>;
    queueWorkflow: ReturnType<typeof vi.fn>;
    pollResult: ReturnType<typeof vi.fn>;
    downloadOutput: ReturnType<typeof vi.fn>;
  };
  let tool: ReturnType<typeof createComfyUIText2ImgTool>;
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool = {
      selectServer: vi.fn().mockResolvedValue({ url: 'http://comfy:8188', weight: 1 }),
      loadWorkflow: vi.fn().mockReturnValue({
        workflow: {},
        patchmap: {
          outputNode: '9',
          params: {
            prompt: [{ nodeId: '57:27', field: 'text' }],
            width: [{ nodeId: '57:13', field: 'width' }],
            height: [{ nodeId: '57:13', field: 'height' }],
            steps: [{ nodeId: '57:3', field: 'steps' }],
            seed: [{ nodeId: '57:3', field: 'seed' }],
          },
        },
      }),
      queueWorkflow: vi.fn().mockResolvedValue('prompt-123'),
      pollResult: vi.fn().mockResolvedValue({
        files: [{ filename: 'output.png', subfolder: 'output', type: 'output' }],
      }),
      downloadOutput: vi.fn().mockResolvedValue(undefined),
    };

    tool = createComfyUIText2ImgTool(mockPool as never, 300000);

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

  it('has the name "comfyui_text2img"', () => {
    expect(tool.name).toBe('comfyui_text2img');
  });

  it('has inputSchema with required prompt field', () => {
    expect(tool.inputSchema.required).toContain('prompt');
  });

  it('generates an image and returns outputPath, seed, and durationMs', async () => {
    const input: ComfyUIText2ImgInput = { prompt: 'a sunset over mountains' };
    const result = await tool.execute(input, ctx);

    expect(result.outputPath).toBeDefined();
    expect(result.seed).toBeDefined();
    expect(typeof result.seed).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('uses custom outputPath when provided', async () => {
    const input: ComfyUIText2ImgInput = { prompt: 'test', outputPath: 'custom-output.png' };
    await tool.execute(input, ctx);

    expect(mockPool.downloadOutput).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'output.png' }),
      expect.objectContaining({ url: 'http://comfy:8188' }),
      'custom-output.png',
    );
  });

  it('selects a server, queues workflow, polls, and downloads', async () => {
    await tool.execute({ prompt: 'test image' }, ctx);

    expect(mockPool.selectServer).toHaveBeenCalled();
    expect(mockPool.queueWorkflow).toHaveBeenCalled();
    expect(mockPool.pollResult).toHaveBeenCalledWith(
      'prompt-123',
      expect.anything(),
      expect.any(Number),
    );
    expect(mockPool.downloadOutput).toHaveBeenCalled();
  });

  it('throws ToolError when no output files are produced', async () => {
    mockPool.pollResult = vi.fn().mockResolvedValue({ files: [] });

    await expect(tool.execute({ prompt: 'test' }, ctx)).rejects.toThrow(
      'Workflow completed but produced no output files',
    );
  });

  it('throws a non-retryable ToolError when no servers are configured', async () => {
    const unconfiguredTool = createComfyUIText2ImgTool(null, 300000);

    await expect(unconfiguredTool.execute({ prompt: 'test' }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('No ComfyUI servers configured'),
      retryable: false,
    });
  });

  it('executes successfully with width parameter', async () => {
    const input: ComfyUIText2ImgInput = { prompt: 'test', width: 512 };
    const result = await tool.execute(input, ctx);

    expect(result.outputPath).toBeDefined();
    expect(mockPool.queueWorkflow).toHaveBeenCalled();
  });

  it('executes successfully with height parameter', async () => {
    const input: ComfyUIText2ImgInput = { prompt: 'test', height: 768 };
    const result = await tool.execute(input, ctx);

    expect(result.outputPath).toBeDefined();
    expect(mockPool.queueWorkflow).toHaveBeenCalled();
  });

  it('executes successfully with steps parameter', async () => {
    const input: ComfyUIText2ImgInput = { prompt: 'test', steps: 20 };
    const result = await tool.execute(input, ctx);

    expect(result.outputPath).toBeDefined();
    expect(mockPool.queueWorkflow).toHaveBeenCalled();
  });

  it('executes successfully with all optional parameters', async () => {
    const input: ComfyUIText2ImgInput = {
      prompt: 'test',
      width: 512,
      height: 768,
      steps: 15,
    };
    const result = await tool.execute(input, ctx);

    expect(result.outputPath).toBeDefined();
    expect(mockPool.queueWorkflow).toHaveBeenCalled();
  });
});
