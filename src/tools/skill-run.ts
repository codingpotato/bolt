import { ToolError } from './tool';
import type { Tool, ToolContext, JSONSchema } from './tool';
import type { Skill } from '../skills/skill-loader';
import type { AuthConfig } from '../auth/auth';
import type { SubagentPayload, SubagentResult } from '../subagent/subagent-runner';

export interface SkillRunInput {
  name: string;
  args: Record<string, unknown>;
}

export interface SkillRunOutput {
  result: unknown;
}

type Runner = (payload: SubagentPayload, scriptPath: string) => Promise<SubagentResult>;

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
  skills: Skill[],
  authConfig: AuthConfig,
  model: string,
  scriptPath: string,
  runner: Runner,
): Tool<SkillRunInput, SkillRunOutput> {
  const skillMap = new Map<string, Skill>(skills.map((s) => [s.name, s]));

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

      const payload: SubagentPayload = {
        prompt,
        authConfig,
        model,
        systemPrompt: skill.systemPrompt,
        ...(effectiveTools !== undefined ? { allowedTools: effectiveTools } : {}),
      };

      let subagentOutput: string;
      try {
        const result = await runner(payload, scriptPath);
        subagentOutput = result.output;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ToolError(`skill "${input.name}" failed: ${message}`, true);
      }

      // Parse the agent's response as JSON.
      let parsed: unknown;
      try {
        parsed = JSON.parse(subagentOutput);
      } catch {
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
