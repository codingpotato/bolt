import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from './tool';
import { webFetchTool, MAX_BODY_CHARS } from './web-fetch';

// Mock the global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

describe('webFetchTool', () => {
  let mockLogger: { log: (tool: string, input: unknown, result: unknown) => Promise<void> };
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = { log: vi.fn().mockResolvedValue(undefined) };
    ctx = {
      cwd: '/workspace',
      log: mockLogger,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as import('../logger').Logger,
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

  it('has the name "web_fetch"', () => {
    expect(webFetchTool.name).toBe('web_fetch');
  });

  it('has inputSchema with required url field', () => {
    expect(webFetchTool.inputSchema.required).toContain('url');
  });

  it('returns body, statusCode, and contentType on a 200 response', async () => {
    fetchMock.mockResolvedValue(makeMockResponse(200, 'text/html', '<html>hello</html>'));

    const result = await webFetchTool.execute({ url: 'https://example.com' }, ctx);
    expect(result.body).toBe('<html>hello</html>');
    expect(result.statusCode).toBe(200);
    expect(result.contentType).toBe('text/html');
  });

  it('throws ToolError on HTTP 4xx responses', async () => {
    fetchMock.mockResolvedValue(makeMockResponse(404, 'text/plain', 'Not Found'));

    const { ToolError } = await import('./tool');
    await expect(
      webFetchTool.execute({ url: 'https://example.com/missing' }, ctx),
    ).rejects.toBeInstanceOf(ToolError);
  });

  it('throws ToolError on HTTP 5xx responses', async () => {
    fetchMock.mockResolvedValue(makeMockResponse(500, 'text/plain', 'Server Error'));

    const { ToolError } = await import('./tool');
    await expect(webFetchTool.execute({ url: 'https://example.com' }, ctx)).rejects.toBeInstanceOf(
      ToolError,
    );
  });

  it('includes the status code in the 4xx ToolError message', async () => {
    fetchMock.mockResolvedValue(makeMockResponse(403, 'text/plain', 'Forbidden'));

    const { ToolError } = await import('./tool');
    await expect(webFetchTool.execute({ url: 'https://example.com' }, ctx)).rejects.toSatisfy(
      (err) => err instanceof ToolError && err.message.includes('403'),
    );
  });

  it('throws a retryable ToolError on network errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const { ToolError } = await import('./tool');
    await expect(webFetchTool.execute({ url: 'https://example.com' }, ctx)).rejects.toSatisfy(
      (err) => err instanceof ToolError && err.retryable === true,
    );
  });

  it('throws a retryable ToolError when response.text() fails', async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => 'text/html' },
      text: () => Promise.reject(new Error('connection reset')),
    });

    const { ToolError } = await import('./tool');
    await expect(webFetchTool.execute({ url: 'https://example.com' }, ctx)).rejects.toSatisfy(
      (err) => err instanceof ToolError && err.retryable === true,
    );
  });

  it('5xx ToolError is not retryable', async () => {
    fetchMock.mockResolvedValue(makeMockResponse(503, 'text/plain', 'Service Unavailable'));

    const { ToolError } = await import('./tool');
    await expect(webFetchTool.execute({ url: 'https://example.com' }, ctx)).rejects.toSatisfy(
      (err) => err instanceof ToolError && err.retryable === false,
    );
  });

  it('throws a ToolError when response is not ok and error body read fails', async () => {
    fetchMock.mockResolvedValue({
      status: 500,
      ok: false,
      headers: { get: () => 'text/plain' },
      text: () => Promise.reject(new Error('body read failed')),
    });

    const { ToolError } = await import('./tool');
    await expect(webFetchTool.execute({ url: 'https://example.com' }, ctx)).rejects.toSatisfy(
      (err) => err instanceof ToolError && err.message.includes('500'),
    );
  });

  it('includes the response body in the HTTP error message', async () => {
    fetchMock.mockResolvedValue(makeMockResponse(422, 'application/json', '{"error":"invalid"}'));

    const { ToolError } = await import('./tool');
    await expect(webFetchTool.execute({ url: 'https://example.com' }, ctx)).rejects.toSatisfy(
      (err) => err instanceof ToolError && err.message.includes('{"error":"invalid"}'),
    );
  });

  it('truncates body exceeding MAX_BODY_CHARS and appends a notice', async () => {
    const longBody = 'x'.repeat(MAX_BODY_CHARS + 100);
    fetchMock.mockResolvedValue(makeMockResponse(200, 'text/html', longBody));

    const result = await webFetchTool.execute({ url: 'https://example.com' }, ctx);
    expect(result.body.length).toBeGreaterThan(MAX_BODY_CHARS);
    expect(result.body.length).toBeLessThan(MAX_BODY_CHARS + 100);
    expect(result.body.startsWith('x'.repeat(MAX_BODY_CHARS))).toBe(true);
    expect(result.body).toContain('[truncated');
  });

  it('does not truncate body within MAX_BODY_CHARS', async () => {
    const shortBody = 'hello world';
    fetchMock.mockResolvedValue(makeMockResponse(200, 'text/html', shortBody));

    const result = await webFetchTool.execute({ url: 'https://example.com' }, ctx);
    expect(result.body).toBe(shortBody);
  });

  it('handles missing content-type header gracefully', async () => {
    fetchMock.mockResolvedValue(makeMockResponse(200, null, 'raw body'));

    const result = await webFetchTool.execute({ url: 'https://example.com' }, ctx);
    expect(result.contentType).toBe('');
  });

  it('calls fetch with the provided URL', async () => {
    fetchMock.mockResolvedValue(makeMockResponse(200, 'application/json', '{}'));

    await webFetchTool.execute({ url: 'https://api.example.com/data' }, ctx);
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/data');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockResponse(status: number, contentType: string | null, body: string) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name: string): string | null {
        if (name === 'content-type') return contentType;
        return null;
      },
    },
    text: () => Promise.resolve(body),
  };
}
