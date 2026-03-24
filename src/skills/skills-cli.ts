import type { Skill } from './skill-loader';

/**
 * Handles the `bolt skills [list]` CLI sub-command.
 */
export async function handleSkillsCli(
  args: string[],
  skills: Skill[],
  write: (line: string) => void,
): Promise<void> {
  const [subcommand] = args;

  if (subcommand === undefined || subcommand === 'list') {
    await cmdList(skills, write);
  } else {
    write('Usage: bolt skills [list]');
  }
}

async function cmdList(skills: Skill[], write: (line: string) => void): Promise<void> {
  if (skills.length === 0) {
    write('No skills found.');
    return;
  }
  for (const skill of skills) {
    write(`${skill.name.padEnd(30)} ${skill.description}`);
  }
}
