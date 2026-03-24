import { describe, it, expect } from 'vitest';
import { handleSkillsCli } from './skills-cli';
import type { Skill } from './skill-loader';

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'write-blog-post',
    description: 'Draft a long-form blog post',
    systemPrompt: 'You are a writer.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
    outputSchema: { type: 'object', properties: { post: { type: 'string' } }, required: ['post'] },
    ...overrides,
  };
}

describe('handleSkillsCli', () => {
  it('lists all skills with name and description', async () => {
    const skills = [
      makeSkill({ name: 'write-blog-post', description: 'Draft a blog post' }),
      makeSkill({ name: 'review-code', description: 'Review a code diff' }),
    ];
    const lines: string[] = [];
    await handleSkillsCli(['list'], skills, (s) => lines.push(s));
    expect(lines.some((l) => l.includes('write-blog-post'))).toBe(true);
    expect(lines.some((l) => l.includes('Draft a blog post'))).toBe(true);
    expect(lines.some((l) => l.includes('review-code'))).toBe(true);
    expect(lines.some((l) => l.includes('Review a code diff'))).toBe(true);
  });

  it('defaults to list when no subcommand given', async () => {
    const skills = [makeSkill()];
    const lines: string[] = [];
    await handleSkillsCli([], skills, (s) => lines.push(s));
    expect(lines.some((l) => l.includes('write-blog-post'))).toBe(true);
  });

  it('shows "No skills found" when list is empty', async () => {
    const lines: string[] = [];
    await handleSkillsCli(['list'], [], (s) => lines.push(s));
    expect(lines.some((l) => /no skills/i.test(l))).toBe(true);
  });

  it('shows usage for unknown subcommand', async () => {
    const lines: string[] = [];
    await handleSkillsCli(['unknown'], [], (s) => lines.push(s));
    expect(lines.some((l) => /usage/i.test(l))).toBe(true);
  });

  it('each skill line includes both name and description', async () => {
    const skills = [makeSkill({ name: 'my-skill', description: 'Does something useful' })];
    const lines: string[] = [];
    await handleSkillsCli(['list'], skills, (s) => lines.push(s));
    const skillLine = lines.find((l) => l.includes('my-skill'));
    expect(skillLine).toBeDefined();
    expect(skillLine).toContain('Does something useful');
  });
});
