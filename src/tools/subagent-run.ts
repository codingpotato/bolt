import type { Tool, ToolContext } from './tool';
import type { AuthConfig } from '../auth/auth';
import type { SubagentPayload, SubagentRunner } from '../subagent/subagent-runner';
import { extractPromptSections } from '../agent-prompt/agent-prompt';

export interface SubagentRunInput {
  prompt: string;
  allowedTools?: string[];
}

export interface SubagentRunOutput {
  output: string;
  error?: boolean;
}

/**
 * Resolves the effective allowedTools for the child:
 * - If both parent and input specify tools, take the intersection.
 * - If only one specifies, use that.
 * - If neither specifies, return undefined (all tools permitted).
 */
function resolveAllowedTools(
  parentAllowed: string[] | undefined,
  inputAllowed: string[] | undefined,
): string[] | undefined {
  if (parentAllowed !== undefined && inputAllowed !== undefined) {
    return inputAllowed.filter((t) => parentAllowed.includes(t));
  }
  return inputAllowed ?? parentAllowed;
}

export function createSubagentRunTool(
  authConfig: AuthConfig,
  model: string,
  scriptPath: string,
  execPath: string,
  runner: SubagentRunner,
  getSystemPrompt: () => string,
): Tool<SubagentRunInput, SubagentRunOutput> {
  return {
    name: 'subagent_run',
    description:
      'Delegate a task to an isolated child agent. The child has no access to the current ' +
      "message history, memory, or tasks. Returns the child agent's final text response.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Full task description and success criteria for the child agent.',
        },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of tool names the child may use. ' +
            "Intersected with the parent's own allowedTools.",
        },
      },
      required: ['prompt'],
    },

    async execute(input: SubagentRunInput, ctx: ToolContext): Promise<SubagentRunOutput> {
      const allowedTools = resolveAllowedTools(ctx.allowedTools, input.allowedTools);

      const parentSystemPrompt = getSystemPrompt();
      const inheritedSections = extractPromptSections(parentSystemPrompt, [
        'Safety Rules',
        'Communication Style',
        'Operating Modes',
      ]);
      const inheritedRules = Object.entries(inheritedSections)
        .map(([name, content]) => `## ${name}\n\n${content}`)
        .join('\n\n');

      const payload: SubagentPayload = {
        prompt: input.prompt,
        authConfig,
        model,
        ...(allowedTools !== undefined ? { allowedTools } : {}),
        ...(inheritedRules.length > 0 ? { inheritedRules } : {}),
      };

      try {
        const result = await runner(payload, scriptPath, execPath);
        return { output: result.output };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { output: `Sub-agent failed: ${message}`, error: true };
      }
    },
  };
}
