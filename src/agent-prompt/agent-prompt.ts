import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Config } from '../config/config';

export const DEFAULT_SYSTEM_PROMPT = `You are bolt, an autonomous AI agent operated from the command line.

You operate in two modes:
- Simple chat: respond directly to the user's message.
- Task-driven: for complex or multi-step goals, break work into tasks using
  task_create, execute them step by step, and track outcomes.

Prefer task-driven mode for anything that involves more than one non-trivial step.
Always persist important decisions and learned facts using memory_write.`;

export function expandTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return homedir() + filePath.slice(1);
  }
  return filePath;
}

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

/**
 * Assembles the system prompt from AGENT.md files at startup.
 *
 * Loading order:
 *   1. ~/.bolt/AGENT.md (user-level)   — prepended
 *   2. .bolt/AGENT.md  (project-level) — appended
 *
 * If neither file exists, the built-in default prompt is returned.
 * Missing files are silently skipped. The paths can be overridden via config.
 */
export async function loadAgentPrompt(config: Config): Promise<string> {
  const userPath = expandTilde(config.agentPrompt.userFile);
  const projectPath = config.agentPrompt.projectFile;

  const [userContent, projectContent] = await Promise.all([
    tryReadFile(userPath),
    tryReadFile(projectPath),
  ]);

  if (userContent === null && projectContent === null) {
    return DEFAULT_SYSTEM_PROMPT;
  }

  const parts: string[] = [];
  if (userContent !== null) parts.push(userContent);
  if (projectContent !== null) parts.push(projectContent);
  return parts.join('\n\n');
}
