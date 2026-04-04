import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';

export const MAX_FILE_CHARS = 20_000;

function resolvePath(cwd: string, filePath: string): string {
  return resolve(cwd, filePath);
}

/**
 * Throws a non-retryable ToolError if `resolved` is not strictly inside `cwd`.
 * The workspace root itself is also rejected — only files *within* it are allowed.
 */
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

/** Wraps any filesystem error as a ToolError so it is returned to the model rather than crashing the agent loop. */
function fsError(operation: string, path: string, err: unknown): ToolError {
  const detail = err instanceof Error ? err.message : String(err);
  return new ToolError(`${operation} "${path}": ${detail}`);
}

// ── file_read ─────────────────────────────────────────────────────────────────

export interface FileReadInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface FileReadOutput {
  content: string;
  totalSize?: number;
}

export const fileReadTool: Tool<FileReadInput, FileReadOutput> = {
  name: 'file_read',
  description:
    'Read a file from disk. Optional offset (character offset) and limit (max chars) for chunked reading. ' +
    `Default limit is ${MAX_FILE_CHARS} characters.`,
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to cwd or absolute).' },
      offset: {
        type: 'number',
        description: 'Character offset to start reading from. Default: 0.',
      },
      limit: {
        type: 'number',
        description: `Maximum characters to read. Default: ${MAX_FILE_CHARS}.`,
      },
    },
    required: ['path'],
  },

  async execute(input: FileReadInput, ctx: ToolContext): Promise<FileReadOutput> {
    const abs = resolvePath(ctx.cwd, input.path);
    assertWithinWorkspace(ctx.cwd, abs, input.path);
    try {
      const fullContent = await readFile(abs, 'utf-8');
      const totalSize = fullContent.length;
      const offset = input.offset ?? 0;
      const limit = input.limit ?? MAX_FILE_CHARS;
      let content = fullContent.slice(offset, offset + limit);
      if (totalSize > offset + limit) {
        content =
          content + `\n\n[truncated — file exceeded ${limit} characters, use offset to read more]`;
      }
      const output: FileReadOutput = { content };
      if (totalSize > limit || offset > 0) {
        output.totalSize = totalSize;
      }
      return output;
    } catch (err) {
      if (isEnoent(err)) throw new ToolError(`file not found: ${input.path}`);
      throw fsError('could not read', input.path, err);
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
    assertWithinWorkspace(ctx.cwd, abs, input.path);
    try {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, input.content, 'utf-8');
    } catch (err) {
      throw fsError('could not write', input.path, err);
    }
    return { path: abs };
  },
};

// ── file_edit ─────────────────────────────────────────────────────────────────

export interface FileEditInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface FileEditOutput {
  path: string;
  changed: boolean;
  replacements?: number;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  const idx = (i: number, j: number): number => i * (n + 1) + j;
  for (let i = 0; i <= m; i++) {
    dp[idx(i, 0)] = i;
  }
  for (let j = 0; j <= n; j++) {
    dp[idx(0, j)] = j;
  }
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      dp[idx(i, j)] = Math.min(
        (dp[idx(i - 1, j)] as number) + 1,
        (dp[idx(i, j - 1)] as number) + 1,
        (dp[idx(i - 1, j - 1)] as number) + cost,
      );
    }
  }
  return dp[idx(m, n)] as number;
}

function findClosestMatches(
  search: string,
  content: string,
  count: number,
): Array<{ match: string; context: string; distance: number }> {
  const lines = content.split('\n');
  const candidates: Array<{ match: string; context: string; distance: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.length < 2) continue;

    const windowSize = Math.min(search.length, line.length);
    for (let j = 0; j <= line.length - windowSize; j++) {
      const substr = line.slice(j, j + windowSize);
      const dist = levenshtein(substr, search.slice(0, windowSize));
      if (dist <= windowSize * 0.5) {
        const startLine = Math.max(0, i - 2);
        const endLine = Math.min(lines.length - 1, i + 2);
        const context = lines.slice(startLine, endLine + 1).join('\n');
        candidates.push({ match: substr, context, distance: dist });
      }
    }
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates.slice(0, count);
}

export const fileEditTool: Tool<FileEditInput, FileEditOutput> = {
  name: 'file_edit',
  description:
    'Replace occurrences of oldString with newString in a file. ' +
    'Set replaceAll: true to replace all occurrences (default: false, replaces first only).',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file (relative to cwd or absolute).' },
      oldString: { type: 'string', description: 'The substring to find and replace.' },
      newString: { type: 'string', description: 'The replacement string.' },
      replaceAll: {
        type: 'boolean',
        description: 'Replace all occurrences. Default: false (first occurrence only).',
      },
    },
    required: ['path', 'oldString', 'newString'],
  },

  async execute(input: FileEditInput, ctx: ToolContext): Promise<FileEditOutput> {
    const abs = resolvePath(ctx.cwd, input.path);
    assertWithinWorkspace(ctx.cwd, abs, input.path);
    let content: string;
    try {
      content = await readFile(abs, 'utf-8');
    } catch (err) {
      if (isEnoent(err)) throw new ToolError(`file not found: ${input.path}`);
      throw fsError('could not read', input.path, err);
    }

    if (input.replaceAll) {
      const occurrences: number[] = [];
      let idx = content.indexOf(input.oldString);
      while (idx !== -1) {
        occurrences.push(idx);
        idx = content.indexOf(input.oldString, idx + input.oldString.length);
      }

      if (occurrences.length === 0) {
        const closest = findClosestMatches(input.oldString, content, 3);
        let message = `oldString not found in file. Closest matches found:\n`;
        for (const c of closest) {
          message += `\n--- Similar text (distance: ${c.distance}) ---\n${c.context}\n`;
        }
        throw new ToolError(message, false);
      }

      const updated = content.split(input.oldString).join(input.newString);
      await writeFile(abs, updated, 'utf-8');
      return { path: abs, changed: true, replacements: occurrences.length };
    }

    const idx = content.indexOf(input.oldString);
    if (idx === -1) {
      const closest = findClosestMatches(input.oldString, content, 3);
      let message = `oldString not found in file. Closest matches found:\n`;
      for (const c of closest) {
        message += `\n--- Similar text (distance: ${c.distance}) ---\n${c.context}\n`;
      }
      throw new ToolError(message, false);
    }

    const updated =
      content.slice(0, idx) + input.newString + content.slice(idx + input.oldString.length);
    await writeFile(abs, updated, 'utf-8');
    return { path: abs, changed: true, replacements: 1 };
  },
};
