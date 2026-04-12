import { ToolError } from './tool';
import type { Tool, ToolContext, JSONSchema } from './tool';
import { loadSkillsFromDir } from '../skills/skill-loader';
import type { Skill } from '../skills/skill-loader';
import type { AuthConfig } from '../auth/auth';
import type { SubagentPayload, SubagentRunner } from '../subagent/subagent-runner';
import type { Logger } from '../logger';
import { createNoopLogger } from '../logger';

export interface SkillRunInput {
  name: string;
  args: Record<string, unknown>;
}

export interface SkillRunOutput {
  result: unknown;
}

/**
 * Validates that all required fields declared in the schema are present and
 * non-null in the given value.  Returns an error string, or null if valid.
 */
function validateRequiredFields(schema: JSONSchema, value: unknown): string | null {
  const required = schema.required;
  if (!required || required.length === 0) return null;

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return 'expected an object';
  }
  const obj = value as Record<string, unknown>;
  for (const field of required) {
    if (!(field in obj) || obj[field] == null) {
      return `required field "${field}" is missing`;
    }
  }
  return null;
}

/**
 * Compute the effective allowedTools for the skill agent:
 * - Both defined  → intersection (most restrictive wins)
 * - One defined   → that list
 * - Neither       → undefined (all tools permitted)
 */
function resolveAllowedTools(
  parentAllowed: string[] | undefined,
  skillAllowed: string[] | undefined,
): string[] | undefined {
  if (parentAllowed !== undefined && skillAllowed !== undefined) {
    return skillAllowed.filter((t) => parentAllowed.includes(t));
  }
  return skillAllowed ?? parentAllowed;
}

/**
 * Attempts to extract a JSON object from a string that may contain surrounding
 * prose or markdown fences.  Returns the parsed value, or undefined if no
 * valid JSON object can be found.
 *
 * Extraction order:
 *   1. Direct parse (clean output from a well-behaved agent)
 *   2. Strip ```json / ``` fences then parse
 *   3. Slice from the first '{' to the last '}' then parse
 */
export function extractJsonObject(raw: string): unknown {
  // 1. Try direct parse first.
  try {
    return JSON.parse(raw);
  } catch {
    // fall through
  }

  // 2. Strip optional markdown code fences.
  const fenceStripped = raw
    .replace(/^```(?:json)?\s*\n?/m, '')
    .replace(/\n?```\s*$/m, '')
    .trim();
  try {
    return JSON.parse(fenceStripped);
  } catch {
    // fall through
  }

  // 3. Extract the substring from the first '{' to the last '}'.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      // fall through
    }
  }

  return undefined;
}

/**
 * Builds the initial user message sent to the skill's isolated agent.
 * The agent is instructed to produce a JSON object matching the output schema.
 */
export function buildSkillPrompt(
  name: string,
  args: Record<string, unknown>,
  outputSchema: JSONSchema,
): string {
  return [
    `You have been invoked as the "${name}" skill.`,
    '',
    '## Input',
    '',
    JSON.stringify(args, null, 2),
    '',
    '## Output Format',
    '',
    'Respond with a JSON object matching this schema.',
    'Output ONLY the JSON object — no prose, no markdown fences.',
    '',
    JSON.stringify(outputSchema, null, 2),
  ].join('\n');
}

export function createSkillRunTool(
  builtinSkills: Skill[],
  projectSkillsDir: string,
  authConfig: AuthConfig,
  model: string,
  scriptPath: string,
  execPath: string,
  runner: SubagentRunner,
  inheritedRules: string,
  logger: Logger = createNoopLogger(),
): Tool<SkillRunInput, SkillRunOutput> {
  // Builtins are loaded once at startup and never change.
  const builtinMap = new Map<string, Skill>(builtinSkills.map((s) => [s.name, s]));

  return {
    name: 'skill_run',
    description:
      'Invoke a named skill with typed arguments. The skill runs as an isolated agent ' +
      'with its own system prompt and tool allowlist.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the skill to invoke (e.g. "write-blog-post").',
        },
        args: {
          type: 'object',
          description: 'Arguments for the skill, matching its input schema.',
        },
      },
      required: ['name', 'args'],
    },

    async execute(input: SkillRunInput, ctx: ToolContext): Promise<SkillRunOutput> {
      // Reload workspace skills on every call — the agent may have written new
      // .skill.md files into projectSkillsDir since startup. Workspace skills
      // shadow builtins on name collision.
      const workspaceSkills = await loadSkillsFromDir(projectSkillsDir, (msg) =>
        logger.warn(msg),
      );
      const skillMap = new Map<string, Skill>(builtinMap);
      for (const s of workspaceSkills) skillMap.set(s.name, s);

      const skill = skillMap.get(input.name);
      if (!skill) {
        throw new ToolError(`unknown skill: "${input.name}"`);
      }

      // Validate args against the skill's input schema.
      const inputError = validateRequiredFields(skill.inputSchema, input.args);
      if (inputError !== null) {
        throw new ToolError(`invalid args for skill "${input.name}": ${inputError}`);
      }

      const effectiveTools = resolveAllowedTools(ctx.allowedTools, skill.allowedTools);
      const prompt = buildSkillPrompt(input.name, input.args, skill.outputSchema);

      logger.debug('Skill dispatched', {
        skillName: input.name,
        argsPreview: JSON.stringify(input.args).slice(0, 300),
        allowedTools: effectiveTools,
        systemPromptPreview: skill.systemPrompt.slice(0, 200),
      });

      const payload: SubagentPayload = {
        prompt,
        authConfig,
        model,
        workspaceRoot: ctx.cwd,
        systemPrompt: skill.systemPrompt,
        ...(effectiveTools !== undefined ? { allowedTools: effectiveTools } : {}),
        ...(inheritedRules.length > 0 ? { inheritedRules } : {}),
      };

      ctx.progress.onSubagentStart(skill.name, skill.description);
      const startTime = Date.now();

      let subagentOutput: string;
      try {
        const result = await runner(payload, scriptPath, execPath, ctx.progress, skill.name);
        subagentOutput = result.output;
        const durationMs = Date.now() - startTime;
        ctx.progress.onSubagentEnd(skill.name, durationMs);
        logger.debug('Skill completed', {
          skillName: input.name,
          durationMs,
          outputPreview: subagentOutput.slice(0, 300),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.progress.onSubagentError(skill.name, message);
        logger.debug('Skill failed', {
          skillName: input.name,
          error: message.slice(0, 500),
        });
        throw new ToolError(`skill "${input.name}" failed: ${message}`, true);
      }

      // Parse the agent's response as JSON.  The agent may include prose or
      // markdown fences around the JSON object, so use the lenient extractor.
      const parsed = extractJsonObject(subagentOutput);
      if (parsed === undefined) {
        throw new ToolError(
          `skill "${input.name}" produced non-JSON output: ${subagentOutput.slice(0, 200)}`,
        );
      }

      // Validate against the output schema.
      const outputError = validateRequiredFields(skill.outputSchema, parsed);
      if (outputError !== null) {
        throw new ToolError(`skill "${input.name}" output is invalid: ${outputError}`);
      }

      return { result: parsed };
    },
  };
}
