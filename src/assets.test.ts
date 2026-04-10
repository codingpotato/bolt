import { describe, it, expect } from 'vitest';
import { basename, dirname, join } from 'path';
import { BUILTIN_AGENT_MD, BUILTIN_SKILLS_DIR, BUILTIN_WORKFLOWS_DIR } from './assets';

const RESOURCES_DIR = join(process.cwd(), 'resources');

describe('built-in asset paths', () => {
  it('BUILTIN_AGENT_MD is named AGENT.md and lives in the resources directory', () => {
    expect(basename(BUILTIN_AGENT_MD)).toBe('AGENT.md');
    expect(dirname(BUILTIN_AGENT_MD)).toBe(RESOURCES_DIR);
  });

  it('BUILTIN_SKILLS_DIR is named skills and lives in the resources directory', () => {
    expect(basename(BUILTIN_SKILLS_DIR)).toBe('skills');
    expect(dirname(BUILTIN_SKILLS_DIR)).toBe(RESOURCES_DIR);
  });

  it('BUILTIN_WORKFLOWS_DIR is named workflows and lives in the resources directory', () => {
    expect(basename(BUILTIN_WORKFLOWS_DIR)).toBe('workflows');
    expect(dirname(BUILTIN_WORKFLOWS_DIR)).toBe(RESOURCES_DIR);
  });
});
