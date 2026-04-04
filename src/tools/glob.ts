import { readdir, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import type { Tool, ToolContext } from './tool';
import { resolvePath, assertWithinWorkspaceAllowRoot, matchesGlob, type Dirent } from './fs-utils';

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
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = resolvePath(dir, entry.name);

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

    assertWithinWorkspaceAllowRoot(ctx.cwd, searchRoot, input.path || '.');

    const files = await collectFilesByMtime(searchRoot, input.pattern, ctx.cwd);

    return { paths: files.map((f) => f.path) };
  },
};
