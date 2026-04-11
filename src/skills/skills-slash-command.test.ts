import { describe, it, expect, vi } from 'vitest';
import { createSkillsSlashCommand } from './skills-slash-command';
import type { Skill } from './skill-loader';
import type { SlashContext } from '../slash-commands/slash-commands';

vi.mock('./skill-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skill-loader')>();
  return { ...actual, loadSkillsFromDir: vi.fn().mockResolvedValue([]) };
});

const PROJECT_SKILLS_DIR = '/project/.bolt/skills';

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

function makeCtx(): SlashContext {
  return { send: vi.fn().mockResolvedValue(undefined), sessionId: 'session-1' };
}

describe('createSkillsSlashCommand', () => {
  it('has name "skills"', () => {
    const cmd = createSkillsSlashCommand([], PROJECT_SKILLS_DIR);
    expect(cmd.name).toBe('skills');
  });

  it('has a description', () => {
    const cmd = createSkillsSlashCommand([], PROJECT_SKILLS_DIR);
    expect(cmd.description).toBeTruthy();
  });

  it('lists each skill name and description', async () => {
    const skills = [
      makeSkill({ name: 'write-blog-post', description: 'Draft a blog post' }),
      makeSkill({ name: 'review-code', description: 'Review a code diff' }),
    ];
    const ctx = makeCtx();
    await createSkillsSlashCommand(skills, PROJECT_SKILLS_DIR).execute([], ctx);

    const output = vi.mocked(ctx.send).mock.calls[0]?.[0] ?? '';
    expect(output).toContain('write-blog-post');
    expect(output).toContain('Draft a blog post');
    expect(output).toContain('review-code');
    expect(output).toContain('Review a code diff');
  });

  it('shows "No skills found" when the list is empty', async () => {
    const ctx = makeCtx();
    await createSkillsSlashCommand([], PROJECT_SKILLS_DIR).execute([], ctx);

    const output = vi.mocked(ctx.send).mock.calls[0]?.[0] ?? '';
    expect(output).toMatch(/no skills/i);
  });

  it('returns an empty SlashResult (no exit)', async () => {
    const ctx = makeCtx();
    const result = await createSkillsSlashCommand([], PROJECT_SKILLS_DIR).execute([], ctx);
    expect(result).toEqual({});
  });

  it('ignores args (behaves as list regardless)', async () => {
    const skills = [makeSkill()];
    const ctx = makeCtx();
    await createSkillsSlashCommand(skills, PROJECT_SKILLS_DIR).execute(['unknown-arg'], ctx);

    const output = vi.mocked(ctx.send).mock.calls[0]?.[0] ?? '';
    expect(output).toContain('write-blog-post');
  });

  it('includes workspace skills loaded at call time', async () => {
    const { loadSkillsFromDir } = await import('./skill-loader');
    const wsSkill = makeSkill({ name: 'workspace-skill', description: 'Created by agent' });
    vi.mocked(loadSkillsFromDir).mockResolvedValueOnce([wsSkill]);
    const ctx = makeCtx();
    await createSkillsSlashCommand([], PROJECT_SKILLS_DIR).execute([], ctx);
    const output = vi.mocked(ctx.send).mock.calls[0]?.[0] ?? '';
    expect(output).toContain('workspace-skill');
    expect(output).toContain('Created by agent');
  });
});
