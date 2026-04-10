import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { Dirent, Stats } from 'node:fs';
import type { ToolContext } from './tool';
import { globTool } from './glob';

vi.mock('node:fs/promises');

function makeFile(name: string, _mtimeMs = 1000): Dirent {
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

describe('glob tool', () => {
  let mockLogger: { log: (tool: string, input: unknown, result: unknown) => Promise<void> };
  let ctx: ToolContext;

  beforeEach(() => {
    vi.mocked(fsPromises.readdir).mockReset();
    vi.mocked(fsPromises.stat).mockReset();
    vi.mocked(fsPromises.stat).mockResolvedValue({ mtimeMs: 1000 } as import('node:fs').Stats);
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

  describe('globTool', () => {
    it('has the name "glob"', () => {
      expect(globTool.name).toBe('glob');
    });

    it('has inputSchema with required pattern field', () => {
      expect(globTool.inputSchema.required).toContain('pattern');
    });

    it('returns matching file paths sorted by mtime', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([
        makeFile('a.ts'),
        makeFile('b.ts'),
      ] as never);
      vi.mocked(fsPromises.stat).mockResolvedValue({ mtimeMs: 1000 } as never);

      const result = await globTool.execute({ pattern: '**/*.ts' }, ctx);

      expect(result.paths).toHaveLength(2);
    });

    it('supports recursive glob patterns', async () => {
      vi.mocked(fsPromises.readdir)
        .mockResolvedValueOnce([makeDir('src')] as never)
        .mockResolvedValueOnce([makeFile('app.ts')] as never);
      vi.mocked(fsPromises.stat).mockResolvedValue({ mtimeMs: 1000 } as never);

      const result = await globTool.execute({ pattern: '**/*.ts' }, ctx);

      expect(result.paths).toHaveLength(1);
      expect(result.paths[0]).toBe(nodePath.join('src', 'app.ts'));
    });

    it('scopes search to a specific path', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([makeFile('test.ts')] as never);
      vi.mocked(fsPromises.stat).mockResolvedValue({ mtimeMs: 1000 } as never);

      await globTool.execute({ pattern: '*.ts', path: 'src' }, ctx);

      expect(vi.mocked(fsPromises.readdir)).toHaveBeenCalledWith(
        nodePath.join('/workspace', 'src'),
        { withFileTypes: true },
      );
    });

    it('throws ToolError for path outside workspace', async () => {
      const { ToolError } = await import('./tool');
      await expect(
        globTool.execute({ pattern: '*.ts', path: '../../etc' }, ctx),
      ).rejects.toBeInstanceOf(ToolError);
    });

    it('returns empty array when no matches found', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([makeFile('readme.md')] as never);

      const result = await globTool.execute({ pattern: '**/*.ts' }, ctx);

      expect(result.paths).toHaveLength(0);
    });

    it('skips dotfiles and dot-directories', async () => {
      vi.mocked(fsPromises.readdir)
        .mockResolvedValueOnce([
          makeDir('.git'),
          makeFile('.hidden'),
          makeFile('visible.ts'),
        ] as never)
        .mockResolvedValueOnce([]);
      vi.mocked(fsPromises.stat).mockResolvedValue({ mtimeMs: 1000 } as never);

      const result = await globTool.execute({ pattern: '**/*' }, ctx);

      expect(result.paths).toHaveLength(1);
      expect(result.paths[0]).toBe('visible.ts');
    });

    it('returns paths matching glob pattern', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue([
        makeFile('old.ts'),
        makeFile('new.ts'),
      ] as never);
      vi.mocked(fsPromises.stat).mockResolvedValue({ mtimeMs: 1000 } as Stats);

      const result = await globTool.execute({ pattern: '**/*.ts' }, ctx);

      expect(result.paths).toHaveLength(2);
      expect(result.paths).toContain('old.ts');
      expect(result.paths).toContain('new.ts');
    });

    it('sorts results by modification time (newest first)', async () => {
      const mockDirent = (name: string, isDir: boolean) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isSymbolicLink: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      });

      vi.mocked(fsPromises.readdir).mockResolvedValue([
        mockDirent('a.ts', false),
        mockDirent('b.ts', false),
      ] as never);

      const statMock = vi.mocked(fsPromises.stat);
      statMock.mockImplementation(async (p) => {
        const pathStr = typeof p === 'string' ? p : String(p);
        const mtime = pathStr.includes('a.ts') ? 1000 : 2000;
        return { mtimeMs: mtime } as Stats;
      });

      const result = await globTool.execute({ pattern: '*.ts' }, ctx);

      expect(result.paths).toHaveLength(2);
      expect(result.paths[0]).toBe('b.ts');
      expect(result.paths[1]).toBe('a.ts');
    });
  });
});
