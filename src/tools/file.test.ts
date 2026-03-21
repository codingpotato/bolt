import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { ToolContext } from './tool';
import { fileReadTool, fileWriteTool, fileEditTool } from './file';

vi.mock('node:fs/promises');

describe('file tools', () => {
  let mockLogger: { log: ReturnType<typeof vi.fn> };
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = { log: vi.fn().mockResolvedValue(undefined) };
    ctx = { cwd: '/workspace', log: mockLogger, logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
  });

  // ── file_read ──────────────────────────────────────────────────────────────

  describe('fileReadTool', () => {
    it('has the name "file_read"', () => {
      expect(fileReadTool.name).toBe('file_read');
    });

    it('has inputSchema with required path field', () => {
      expect(fileReadTool.inputSchema.required).toContain('path');
    });

    it('returns file content', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('hello world' as never);

      const result = await fileReadTool.execute({ path: 'file.txt' }, ctx);
      expect(result.content).toBe('hello world');
    });

    it('resolves path relative to cwd', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('' as never);

      await fileReadTool.execute({ path: 'subdir/file.txt' }, ctx);

      expect(vi.mocked(fsPromises.readFile)).toHaveBeenCalledWith(
        nodePath.join('/workspace', 'subdir/file.txt'),
        'utf-8',
      );
    });

    it('handles absolute paths unchanged', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('content' as never);

      await fileReadTool.execute({ path: '/absolute/path.txt' }, ctx);

      expect(vi.mocked(fsPromises.readFile)).toHaveBeenCalledWith('/absolute/path.txt', 'utf-8');
    });

    it('throws ToolError when file is not found', async () => {
      const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
      vi.mocked(fsPromises.readFile).mockRejectedValue(err);

      const { ToolError } = await import('./tool');
      await expect(fileReadTool.execute({ path: 'missing.txt' }, ctx)).rejects.toBeInstanceOf(
        ToolError,
      );
    });

    it('throws ToolError for non-ENOENT read errors (e.g. permission denied)', async () => {
      const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      vi.mocked(fsPromises.readFile).mockRejectedValue(err);

      const { ToolError } = await import('./tool');
      await expect(fileReadTool.execute({ path: 'secret.txt' }, ctx)).rejects.toBeInstanceOf(
        ToolError,
      );
    });
  });

  // ── file_write ─────────────────────────────────────────────────────────────

  describe('fileWriteTool', () => {
    it('has the name "file_write"', () => {
      expect(fileWriteTool.name).toBe('file_write');
    });

    it('has inputSchema with required path and content fields', () => {
      expect(fileWriteTool.inputSchema.required).toContain('path');
      expect(fileWriteTool.inputSchema.required).toContain('content');
    });

    it('writes the file and returns the path', async () => {
      vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      const result = await fileWriteTool.execute({ path: 'out.txt', content: 'data' }, ctx);
      expect(result.path).toBe(nodePath.join('/workspace', 'out.txt'));
    });

    it('resolves path relative to cwd', async () => {
      vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      await fileWriteTool.execute({ path: 'sub/out.txt', content: 'x' }, ctx);

      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
        nodePath.join('/workspace', 'sub/out.txt'),
        'x',
        'utf-8',
      );
    });

    it('creates parent directories if they do not exist', async () => {
      vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      await fileWriteTool.execute({ path: 'new/dir/file.txt', content: '' }, ctx);

      expect(vi.mocked(fsPromises.mkdir)).toHaveBeenCalledWith(
        nodePath.dirname(nodePath.join('/workspace', 'new/dir/file.txt')),
        { recursive: true },
      );
    });

    it('overwrites an existing file', async () => {
      vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      const result = await fileWriteTool.execute({ path: 'exist.txt', content: 'new' }, ctx);
      expect(result.path).toBeTruthy();
      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledOnce();
    });

    it('throws ToolError when mkdir fails', async () => {
      const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      vi.mocked(fsPromises.mkdir).mockRejectedValue(err);

      const { ToolError } = await import('./tool');
      await expect(
        fileWriteTool.execute({ path: 'locked/file.txt', content: 'x' }, ctx),
      ).rejects.toBeInstanceOf(ToolError);
    });

    it('throws ToolError when writeFile fails', async () => {
      vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
      const err = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      vi.mocked(fsPromises.writeFile).mockRejectedValue(err);

      const { ToolError } = await import('./tool');
      await expect(
        fileWriteTool.execute({ path: 'full.txt', content: 'x' }, ctx),
      ).rejects.toBeInstanceOf(ToolError);
    });
  });

  // ── file_edit ──────────────────────────────────────────────────────────────

  describe('fileEditTool', () => {
    it('has the name "file_edit"', () => {
      expect(fileEditTool.name).toBe('file_edit');
    });

    it('has inputSchema with required path, oldString, newString fields', () => {
      expect(fileEditTool.inputSchema.required).toContain('path');
      expect(fileEditTool.inputSchema.required).toContain('oldString');
      expect(fileEditTool.inputSchema.required).toContain('newString');
    });

    it('replaces first occurrence and returns changed: true', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('foo bar foo' as never);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      const result = await fileEditTool.execute(
        { path: 'file.txt', oldString: 'foo', newString: 'baz' },
        ctx,
      );

      expect(result.changed).toBe(true);
      expect(result.path).toBe(nodePath.join('/workspace', 'file.txt'));
      // Only the first occurrence replaced
      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
        expect.any(String),
        'baz bar foo',
        'utf-8',
      );
    });

    it('returns changed: false (not an error) when oldString is not found', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('hello world' as never);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      const result = await fileEditTool.execute(
        { path: 'file.txt', oldString: 'missing', newString: 'x' },
        ctx,
      );

      expect(result.changed).toBe(false);
      expect(vi.mocked(fsPromises.writeFile)).not.toHaveBeenCalled();
    });

    it('resolves path relative to cwd', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('old text' as never);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      await fileEditTool.execute({ path: 'sub/file.txt', oldString: 'old', newString: 'new' }, ctx);

      expect(vi.mocked(fsPromises.readFile)).toHaveBeenCalledWith(
        nodePath.join('/workspace', 'sub/file.txt'),
        'utf-8',
      );
    });

    it('throws ToolError when file is not found', async () => {
      const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
      vi.mocked(fsPromises.readFile).mockRejectedValue(err);

      const { ToolError } = await import('./tool');
      await expect(
        fileEditTool.execute({ path: 'missing.txt', oldString: 'a', newString: 'b' }, ctx),
      ).rejects.toBeInstanceOf(ToolError);
    });

    it('throws ToolError for non-ENOENT read errors (e.g. permission denied)', async () => {
      const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      vi.mocked(fsPromises.readFile).mockRejectedValue(err);

      const { ToolError } = await import('./tool');
      await expect(
        fileEditTool.execute({ path: 'secret.txt', oldString: 'a', newString: 'b' }, ctx),
      ).rejects.toBeInstanceOf(ToolError);
    });

    it('replaces at position 0 when oldString is empty string', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('hello' as never);
      vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);

      const result = await fileEditTool.execute(
        { path: 'file.txt', oldString: '', newString: 'prefix:' },
        ctx,
      );

      expect(result.changed).toBe(true);
      expect(vi.mocked(fsPromises.writeFile)).toHaveBeenCalledWith(
        expect.any(String),
        'prefix:hello',
        'utf-8',
      );
    });
  });
});
