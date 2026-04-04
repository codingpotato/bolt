import { readFile, readdir } from 'node:fs/promises';
import { resolve, sep, relative } from 'node:path';
import { ToolError } from './tool';
import type { Tool, ToolContext } from './tool';

const MAX_CONTENT_LINE_LENGTH = 500;
const DEFAULT_MAX_RESULTS = 50;

function resolvePath(cwd: string, filePath: string): string {
  return resolve(cwd, filePath);
}

function assertWithinWorkspace(cwd: string, resolved: string, original: string): void {
  const boundary = cwd.endsWith(sep) ? cwd : cwd + sep;
  if (resolved !== cwd && !resolved.startsWith(boundary)) {
    throw new ToolError(`path "${original}" is outside the workspace (${cwd})`, false);
  }
}

interface FileSearchMatch {
  file: string;
  line: number;
  content: string;
}

export interface FileSearchInput {
  pattern: string;
  regex?: boolean;
  path?: string;
  include?: string;
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface FileSearchOutput {
  matches: FileSearchMatch[];
  totalCount: number;
}

function globToRegex(globPattern: string): RegExp {
  let regex = globPattern
    .replace(/\./g, '\\.')
    .replace(/\*\*\//g, '(.*/)?')
    .replace(/\*\*/g, '(.*)')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regex}$`);
}

function matchesGlob(filePath: string, globPattern: string): boolean {
  const regex = globToRegex(globPattern);
  return regex.test(filePath);
}

async function collectFiles(
  searchRoot: string,
  includeGlob: string | undefined,
  workspaceCwd: string,
): Promise<string[]> {
  const files: string[] = [];

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
        if (includeGlob && !matchesGlob(relativePath, includeGlob)) continue;
        files.push(fullPath);
      }
    }
  }

  await walk(searchRoot);
  return files.sort();
}

export const fileSearchTool: Tool<FileSearchInput, FileSearchOutput> = {
  name: 'file_search',
  description:
    'Search file contents by regex or literal pattern. Returns matching lines with file paths and line numbers.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The regex or literal pattern to search for.' },
      regex: {
        type: 'boolean',
        description: 'Treat pattern as regex. Defaults to true.',
      },
      path: {
        type: 'string',
        description: 'File or directory to search in (default: cwd).',
      },
      include: {
        type: 'string',
        description: 'Glob filter for file names (e.g. "*.ts").',
      },
      caseSensitive: {
        type: 'boolean',
        description: 'Whether the search is case-sensitive. Defaults to false.',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return. Defaults to 50.',
      },
    },
    required: ['pattern'],
  },

  async execute(input: FileSearchInput, ctx: ToolContext): Promise<FileSearchOutput> {
    const searchRoot = input.path ? resolvePath(ctx.cwd, input.path) : ctx.cwd;

    assertWithinWorkspace(ctx.cwd, searchRoot, input.path || '.');

    const isRegex = input.regex !== false;
    const caseSensitive = input.caseSensitive === true;
    const maxResults = input.maxResults ?? DEFAULT_MAX_RESULTS;

    let searchRegex: RegExp;
    try {
      const flags = caseSensitive ? 'g' : 'gi';
      if (isRegex) {
        searchRegex = new RegExp(input.pattern, flags);
      } else {
        const escaped = input.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        searchRegex = new RegExp(escaped, flags);
      }
    } catch {
      throw new ToolError(`invalid regex pattern: ${input.pattern}`, false);
    }

    const files = await collectFiles(searchRoot, input.include, ctx.cwd);

    const matches: FileSearchMatch[] = [];
    let totalCount = 0;

    for (const filePath of files) {
      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        continue;
      }

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const lineContent = lines[i] as string;
        const match = searchRegex.exec(lineContent);
        if (match) {
          searchRegex.lastIndex = 0;
          totalCount++;
          if (matches.length < maxResults) {
            const truncatedContent =
              lineContent.length > MAX_CONTENT_LINE_LENGTH
                ? lineContent.slice(0, MAX_CONTENT_LINE_LENGTH) + '...'
                : lineContent;
            const relativePath = relative(ctx.cwd, filePath);
            matches.push({
              file: relativePath,
              line: i + 1,
              content: truncatedContent,
            });
          }
        }
      }
    }

    return { matches, totalCount };
  },
};
