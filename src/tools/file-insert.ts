import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';

function resolvePath(cwd: string, filePath: string): string {
  return resolve(cwd, filePath);
}

function assertWithinWorkspace(cwd: string, resolved: string, original: string): void {
  const boundary = cwd.endsWith(sep) ? cwd : cwd + sep;
  if (!resolved.startsWith(boundary)) {
    throw new ToolError(`path "${original}" is outside the workspace (${cwd})`, false);
  }
}

function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function fsError(operation: string, path: string, err: unknown): ToolError {
  const detail = err instanceof Error ? err.message : String(err);
  return new ToolError(`${operation} "${path}": ${detail}`);
}

export interface FileInsertInput {
  path: string;
  content: string;
  line?: number;
}

export interface FileInsertOutput {
  path: string;
}

export const fileInsertTool: Tool<FileInsertInput, FileInsertOutput> = {
  name: 'file_insert',
  description:
    'Insert content at a specific line in a file. line is 1-indexed (line: 1 = top). ' +
    'line: 0 or omitted appends after the last line. Creates file if it does not exist.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to cwd or absolute).' },
      content: { type: 'string', description: 'Content to insert.' },
      line: {
        type: 'number',
        description: '1-indexed line number to insert at. 0 or omitted appends at end. Default: 0.',
      },
    },
    required: ['path', 'content'],
  },

  async execute(input: FileInsertInput, ctx: ToolContext): Promise<FileInsertOutput> {
    const abs = resolvePath(ctx.cwd, input.path);
    assertWithinWorkspace(ctx.cwd, abs, input.path);

    let content: string;
    try {
      content = await readFile(abs, 'utf-8');
    } catch (err) {
      if (!isEnoent(err)) throw fsError('could not read', input.path, err);
      // File doesn't exist — create it with the content
      try {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, input.content, 'utf-8');
      } catch (writeErr) {
        throw fsError('could not write', input.path, writeErr);
      }
      return { path: abs };
    }

    const lines = content.split('\n');
    const insertLine = input.line ?? 0;

    let insertIndex: number;
    if (insertLine <= 0 || insertLine > lines.length) {
      insertIndex = lines.length;
    } else {
      insertIndex = insertLine - 1;
    }

    const newLines = [...lines.slice(0, insertIndex), input.content, ...lines.slice(insertIndex)];
    const updated = newLines.join('\n');

    try {
      await writeFile(abs, updated, 'utf-8');
    } catch (err) {
      throw fsError('could not write', input.path, err);
    }

    return { path: abs };
  },
};
