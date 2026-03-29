import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import {
  ComfyUIPool,
  patchWorkflow,
  type ComfyUINode,
  type WorkflowPatchmap,
} from './comfyui-pool';
import type { Config } from '../config/config';

// --- Mocks ---

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('../assets', () => ({
  BUILTIN_AGENT_MD: '/builtin/AGENT.md',
  BUILTIN_SKILLS_DIR: '/builtin/skills',
  BUILTIN_WORKFLOWS_DIR: '/builtin/workflows',
}));

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

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

const BASE_CONFIG: Config['comfyui'] = {
  servers: [
    { url: 'http://gpu1:8188', weight: 2 },
    { url: 'http://gpu2:8188', weight: 1 },
  ],
  workflows: { text2img: 'image_z_image_turbo', img2video: 'video_ltx2_3_i2v' },
  pollIntervalMs: 10,
  timeoutMs: 1000,
  maxConcurrentPerServer: 2,
};

const CWD = '/workspace';
const USER_WORKFLOWS_DIR = '/workspace/.bolt/workflows';

function makePool(config: Config['comfyui'] = BASE_CONFIG): ComfyUIPool {
  return new ComfyUIPool(config, USER_WORKFLOWS_DIR, CWD, mockLogger, mockProgress);
}

// Helper to build a mock fetch response
function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  } as unknown as Response;
}

// --- Tests ---

describe('patchWorkflow', () => {
  const workflow: Record<string, ComfyUINode> = {
    '1': { inputs: { text: 'hello', steps: 8 }, class_type: 'CLIPTextEncode' },
    '2': { inputs: { width: 1024, height: 1024 }, class_type: 'EmptyLatent' },
  };

  it('patches specified node fields without touching other nodes', () => {
    const result = patchWorkflow(workflow, { '1': { text: 'new prompt' } });
    expect(result['1']!.inputs['text']).toBe('new prompt');
    expect(result['1']!.inputs['steps']).toBe(8);
    expect(result['2']).toEqual(workflow['2']);
  });

  it('patches multiple nodes at once', () => {
    const result = patchWorkflow(workflow, {
      '1': { steps: 20 },
      '2': { width: 512, height: 512 },
    });
    expect(result['1']!.inputs['steps']).toBe(20);
    expect(result['2']!.inputs['width']).toBe(512);
    expect(result['2']!.inputs['height']).toBe(512);
  });

  it('does not mutate the original workflow', () => {
    patchWorkflow(workflow, { '1': { text: 'mutated' } });
    expect(workflow['1']!.inputs['text']).toBe('hello');
  });

  it('ignores patch entries for node IDs not in the workflow', () => {
    const result = patchWorkflow(workflow, { nonexistent: { foo: 'bar' } });
    expect(Object.keys(result)).toEqual(['1', '2']);
  });
});

describe('ComfyUIPool.init()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes servers that respond successfully to /system_stats', async () => {
    fetchMock.mockResolvedValue(mockResponse({ status: 'ok' }));
    const pool = makePool();
    await pool.init();

    // selectServer should work (pool is non-empty)
    fetchMock.mockResolvedValue(mockResponse({ queue_running: 0, queue_pending: 0 }));
    await expect(pool.selectServer()).resolves.toBeDefined();
  });

  it('excludes unreachable servers and logs a warning', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNREFUSED')) // gpu1 fails
      .mockResolvedValueOnce(mockResponse({ status: 'ok' })); // gpu2 succeeds
    const pool = makePool();
    await pool.init();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'ComfyUI server unreachable, excluding from pool',
      expect.objectContaining({ url: 'http://gpu1:8188' }),
    );

    // Only gpu2 remains — selectServer should return it
    fetchMock.mockResolvedValue(mockResponse({ queue_running: 0, queue_pending: 0 }));
    const server = await pool.selectServer();
    expect(server.url).toBe('http://gpu2:8188');
  });

  it('logs a warning when all servers are unreachable (pool is empty)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const pool = makePool();
    await pool.init();

    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('pool is empty'));
  });
});

