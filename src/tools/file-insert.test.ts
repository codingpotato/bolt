import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { ToolContext } from './tool';
import { fileInsertTool } from './file-insert';

vi.mock('node:fs/promises');

describe('file_insert tool', () => {
  let mockLogger: { log: ReturnType<typeof vi.fn> };
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = { log: vi.fn().mockResolvedValue(undefined) };
    ctx = {
      cwd: '/workspace',
      log: mockLogger,
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
      },
    };
  });

  describe('fileInsertTool', () => {
    it('has the name "file_insert"', () => {
      expect(fileInsertTool.name).toBe('file_insert');
    });

    it('has inputSchema with required path and content fields', () => {
      expect(fileInsertTool.inputSchema.required).toContain('path');
      expect(fileInsertTool.inputSchema.required).toContain('content');
    });

    it('inserts at top of file when line: 1', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('line1\nline2\n' as never);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      const result = await fileInsertTool.execute(
        { path: 'file.txt', content: 'new top', line: 1 },
        ctx,
      );

      expect(result.path).toBe(nodePath.join('/workspace', 'file.txt'));
      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
        expect.any(String),
        'new top\nline1\nline2\n',
        'utf-8',
      );
    });

    it('inserts in middle of file', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('line1\nline2\nline3' as never);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      await fileInsertTool.execute({ path: 'file.txt', content: 'inserted', line: 2 }, ctx);

      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
        expect.any(String),
        'line1\ninserted\nline2\nline3',
        'utf-8',
      );
    });

    it('appends when line is omitted', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('line1\nline2' as never);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      await fileInsertTool.execute({ path: 'file.txt', content: 'appended' }, ctx);

      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
        expect.any(String),
        'line1\nline2\nappended',
        'utf-8',
      );
    });

    it('appends when line: 0', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('line1\n' as never);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      await fileInsertTool.execute({ path: 'file.txt', content: 'appended', line: 0 }, ctx);

      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
        expect.any(String),
        'line1\n\nappended',
        'utf-8',
      );
    });

    it('appends when line beyond EOF length', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('line1\nline2' as never);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      await fileInsertTool.execute({ path: 'file.txt', content: 'beyond', line: 100 }, ctx);

      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
        expect.any(String),
        'line1\nline2\nbeyond',
        'utf-8',
      );
    });

    it('creates file if it does not exist', async () => {
      const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
      vi.mocked(fsPromises.readFile).mockRejectedValue(err);
      vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      const result = await fileInsertTool.execute({ path: 'new.txt', content: 'hello' }, ctx);

      expect(result.path).toBe(nodePath.join('/workspace', 'new.txt'));
      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
        expect.any(String),
        'hello',
        'utf-8',
      );
    });

    it('creates parent directories for new file', async () => {
      const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
      vi.mocked(fsPromises.readFile).mockRejectedValue(err);
      vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      await fileInsertTool.execute({ path: 'deep/nested/file.txt', content: 'x' }, ctx);

      expect(vi.mocked(fsPromises.mkdir)).toHaveBeenCalledWith(
        nodePath.dirname(nodePath.join('/workspace', 'deep/nested/file.txt')),
        { recursive: true },
      );
    });

    it('resolves path relative to cwd', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('existing' as never);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      await fileInsertTool.execute({ path: 'sub/file.txt', content: 'new', line: 1 }, ctx);

      expect(vi.mocked(fsPromises.readFile)).toHaveBeenCalledWith(
        nodePath.join('/workspace', 'sub/file.txt'),
        'utf-8',
      );
    });

    it('throws ToolError for path outside workspace', async () => {
      const { ToolError } = await import('./tool');
      await expect(
        fileInsertTool.execute({ path: '../../etc/passwd', content: 'evil' }, ctx),
      ).rejects.toBeInstanceOf(ToolError);
    });

    it('throws ToolError for non-ENOENT read errors', async () => {
      const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      vi.mocked(fsPromises.readFile).mockRejectedValue(err);

      const { ToolError } = await import('./tool');
      await expect(
        fileInsertTool.execute({ path: 'secret.txt', content: 'x' }, ctx),
      ).rejects.toBeInstanceOf(ToolError);
    });
  });
});
