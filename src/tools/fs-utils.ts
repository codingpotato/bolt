import { resolve, sep } from 'node:path';
import type { Dirent } from 'node:fs';
import { ToolError } from './tool';

export function resolvePath(cwd: string, filePath: string): string {
  return resolve(cwd, filePath);
}

/**
 * Throws a non-retryable ToolError if `resolved` is not strictly inside `cwd`.
 * The workspace root itself is also rejected — only files *within* it are allowed.
 */
export function assertWithinWorkspace(cwd: string, resolved: string, original: string): void {
  const boundary = cwd.endsWith(sep) ? cwd : cwd + sep;
  if (!resolved.startsWith(boundary)) {
    throw new ToolError(`path "${original}" is outside the workspace (${cwd})`, false);
  }
}

/**
 * Like assertWithinWorkspace, but allows `resolved === cwd` (used by search/glob tools
 * that operate on directories rather than individual files).
 */
export function assertWithinWorkspaceAllowRoot(
  cwd: string,
  resolved: string,
  original: string,
): void {
  const boundary = cwd.endsWith(sep) ? cwd : cwd + sep;
  if (resolved !== cwd && !resolved.startsWith(boundary)) {
    throw new ToolError(`path "${original}" is outside the workspace (${cwd})`, false);
  }
}

export function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** Wraps any filesystem error as a ToolError so it is returned to the model rather than crashing the agent loop. */
export function fsError(operation: string, path: string, err: unknown): ToolError {
  const detail = err instanceof Error ? err.message : String(err);
  return new ToolError(`${operation} "${path}": ${detail}`);
}

/** Convert a glob pattern to a regular expression. */
export function globToRegex(globPattern: string): RegExp {
  const RECURSIVE = '\x00RECURSIVE\x00';
  const SUFFIX_STARSTAR = '\x00SUFFIX_SS\x00';
  const MID_STARSTAR = '\x00MID_SS\x00';

  let result = globPattern;

  if (result === '**') {
    return /^.*$/;
  }

  if (result.startsWith('**/')) {
    result = RECURSIVE + result.slice(3);
  }

  if (result.endsWith('/**')) {
    result = result.slice(0, -3) + SUFFIX_STARSTAR;
  }

  result = result.replace(/\*\*\//g, MID_STARSTAR);

  result = result.replace(/\./g, '\\.').replace(/\*/g, '[^/]*').replace(/\?/g, '.');

  result = result.replace(new RegExp(RECURSIVE, 'g'), '(?:.+/)?');
  result = result.replace(new RegExp(MID_STARSTAR, 'g'), '(?:.+/)?');
  result = result.replace(new RegExp(SUFFIX_STARSTAR, 'g'), '(?:/.+)?');

  return new RegExp(`^${result}$`);
}

/** Test whether a file path matches a glob pattern. */
export function matchesGlob(filePath: string, globPattern: string): boolean {
  return globToRegex(globPattern).test(filePath);
}

export type { Dirent };
