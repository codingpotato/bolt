import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync, watch, FSWatcher } from 'node:fs';
import { dirname } from 'node:path';
import type { Config } from '../config/config';
import type { Skill } from '../skills/skill-loader';
import type { Tool } from '../tools/tool';
import { BUILTIN_AGENT_MD } from '../assets';
import type { Logger, TraceLogger } from '../logger';
import { createNoopLogger, createNoopTraceLogger } from '../logger';

/**
 * Assembles the system prompt from a single .bolt/AGENT.md file,
 * with dynamic skills and tools catalogs appended at startup.
 *
 * On first run, the built-in AGENT.md is copied to .bolt/AGENT.md.
 * Subsequent runs load .bolt/AGENT.md as-is.
 */

/**
 * Ensures .bolt/AGENT.md exists. If missing, copies the built-in default.
 * Returns the path to the file.
 */
export async function ensureAgentFile(
  config: Config,
  logger: Logger = createNoopLogger(),
): Promise<string> {
  const projectPath = config.agentPrompt.projectFile;
  if (!existsSync(projectPath)) {
    const dir = dirname(projectPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await copyFile(BUILTIN_AGENT_MD, projectPath);
    logger.info('AGENT.md copied from built-in', {
      source: BUILTIN_AGENT_MD,
      destination: projectPath,
    });
  }
  return projectPath;
}

/**
 * Loads the system prompt from .bolt/AGENT.md.
 * Copies the built-in AGENT.md if the file does not exist.
 */
export async function loadAgentPrompt(config: Config): Promise<string> {
  await ensureAgentFile(config);
  const content = await readFile(config.agentPrompt.projectFile, 'utf8');
  return content;
}

/**
 * Appends a dynamic skills catalog section to the system prompt.
 */
export function appendSkillsCatalog(prompt: string, skills: Skill[]): string {
  if (skills.length === 0) return prompt;

  const skillsSection = [
    '',
    '---',
    '',
    '## Available Skills',
    '',
    'The following skills are available via the `skill_run` tool:',
    '',
    '| Skill | Description |',
    '|-------|-------------|',
    ...skills.map((s) => `| \`${s.name}\` | ${s.description} |`),
  ].join('\n');

  return prompt + skillsSection;
}

/**
 * Appends a dynamic tools reference section to the system prompt.
 */
export function appendToolsReference(prompt: string, tools: Tool[]): string {
  if (tools.length === 0) return prompt;

  const toolsSection = [
    '',
    '---',
    '',
    '## Available Tools',
    '',
    'The following tools are available. Detailed input schemas are provided via the API tools parameter.',
    '',
    '| Tool | Use for |',
    '|------|---------|',
    ...tools.map((t) => `| \`${t.name}\` | ${t.description} |`),
  ].join('\n');

  return prompt + toolsSection;
}

/**
 * Estimates token count from a string using a simple word-to-token heuristic.
 * ~1.3 tokens per word for English text.
 */
export function estimateTokenCount(text: string): number {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return Math.ceil(wordCount * 1.3);
}

/**
 * Assembles the complete system prompt: AGENT.md + skills catalog + tools reference.
 */
export async function assembleSystemPrompt(
  config: Config,
  skills: Skill[],
  tools: Tool[],
  logger: Logger = createNoopLogger(),
  traceLogger: TraceLogger = createNoopTraceLogger(),
): Promise<string> {
  const base = await loadAgentPrompt(config);
  const withSkills = appendSkillsCatalog(base, skills);
  const withTools = appendToolsReference(withSkills, tools);

  const baseTokens = estimateTokenCount(base);
  const skillsTokens = estimateTokenCount(withSkills) - baseTokens;
  const toolsTokens = estimateTokenCount(withTools) - baseTokens - skillsTokens;
  const totalTokens = baseTokens + skillsTokens + toolsTokens;

  logger.info('System prompt assembled', {
    base: { chars: base.length, tokens: baseTokens },
    skills: { count: skills.length, chars: withSkills.length - base.length, tokens: skillsTokens },
    tools: { count: tools.length, chars: withTools.length - withSkills.length, tokens: toolsTokens },
    total: { chars: withTools.length, tokens: totalTokens },
  });

  traceLogger.systemPrompt(withTools, {
    model: config.model,
    chars: withTools.length,
    tokens: totalTokens,
    base: { chars: base.length, tokens: baseTokens },
    skills: { chars: withSkills.length - base.length, tokens: skillsTokens, count: skills.length },
    tools: { chars: withTools.length - withSkills.length, tokens: toolsTokens, count: tools.length },
  });

  if (skills.length === 0) {
    logger.warn('No skills found for system prompt');
  }
  if (tools.length === 0) {
    logger.warn('No tools found for system prompt');
  }

  return withTools;
}

/**
 * Watches the AGENT.md file for changes and calls the callback when it changes.
 * Returns a cleanup function.
 */
export function watchAgentPrompt(config: Config, onChange: () => void): () => void {
  const filePath = config.agentPrompt.projectFile;
  if (!existsSync(filePath)) {
    return () => {};
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  const watcher: FSWatcher = watch(filePath, () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      try {
        onChange();
      } finally {
        timeout = null;
      }
    }, 500);
  });

  return () => {
    if (timeout) clearTimeout(timeout);
    watcher.close();
  };
}

/**
 * Extracts named sections from a system prompt by header.
 * Used for sub-agent rule inheritance.
 */
export function extractPromptSections(
  prompt: string,
  sectionNames: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = prompt.split('\n');

  for (const sectionName of sectionNames) {
    const header = `## ${sectionName}`;
    const headerIndex = lines.findIndex(
      (line) => line.trim() === header || line.trim().startsWith(header + ' '),
    );
    if (headerIndex === -1) continue;

    const sectionLines: string[] = [];
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) break;
      const trimmed = line.trim();
      if (trimmed.startsWith('## ') && !trimmed.startsWith('### ')) {
        break;
      }
      sectionLines.push(line);
    }

    const content = sectionLines.join('\n').trim();
    if (content.length > 0) {
      result[sectionName] = content;
    }
  }

  return result;
}