describe('ComfyUIPool.selectServer()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
    // init: both servers reachable
    fetchMock.mockResolvedValue(mockResponse({ status: 'ok' }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('selects the server with the lowest queue_remaining / weight score', async () => {
    const pool = makePool();
    await pool.init();

    // gpu1 (weight 2): 4 pending → score 4/2 = 2
    // gpu2 (weight 1): 1 pending → score 1/1 = 1  → gpu2 should win
    fetchMock
      .mockResolvedValueOnce(mockResponse({ queue_running: 0, queue_pending: 4 }))
      .mockResolvedValueOnce(mockResponse({ queue_running: 0, queue_pending: 1 }));

    const server = await pool.selectServer();
    expect(server.url).toBe('http://gpu2:8188');
  });

  it('selects the server with the lowest score when the heavier server has fewer jobs', async () => {
    const pool = makePool();
    await pool.init();

    // gpu1 (weight 2): 0 pending → score 0/2 = 0  → gpu1 should win
    // gpu2 (weight 1): 3 pending → score 3/1 = 3
    fetchMock
      .mockResolvedValueOnce(mockResponse({ queue_running: 0, queue_pending: 0 }))
      .mockResolvedValueOnce(mockResponse({ queue_running: 0, queue_pending: 3 }));

    const server = await pool.selectServer();
    expect(server.url).toBe('http://gpu1:8188');
  });

  it('falls back to round-robin when all queue queries fail', async () => {
    const pool = makePool();
    await pool.init();

    fetchMock.mockRejectedValue(new Error('timeout'));

    const server = await pool.selectServer();
    expect(server.url).toBeDefined();
  });

  it('throws retryable error when all servers at capacity', async () => {
    const pool = makePool();
    await pool.init();

    // Manually set both servers at capacity
    (
      pool as unknown as {
        activeServers: Array<{ url: string; weight: number; activeJobs: number }>;
      }
    ).activeServers = [
      { url: 'http://gpu1:8188', weight: 1, activeJobs: 10 },
      { url: 'http://gpu2:8188', weight: 1, activeJobs: 10 },
    ];

    fetchMock.mockResolvedValue(mockResponse({ queue_running: 0, queue_pending: 0 }));

    await expect(pool.selectServer()).rejects.toMatchObject({
      message: expect.stringContaining('at capacity'),
      retryable: true,
    });
  });

  it('throws a retryable ToolError when the pool is empty', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const pool = makePool();
    await pool.init(); // all fail → empty pool

    await expect(pool.selectServer()).rejects.toMatchObject({
      message: expect.stringContaining('No ComfyUI servers available'),
      retryable: true,
    });
  });
});

describe('ComfyUIPool.resolveWorkflow()', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the user override path when it exists', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes(USER_WORKFLOWS_DIR));

    const pool = makePool();
    const path = pool.resolveWorkflow('my_workflow');
    expect(path).toBe(join(USER_WORKFLOWS_DIR, 'my_workflow.json'));
  });

  it('falls back to the built-in path when user override does not exist', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('/builtin/workflows'));

    const pool = makePool();
    const path = pool.resolveWorkflow('image_z_image_turbo');
    expect(path).toBe('/builtin/workflows/image_z_image_turbo.json');
  });

  it('throws a non-retryable ToolError when neither path exists', async () => {
    const { existsSync } = await import('node:fs');
    vi.mocked(existsSync).mockReturnValue(false);

    const pool = makePool();
    expect(() => pool.resolveWorkflow('unknown')).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('"unknown" not found'),
        retryable: false,
      }),
    );
  });
});

describe('ComfyUIPool.loadWorkflow()', () => {
  const sampleWorkflow: Record<string, ComfyUINode> = {
    '1': { inputs: { text: '' }, class_type: 'CLIPTextEncode' },
  };
  const samplePatchmap: WorkflowPatchmap = {
    outputNode: '9',
    params: { prompt: [{ nodeId: '1', field: 'text' }] },
  };

  beforeEach(() => vi.clearAllMocks());

  it('loads workflow and patchmap from disk', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync)
      .mockReturnValueOnce(JSON.stringify(sampleWorkflow))
      .mockReturnValueOnce(JSON.stringify(samplePatchmap));

    const pool = makePool();
    const { workflow, patchmap } = pool.loadWorkflow('test');
    expect(workflow['1']!.class_type).toBe('CLIPTextEncode');
    expect(patchmap.outputNode).toBe('9');
  });

  it('throws a non-retryable ToolError when patchmap is missing', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync)
      .mockReturnValueOnce(JSON.stringify(sampleWorkflow))
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

    const pool = makePool();
    expect(() => pool.loadWorkflow('test')).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('Patchmap file missing'),
        retryable: false,
      }),
    );
  });
});

