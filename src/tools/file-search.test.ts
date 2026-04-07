import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { Dirent } from 'node:fs';
import type { ToolContext } from './tool';
import { fileSearchTool } from './file-search';

vi.mock('node:fs/promises');

function makeFile(name: string): Dirent {
  return {
    name,
    isDirectory: () => false,
    isFile: () => true,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as unknown as Dirent;
}

function makeDir(name: string): Dirent {
  return {
    name,
    isDirectory: () => true,
    isFile: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as unknown as Dirent;
}

describe('file_search tool', () => {
  let mockLogger: { log: (tool: string, input: unknown, result: unknown) => Promise<void> };
  let ctx: ToolContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = { log: vi.fn().mockResolvedValue(undefined) };
    ctx = {
      cwd: '/workspace',
      log: mockLogger,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as import('../logger').Logger,
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

  describe('fileSearchTool', () => {
    it('has the name "file_search"', () => {
      expect(fileSearchTool.name).toBe('file_search');
    });

    it('has inputSchema with required pattern field', () => {
      expect(fileSearchTool.inputSchema.required).toContain('pattern');
    });

    it('returns regex matches with file, line, content', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([makeFile('test.ts')] as never);
      vi.mocked(fsPromises.readFile).mockResolvedValue('const x = 42;\nconst y = 100;\n' as never);

      const result = await fileSearchTool.execute({ pattern: 'const' }, ctx);

      expect(result.matches).toHaveLength(2);
      expect(result.matches[0]!).toEqual({
        file: 'test.ts',
        line: 1,
        content: 'const x = 42;',
      });
      expect(result.matches[1]!).toEqual({
        file: 'test.ts',
        line: 2,
        content: 'const y = 100;',
      });
      expect(result.totalCount).toBe(2);
    });

    it('treats pattern as literal when regex: false', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([makeFile('test.ts')] as never);
      vi.mocked(fsPromises.readFile).mockResolvedValue('foo.bar(baz)' as never);

      const result = await fileSearchTool.execute({ pattern: 'foo.bar', regex: false }, ctx);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]!.content).toBe('foo.bar(baz)');
    });

    it('is case-insensitive by default', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([makeFile('test.ts')] as never);
      vi.mocked(fsPromises.readFile).mockResolvedValue('const X = 1;\nconst x = 2;' as never);

      const result = await fileSearchTool.execute({ pattern: 'const x' }, ctx);

      expect(result.matches).toHaveLength(2);
    });

    it('is case-sensitive when caseSensitive: true', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([makeFile('test.ts')] as never);
      vi.mocked(fsPromises.readFile).mockResolvedValue('const X = 1;\nconst x = 2;' as never);

      const result = await fileSearchTool.execute({ pattern: 'const x', caseSensitive: true }, ctx);

      expect(result.matches).toHaveLength(1);
    });

    it('truncates results to maxResults', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([makeFile('test.ts')] as never);
      const manyLines = Array.from({ length: 10 }, (_, i) => `const line${i};`).join('\n');
      vi.mocked(fsPromises.readFile).mockResolvedValue(manyLines as never);

      const result = await fileSearchTool.execute({ pattern: 'const', maxResults: 3 }, ctx);

      expect(result.matches).toHaveLength(3);
      expect(result.totalCount).toBe(10);
    });

    it('truncates long content lines to 500 chars', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([makeFile('test.ts')] as never);
      const longLine = 'const x = ' + 'a'.repeat(600) + ';';
      vi.mocked(fsPromises.readFile).mockResolvedValue(longLine as never);

      const result = await fileSearchTool.execute({ pattern: 'const' }, ctx);

      expect(result.matches[0]!.content.length).toBeLessThanOrEqual(503);
      expect(result.matches[0]!.content.endsWith('...')).toBe(true);
    });

    it('filters by include glob', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([
        makeFile('test.ts'),
        makeFile('test.js'),
      ] as never);
      vi.mocked(fsPromises.readFile).mockResolvedValue('const x = 1;' as never);

      const result = await fileSearchTool.execute({ pattern: 'const', include: '*.ts' }, ctx);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]!.file).toBe('test.ts');
    });

    it('scopes search to a specific path', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([makeFile('inner.ts')] as never);
      vi.mocked(fsPromises.readFile).mockResolvedValue('const x = 1;' as never);

      await fileSearchTool.execute({ pattern: 'const', path: 'src' }, ctx);

      expect(vi.mocked(fsPromises.readdir)).toHaveBeenCalledWith(
        nodePath.join('/workspace', 'src'),
        { withFileTypes: true },
      );
    });

    it('throws ToolError for path outside workspace', async () => {
      const { ToolError } = await import('./tool');
      await expect(
        fileSearchTool.execute({ pattern: 'x', path: '../../etc' }, ctx),
      ).rejects.toBeInstanceOf(ToolError);
    });

    it('returns empty results when no matches found', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([makeFile('test.ts')] as never);
      vi.mocked(fsPromises.readFile).mockResolvedValue('no match here' as never);

      const result = await fileSearchTool.execute({ pattern: 'const' }, ctx);

      expect(result.matches).toHaveLength(0);
      expect(result.totalCount).toBe(0);
    });

    it('throws ToolError for invalid regex', async () => {
      const { ToolError } = await import('./tool');
      await expect(fileSearchTool.execute({ pattern: '[invalid' }, ctx)).rejects.toBeInstanceOf(
        ToolError,
      );
    });

    it('recurses into subdirectories', async () => {
      vi.mocked(fsPromises.readdir)
        .mockResolvedValueOnce([makeDir('src')] as never)
        .mockResolvedValueOnce([makeFile('app.ts')] as never);
      vi.mocked(fsPromises.readFile).mockResolvedValue('const app = true;' as never);

      const result = await fileSearchTool.execute({ pattern: 'const' }, ctx);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]!.file).toBe(nodePath.join('src', 'app.ts'));
    });

    it('skips dotfiles and dot-directories', async () => {
      vi.mocked(fsPromises.readdir)
        .mockResolvedValueOnce([
          makeDir('.git'),
          makeFile('.hidden'),
          makeFile('visible.ts'),
        ] as never)
        .mockResolvedValueOnce([]);
      vi.mocked(fsPromises.readFile).mockResolvedValue('const x = 1;' as never);

      const result = await fileSearchTool.execute({ pattern: 'const' }, ctx);

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]!.file).toBe('visible.ts');
    });
  });
});
