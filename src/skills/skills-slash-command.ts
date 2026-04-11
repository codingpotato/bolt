import type { SlashCommand } from '../slash-commands/slash-commands';
import { loadSkillsFromDir } from './skill-loader';
import type { Skill } from './skill-loader';

/**
 * Creates the /skills slash command. Reloads workspace skills from
 * projectSkillsDir on each invocation so skills the agent created since
 * startup are visible. Workspace skills shadow builtins on name collision.
 */
export function createSkillsSlashCommand(
  builtinSkills: Skill[],
  projectSkillsDir: string,
): SlashCommand {
  return {
    name: 'skills',
    description: 'List all available skills.',
    async execute(_args, ctx) {
      const workspaceSkills = await loadSkillsFromDir(projectSkillsDir);
      const skillMap = new Map<string, Skill>(builtinSkills.map((s) => [s.name, s]));
      for (const s of workspaceSkills) skillMap.set(s.name, s);
      const skills = Array.from(skillMap.values());

      if (skills.length === 0) {
        await ctx.send('No skills found.');
        return {};
      }
      const lines = skills.map((s) => `  ${s.name.padEnd(30)} ${s.description}`);
      await ctx.send(`Skills:\n${lines.join('\n')}`);
      return {};
    },
  };
}
