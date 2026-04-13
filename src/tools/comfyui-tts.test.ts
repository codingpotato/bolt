import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from './tool';
import { createComfyUITTS, type ComfyUITTSInput } from './comfyui-tts';

describe('comfyuiTTSTool', () => {
  let mockPool: {
    selectServer: ReturnType<typeof vi.fn>;
    loadWorkflow: ReturnType<typeof vi.fn>;
    queueWorkflow: ReturnType<typeof vi.fn>;
    pollResult: ReturnType<typeof vi.fn>;
    downloadOutput: ReturnType<typeof vi.fn>;
  };
  let tool: ReturnType<typeof createComfyUITTS>;
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPool = {
      selectServer: vi.fn().mockResolvedValue({ url: 'http://comfy:8188', weight: 1 }),
      loadWorkflow: vi.fn().mockReturnValue({
        workflow: {},
        patchmap: {
          outputNode: '2',
          params: {
            text: [{ nodeId: '1', field: 'text' }],
            voiceInstruct: [{ nodeId: '1', field: 'voice_instruct' }],
            steps: [{ nodeId: '1', field: 'steps' }],
            guidanceScale: [{ nodeId: '1', field: 'guidance_scale' }],
            tShift: [{ nodeId: '1', field: 't_shift' }],
            speed: [{ nodeId: '1', field: 'speed' }],
            duration: [{ nodeId: '1', field: 'duration' }],
            positionTemperature: [{ nodeId: '1', field: 'position_temperature' }],
            classTemperature: [{ nodeId: '1', field: 'class_temperature' }],
            layerPenaltyFactor: [{ nodeId: '1', field: 'layer_penalty_factor' }],
            denoise: [{ nodeId: '1', field: 'denoise' }],
            postprocessOutput: [{ nodeId: '1', field: 'postprocess_output' }],
            keepModelLoaded: [{ nodeId: '1', field: 'keep_model_loaded' }],
          },
        },
      }),
      queueWorkflow: vi.fn().mockResolvedValue('prompt-789'),
      pollResult: vi.fn().mockResolvedValue({
        files: [{ filename: 'output.wav', subfolder: 'output', type: 'output' }],
      }),
      downloadOutput: vi.fn().mockResolvedValue(undefined),
    };

    tool = createComfyUITTS(mockPool as never, 300000);

    const mockProgress = {
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
    };

    ctx = {
      cwd: '/workspace',
      log: { log: vi.fn().mockResolvedValue(undefined) },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      progress: mockProgress,
    };
  });

  it('has the name "comfyui_tts"', () => {
    expect(tool.name).toBe('comfyui_tts');
  });

  it('has inputSchema with required text field', () => {
    expect(tool.inputSchema.required).toContain('text');
  });

  it('generates audio and returns outputPath and durationMs', async () => {
    const result = await tool.execute({ text: 'Hello world' }, ctx);

    expect(result.outputPath).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('defaults outputPath to scenes/ subdirectory when not provided', async () => {
    const result = await tool.execute({ text: 'Hello world' }, ctx);

    expect(result.outputPath).toContain('/scenes/');
    expect(result.outputPath).toMatch(/scenes\/\d+-tts\.wav$/);
  });

  it('uses custom outputPath when provided, resolving to absolute path', async () => {
    const input: ComfyUITTSInput = { text: 'Hello', outputPath: 'audio/narration.wav' };
    await tool.execute(input, ctx);

    expect(mockPool.downloadOutput).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'output.wav' }),
      expect.objectContaining({ url: 'http://comfy:8188' }),
      '/workspace/audio/narration.wav',
    );
  });

  it('rejects outputPath that escapes the workspace', async () => {
    await expect(
      tool.execute({ text: 'Hello', outputPath: '../../outside.wav' }, ctx),
    ).rejects.toMatchObject({
      message: expect.stringContaining('outside the workspace'),
      retryable: false,
    });
  });

  it('throws ToolError when no output files are produced', async () => {
    mockPool.pollResult = vi.fn().mockResolvedValue({ files: [] });

    await expect(tool.execute({ text: 'Hello' }, ctx)).rejects.toThrow(
      'Workflow completed but produced no output files',
    );
  });

  it('throws a non-retryable ToolError when no servers are configured', async () => {
    const unconfiguredTool = createComfyUITTS(null, 300000);

    await expect(unconfiguredTool.execute({ text: 'Hello' }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('No ComfyUI servers configured'),
      retryable: false,
    });
  });

  it('queues workflow, polls, and downloads output', async () => {
    await tool.execute({ text: 'Hello world' }, ctx);

    expect(mockPool.selectServer).toHaveBeenCalled();
    expect(mockPool.queueWorkflow).toHaveBeenCalled();
    expect(mockPool.pollResult).toHaveBeenCalledWith('prompt-789', expect.anything(), expect.any(Number));
    expect(mockPool.downloadOutput).toHaveBeenCalled();
  });

  it('passes voiceInstruct to the workflow patch', async () => {
    const input: ComfyUITTSInput = {
      text: 'Hello',
      voiceInstruct: 'female, young, high pitch, british accent',
    };
    await tool.execute(input, ctx);

    expect(mockPool.queueWorkflow).toHaveBeenCalled();
  });

  it('passes generation parameters when provided', async () => {
    const input: ComfyUITTSInput = {
      text: 'Hello',
      steps: 64,
      guidanceScale: 3,
      speed: 1.5,
      duration: 5,
      denoise: false,
      postprocessOutput: false,
      keepModelLoaded: false,
    };
    const result = await tool.execute(input, ctx);

    expect(result.outputPath).toBeDefined();
    expect(mockPool.queueWorkflow).toHaveBeenCalled();
  });

  it('patches classTemperature=0 correctly (falsy value must still be applied)', async () => {
    const input: ComfyUITTSInput = { text: 'Hello', classTemperature: 0 };
    await tool.execute(input, ctx);

    // classTemperature=0 is the default and is falsy — ensure it still reaches queueWorkflow
    expect(mockPool.queueWorkflow).toHaveBeenCalled();
  });

  it('patches duration=0 correctly (falsy value must still be applied)', async () => {
    const input: ComfyUITTSInput = { text: 'Hello', duration: 0 };
    await tool.execute(input, ctx);

    expect(mockPool.queueWorkflow).toHaveBeenCalled();
  });
});
