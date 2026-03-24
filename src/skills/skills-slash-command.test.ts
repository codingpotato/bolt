import { describe, it, expect, vi } from 'vitest';
import { createSkillsSlashCommand } from './skills-slash-command';
import type { Skill } from './skill-loader';
import type { SlashContext } from '../slash-commands/slash-commands';

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
    const cmd = createSkillsSlashCommand([]);
    expect(cmd.name).toBe('skills');
  });

  it('has a description', () => {
    const cmd = createSkillsSlashCommand([]);
    expect(cmd.description).toBeTruthy();
  });

  it('lists each skill name and description', async () => {
    const skills = [
      makeSkill({ name: 'write-blog-post', description: 'Draft a blog post' }),
      makeSkill({ name: 'review-code', description: 'Review a code diff' }),
    ];
    const ctx = makeCtx();
    await createSkillsSlashCommand(skills).execute([], ctx);

    const output = vi.mocked(ctx.send).mock.calls[0]?.[0] ?? '';
    expect(output).toContain('write-blog-post');
    expect(output).toContain('Draft a blog post');
    expect(output).toContain('review-code');
    expect(output).toContain('Review a code diff');
  });

  it('shows "No skills found" when the list is empty', async () => {
    const ctx = makeCtx();
    await createSkillsSlashCommand([]).execute([], ctx);

    const output = vi.mocked(ctx.send).mock.calls[0]?.[0] ?? '';
    expect(output).toMatch(/no skills/i);
  });

  it('returns an empty SlashResult (no exit)', async () => {
    const ctx = makeCtx();
    const result = await createSkillsSlashCommand([]).execute([], ctx);
    expect(result).toEqual({});
  });

  it('ignores args (behaves as list regardless)', async () => {
    const skills = [makeSkill()];
    const ctx = makeCtx();
    await createSkillsSlashCommand(skills).execute(['unknown-arg'], ctx);

    const output = vi.mocked(ctx.send).mock.calls[0]?.[0] ?? '';
    expect(output).toContain('write-blog-post');
  });
});