describe('ComfyUIPool.uploadImage()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(Buffer.from('img data'));
  });

  afterEach(() => vi.unstubAllGlobals());

  const server = { url: 'http://gpu1:8188', weight: 1 };

  it('uploads the file and returns the server-assigned filename', async () => {
    fetchMock.mockResolvedValue(mockResponse({ name: 'upload_abc.png' }));

    const pool = makePool();
    const name = await pool.uploadImage('projects/scene-01/image.png', server);
    expect(name).toBe('upload_abc.png');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://gpu1:8188/upload/image',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws a non-retryable ToolError when path is outside workspace', async () => {
    const pool = makePool();
    await expect(pool.uploadImage('/etc/passwd', server)).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining('outside the workspace'),
    });
  });

  it('throws a non-retryable ToolError when the file does not exist', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
    );
    const pool = makePool();
    await expect(pool.uploadImage('projects/image.png', server)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('throws a retryable ToolError on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const pool = makePool();
    await expect(pool.uploadImage('projects/image.png', server)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('throws a retryable ToolError on 5xx response', async () => {
    fetchMock.mockResolvedValue(mockResponse('Internal Server Error', 500));
    const pool = makePool();
    await expect(pool.uploadImage('projects/image.png', server)).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe('ComfyUIPool.queueWorkflow()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  const server = { url: 'http://gpu1:8188', weight: 1 };
  const workflow = { '1': { inputs: { text: 'test' }, class_type: 'Test' } };

  it('POSTs the workflow and returns the prompt_id', async () => {
    fetchMock.mockResolvedValue(mockResponse({ prompt_id: 'abc-123' }));
    const pool = makePool();
    const id = await pool.queueWorkflow(workflow, server);
    expect(id).toBe('abc-123');

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('http://gpu1:8188/prompt');
    expect(call[1].method).toBe('POST');
    const body = JSON.parse(call[1].body as string) as { prompt: unknown };
    expect(body.prompt).toEqual(workflow);
  });

  it('throws a non-retryable ToolError on 4xx', async () => {
    fetchMock.mockResolvedValue(mockResponse('Bad Request', 400));
    const pool = makePool();
    await expect(pool.queueWorkflow(workflow, server)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('throws a retryable ToolError on 5xx', async () => {
    fetchMock.mockResolvedValue(mockResponse('Server Error', 500));
    const pool = makePool();
    await expect(pool.queueWorkflow(workflow, server)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('throws a retryable ToolError on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const pool = makePool();
    await expect(pool.queueWorkflow(workflow, server)).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe('ComfyUIPool.pollResult()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  const server = { url: 'http://gpu1:8188', weight: 1 };
  const promptId = 'prompt-xyz';

  it('polls until complete and returns output files', async () => {
    // First poll: not done yet (empty object)
    fetchMock.mockResolvedValueOnce(mockResponse({})).mockResolvedValueOnce(
      mockResponse({
        [promptId]: {
          status: { completed: true },
          outputs: {
            '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] },
          },
        },
      }),
    );

    const pool = makePool();
    const result = await pool.pollResult(promptId, server, 5000);
    expect(result.files).toEqual([{ filename: 'out.png', subfolder: '', type: 'output' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockProgress.onRetry).toHaveBeenCalledTimes(2);
  });

  it('collects files from multiple output nodes', async () => {
    fetchMock.mockResolvedValue(
      mockResponse({
        [promptId]: {
          status: { completed: true },
          outputs: {
            '9': { images: [{ filename: 'img.png', subfolder: '', type: 'output' }] },
            '10': { images: [{ filename: 'preview.png', subfolder: 'temp', type: 'temp' }] },
          },
        },
      }),
    );

    const pool = makePool();
    const result = await pool.pollResult(promptId, server, 5000);
    expect(result.files).toHaveLength(2);
  });

  it('throws a retryable ToolError when timeout is exceeded', async () => {
    fetchMock.mockResolvedValue(mockResponse({})); // never completes

    const pool = makePool(BASE_CONFIG);
    await expect(pool.pollResult(promptId, server, 50)).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining('timed out'),
    });
  });

  it('throws a retryable ToolError on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const pool = makePool();
    await expect(pool.pollResult(promptId, server, 5000)).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe('ComfyUIPool.downloadOutput()', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
    const { mkdir, writeFile } = await import('node:fs/promises');
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllGlobals());

  const server = { url: 'http://gpu1:8188', weight: 1 };
  const file = { filename: 'out.png', subfolder: '', type: 'output' as const };

  it('downloads the file and writes it to the local path', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as Response);

    const pool = makePool();
    await pool.downloadOutput(file, server, 'projects/scene-01/image.png');

    const { writeFile } = await import('node:fs/promises');
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      expect.stringContaining('projects/scene-01/image.png'),
      expect.any(Buffer),
    );

    const urlArg = (fetchMock.mock.calls[0] as [string])[0];
    expect(urlArg).toContain('filename=out.png');
    expect(urlArg).toContain('type=output');
  });

  it('throws a non-retryable ToolError when path is outside workspace', async () => {
    const pool = makePool();
    await expect(pool.downloadOutput(file, server, '/tmp/out.png')).rejects.toMatchObject({
      retryable: false,
      message: expect.stringContaining('outside the workspace'),
    });
  });

  it('throws a retryable ToolError on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const pool = makePool();
    await expect(pool.downloadOutput(file, server, 'projects/image.png')).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('throws a retryable ToolError on non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    const pool = makePool();
    await expect(pool.downloadOutput(file, server, 'projects/image.png')).rejects.toMatchObject({
      retryable: true,
    });
  });
});
