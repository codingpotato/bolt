import { describe, it, expect } from 'vitest';
import { basename, dirname } from 'path';
import { BUILTIN_AGENT_MD, BUILTIN_SKILLS_DIR, BUILTIN_WORKFLOWS_DIR } from './assets';

describe('built-in asset paths', () => {
  it('BUILTIN_AGENT_MD is named AGENT.md and lives in the same directory as assets.ts', () => {
    expect(basename(BUILTIN_AGENT_MD)).toBe('AGENT.md');
    expect(dirname(BUILTIN_AGENT_MD)).toBe(__dirname);
  });

  it('BUILTIN_SKILLS_DIR is named skills and lives in the same directory as assets.ts', () => {
    expect(basename(BUILTIN_SKILLS_DIR)).toBe('skills');
    expect(dirname(BUILTIN_SKILLS_DIR)).toBe(__dirname);
  });

  it('BUILTIN_WORKFLOWS_DIR is named workflows and lives in the same directory as assets.ts', () => {
    expect(basename(BUILTIN_WORKFLOWS_DIR)).toBe('workflows');
    expect(dirname(BUILTIN_WORKFLOWS_DIR)).toBe(__dirname);
  });
});
