import type { SlashCommand } from '../slash-commands/slash-commands';
import type { Skill } from './skill-loader';

/**
 * Creates the /skills slash command, pre-loaded with the discovered skill list.
 */
export function createSkillsSlashCommand(skills: Skill[]): SlashCommand {
  return {
    name: 'skills',
    description: 'List all available skills.',
    async execute(_args, ctx) {
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
