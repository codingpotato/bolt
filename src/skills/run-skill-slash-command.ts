import type { SlashCommand } from '../slash-commands/slash-commands';
import type { Skill } from './skill-loader';
import type { AuthConfig } from '../auth/auth';
import type { SubagentPayload, SubagentRunner } from '../subagent/subagent-runner';
import { buildSkillPrompt } from '../tools/skill-run';

export function createRunSkillSlashCommand(
  skills: Skill[],
  authConfig: AuthConfig,
  model: string,
  scriptPath: string,
  execPath: string,
  runner: SubagentRunner,
  workspaceRoot: string,
  inheritedRules: string,
): SlashCommand {
  const skillMap = new Map<string, Skill>(skills.map((s) => [s.name, s]));

  return {
    name: 'run-skill',
    description: 'Run a skill: /run-skill <name> [--<arg> <value> ...]',

    async execute(args, ctx) {
      const skillName = args[0];
      if (!skillName) {
        const names = [...skillMap.keys()].join(', ') || 'none';
        await ctx.send(
          `Usage: /run-skill <name> [--<arg> <value> ...]\n\nAvailable skills: ${names}`,
        );
        return {};
      }

      const skill = skillMap.get(skillName);
      if (!skill) {
        await ctx.send(`Unknown skill: "${skillName}". Use /skills to list available skills.`);
        return {};
      }

      // Parse --key value pairs from the remaining args.
      const skillArgs: Record<string, string> = {};
      const remaining = args.slice(1);
      for (let i = 0; i < remaining.length; i += 2) {
        const key = remaining[i] ?? '';
        const value = remaining[i + 1];
        if (!key.startsWith('--') || value === undefined) {
          await ctx.send(`Invalid argument: "${key}". Arguments must be in --key value format.`);
          return {};
        }
        skillArgs[key.slice(2)] = value;
      }

      // Validate required input fields.
      const required = (skill.inputSchema.required as string[] | undefined) ?? [];
      const missing = required.filter((f) => !(f in skillArgs));
      if (missing.length > 0) {
        await ctx.send(`Missing required arguments: ${missing.map((f) => `--${f}`).join(', ')}`);
        return {};
      }

      const prompt = buildSkillPrompt(skillName, skillArgs, skill.outputSchema);
      const payload: SubagentPayload = {
        prompt,
        authConfig,
        model,
        workspaceRoot,
        systemPrompt: skill.systemPrompt,
        ...(skill.allowedTools !== undefined ? { allowedTools: skill.allowedTools } : {}),
        ...(inheritedRules.length > 0 ? { inheritedRules } : {}),
      };

      try {
        const result = await runner(payload, scriptPath, execPath);
        await ctx.send(result.output);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.send(`Skill "${skillName}" failed: ${msg}`);
      }

      return {};
    },
  };
}
