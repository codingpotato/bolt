import { readdir, stat } from 'node:fs/promises';
import { resolve, sep, relative } from 'node:path';
import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';

function resolvePath(cwd: string, filePath: string): string {
  return resolve(cwd, filePath);
}

function assertWithinWorkspace(cwd: string, resolved: string, original: string): void {
  const boundary = cwd.endsWith(sep) ? cwd : cwd + sep;
  if (resolved !== cwd && !resolved.startsWith(boundary)) {
    throw new ToolError(`path "${original}" is outside the workspace (${cwd})`, false);
  }
}

function globToRegex(globPattern: string): RegExp {
  // Use placeholders for regex special chars that we'll insert
  const RECURSIVE_PREFIX = '__RECURSIVE_PREFIX__';
  const RECURSIVE_MID = '__RECURSIVE_MID__';
  const SUFFIX_ANY = '__SUFFIX_ANY__';

  let result = globPattern;
  if (result.startsWith('**/')) {
    result = RECURSIVE_PREFIX + result.slice(3);
  } else if (result.endsWith('/**')) {
    result = result.slice(0, -3) + SUFFIX_ANY;
  } else if (result === '**') {
    result = '.*';
  }

  result = result.replace(/\/\*\*\//g, RECURSIVE_MID);

  // Escape literal dots first
  result = result.replace(/\./g, '\\.');

  // Convert remaining glob chars
  result = result.replace(/\*/g, '[^/]*').replace(/\?/g, '.');

  // Now substitute placeholders with actual regex
  result = result.replace(new RegExp(RECURSIVE_PREFIX, 'g'), '(?:.+/)?');
  result = result.replace(new RegExp(RECURSIVE_MID, 'g'), '(?:/|.+/)?');
  result = result.replace(new RegExp(SUFFIX_ANY, 'g'), '(?:/.+)?');

  return new RegExp(`^${result}$`);
}

function matchesGlob(filePath: string, globPattern: string): boolean {
  const regex = globToRegex(globPattern);
  return regex.test(filePath);
}

export interface GlobInput {
  pattern: string;
  path?: string;
}

export interface GlobOutput {
  paths: string[];
}

interface FileWithMtime {
  path: string;
  mtimeMs: number;
}

async function collectFilesByMtime(
  searchRoot: string,
  globPattern: string,
  workspaceCwd: string,
): Promise<FileWithMtime[]> {
  const files: FileWithMtime[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        await walk(fullPath);
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.')) continue;
        const relativePath = relative(workspaceCwd, fullPath);
        if (!matchesGlob(relativePath, globPattern)) continue;
        try {
          const st = await stat(fullPath);
          files.push({ path: relativePath, mtimeMs: st.mtimeMs });
        } catch {
          // skip files we can't stat
        }
      }
    }
  }

  await walk(searchRoot);
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export const globTool: Tool<GlobInput, GlobOutput> = {
  name: 'glob',
  description:
    'Find files by name pattern (glob). Returns matching file paths sorted by modification time.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.test.ts").',
      },
      path: { type: 'string', description: 'Search root directory (default: cwd).' },
    },
    required: ['pattern'],
  },

  async execute(input: GlobInput, ctx: ToolContext): Promise<GlobOutput> {
    const searchRoot = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;

    assertWithinWorkspace(ctx.cwd, searchRoot, input.path || '.');

    const files = await collectFilesByMtime(searchRoot, input.pattern, ctx.cwd);

    return { paths: files.map((f) => f.path) };
  },
};
