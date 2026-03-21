import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';

function resolvePath(cwd: string, filePath: string): string {
  return resolve(cwd, filePath);
}

function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

// ── file_read ─────────────────────────────────────────────────────────────────

export interface FileReadInput {
  path: string;
}

export interface FileReadOutput {
  content: string;
}

export const fileReadTool: Tool<FileReadInput, FileReadOutput> = {
  name: 'file_read',
  description: 'Read a file from disk and return its content as a string.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to cwd or absolute).' },
    },
    required: ['path'],
  },

  async execute(input: FileReadInput, ctx: ToolContext): Promise<FileReadOutput> {
    const abs = resolvePath(ctx.cwd, input.path);
    try {
      const content = await readFile(abs, 'utf-8');
      return { content };
    } catch (err) {
      if (isEnoent(err)) {
        throw new ToolError(`file not found: ${input.path}`);
      }
      throw err;
    }
  },
};

// ── file_write ────────────────────────────────────────────────────────────────

export interface FileWriteInput {
  path: string;
  content: string;
}

export interface FileWriteOutput {
  path: string;
}

export const fileWriteTool: Tool<FileWriteInput, FileWriteOutput> = {
  name: 'file_write',
  description: 'Write (or overwrite) a file on disk.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Destination path (relative to cwd or absolute).' },
      content: { type: 'string', description: 'Text content to write.' },
    },
    required: ['path', 'content'],
  },

  async execute(input: FileWriteInput, ctx: ToolContext): Promise<FileWriteOutput> {
    const abs = resolvePath(ctx.cwd, input.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, input.content, 'utf-8');
    return { path: abs };
  },
};

// ── file_edit ─────────────────────────────────────────────────────────────────

export interface FileEditInput {
  path: string;
  oldString: string;
  newString: string;
}

export interface FileEditOutput {
  path: string;
  changed: boolean;
}

export const fileEditTool: Tool<FileEditInput, FileEditOutput> = {
  name: 'file_edit',
  description:
    'Replace the first occurrence of oldString with newString in a file. ' +
    'Returns changed: false (not an error) if oldString is not found.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to cwd or absolute).' },
      oldString: { type: 'string', description: 'The substring to find and replace.' },
      newString: { type: 'string', description: 'The replacement string.' },
    },
    required: ['path', 'oldString', 'newString'],
  },

  async execute(input: FileEditInput, ctx: ToolContext): Promise<FileEditOutput> {
    const abs = resolvePath(ctx.cwd, input.path);
    let content: string;
    try {
      content = await readFile(abs, 'utf-8');
    } catch (err) {
      if (isEnoent(err)) {
        throw new ToolError(`file not found: ${input.path}`);
      }
      throw err;
    }

    const idx = content.indexOf(input.oldString);
    if (idx === -1) {
      return { path: abs, changed: false };
    }

    const updated =
      content.slice(0, idx) + input.newString + content.slice(idx + input.oldString.length);
    await writeFile(abs, updated, 'utf-8');
    return { path: abs, changed: true };
  },
};
