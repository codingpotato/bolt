import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillFile, loadSkills, type Skill } from './skill-loader';
import { createSkillRunTool } from '../tools/skill-run';
import type { AuthConfig } from '../auth/auth';
import { createNoopLogger } from '../logger';
import { NoopProgressReporter } from '../progress';
import type { ToolContext } from '../tools/tool';

const SKILLS_DIR = join(__dirname);
const AUTH: AuthConfig = { mode: 'api-key', credential: 'test-key' };
const MODEL = 'claude-opus-4-6';
const SCRIPT = '/path/to/subagent.js';

function loadSkill(filename: string): Skill {
  const raw = readFileSync(join(SKILLS_DIR, filename), 'utf-8');
  const skill = parseSkillFile(filename, raw);
  if (!skill) throw new Error(`Failed to parse ${filename}`);
  return skill;
}

function makeCtx(): ToolContext {
  return {
    cwd: '/workspace',
    log: { log: vi.fn().mockResolvedValue(undefined) },
    logger: createNoopLogger(),
    progress: new NoopProgressReporter(),
  };
}

// ---------------------------------------------------------------------------
// Discoverability — loadSkills finds all built-in skills from SKILLS_DIR
// ---------------------------------------------------------------------------

describe('built-in skills discoverability', () => {
  const EXPECTED_NAMES = [
    'analyze-trends',
    'write-blog-post',
    'draft-social-post',
    'generate-video-script',
    'generate-image-prompt',
    'generate-video-prompt',
    'summarize-url',
    'review-code',
    'fix-tests',
  ];

  it('loadSkills finds all 9 built-in skills when passed SKILLS_DIR as builtinSkillsDir', async () => {
    const skills = await loadSkills('', '', () => {}, SKILLS_DIR);
    const names = skills.map((s) => s.name);
    for (const expected of EXPECTED_NAMES) {
      expect(names).toContain(expected);
    }
  });

  it('all built-in skills have non-empty system prompts', async () => {
    const skills = await loadSkills('', '', () => {}, SKILLS_DIR);
    for (const skill of skills.filter((s) => EXPECTED_NAMES.includes(s.name))) {
      expect(skill.systemPrompt.length, `${skill.name} has empty system prompt`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// write-blog-post
// ---------------------------------------------------------------------------

describe('write-blog-post skill', () => {
  const skill = loadSkill('write-blog-post.skill.md');

  it('has correct name', () => {
    expect(skill.name).toBe('write-blog-post');
  });

  it('requires topic input', () => {
    expect(skill.inputSchema.required).toContain('topic');
  });

  it('tone and targetAudience are optional', () => {
    expect(skill.inputSchema.required).not.toContain('tone');
    expect(skill.inputSchema.required).not.toContain('targetAudience');
  });

  it('requires post in output', () => {
    expect(skill.outputSchema.required).toContain('post');
  });

  it('allows web_fetch and web_search', () => {
    expect(skill.allowedTools).toContain('web_fetch');
    expect(skill.allowedTools).toContain('web_search');
  });

  it('has a non-empty system prompt', () => {
    expect(skill.systemPrompt.length).toBeGreaterThan(0);
  });

  it('invokes sub-agent with correct payload via skill_run', async () => {
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify({ post: '# Hello\n\nContent.' }) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);

    await tool.execute({ name: 'write-blog-post', args: { topic: 'TypeScript' } }, makeCtx());

    expect(runner).toHaveBeenCalledOnce();
    const [payload] = runner.mock.calls[0] as [import('../subagent/subagent-runner').SubagentPayload];
    expect(payload.systemPrompt).toBe(skill.systemPrompt);
    expect(payload.prompt).toContain('write-blog-post');
    expect(payload.prompt).toContain('TypeScript');
    expect(payload.allowedTools).toEqual(['web_fetch', 'web_search']);
  });

  it('returns the parsed post from sub-agent output', async () => {
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify({ post: '# My Post' }) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute({ name: 'write-blog-post', args: { topic: 'AI' } }, makeCtx());
    expect((result.result as { post: string }).post).toBe('# My Post');
  });
});

// ---------------------------------------------------------------------------
// draft-social-post
// ---------------------------------------------------------------------------

describe('draft-social-post skill', () => {
  const skill = loadSkill('draft-social-post.skill.md');

  it('has correct name', () => {
    expect(skill.name).toBe('draft-social-post');
  });

  it('requires topic and platform inputs', () => {
    expect(skill.inputSchema.required).toContain('topic');
    expect(skill.inputSchema.required).toContain('platform');
  });

  it('tone is optional', () => {
    expect(skill.inputSchema.required).not.toContain('tone');
  });

  it('platform enum includes expected values', () => {
    const platformProp = skill.inputSchema.properties?.['platform'];
    expect(platformProp?.enum).toEqual(
      expect.arrayContaining(['twitter', 'linkedin', 'xiaohongshu', 'instagram']),
    );
  });

  it('requires post in output', () => {
    expect(skill.outputSchema.required).toContain('post');
  });

  it('has no allowedTools (no tools needed)', () => {
    expect(skill.allowedTools).toBeUndefined();
  });

  it('invokes sub-agent and returns post', async () => {
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify({ post: 'Check this out! 🚀' }) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'draft-social-post', args: { topic: 'AI trends', platform: 'twitter' } },
      makeCtx(),
    );
    expect((result.result as { post: string }).post).toBe('Check this out! 🚀');
  });
});

// ---------------------------------------------------------------------------
// generate-video-script
// ---------------------------------------------------------------------------

describe('generate-video-script skill', () => {
  const skill = loadSkill('generate-video-script.skill.md');

  it('has correct name', () => {
    expect(skill.name).toBe('generate-video-script');
  });

  it('requires topic input', () => {
    expect(skill.inputSchema.required).toContain('topic');
  });

  it('durationSeconds and style are optional', () => {
    expect(skill.inputSchema.required).not.toContain('durationSeconds');
    expect(skill.inputSchema.required).not.toContain('style');
  });

  it('requires title, summary, and scenes in output', () => {
    expect(skill.outputSchema.required).toContain('title');
    expect(skill.outputSchema.required).toContain('summary');
    expect(skill.outputSchema.required).toContain('scenes');
  });

  it('allows web_fetch and web_search', () => {
    expect(skill.allowedTools).toContain('web_fetch');
    expect(skill.allowedTools).toContain('web_search');
  });

  it('invokes sub-agent and returns storyboard', async () => {
    const storyboard = {
      title: 'The Future of AI',
      summary: 'A short video about AI trends.',
      scenes: [
        {
          description: 'Opening shot of city skyline',
          dialogue: 'AI is changing everything.',
          camera: 'wide shot',
          duration: 5,
          imagePromptHint: 'futuristic city skyline at dusk',
          transitionTo: 'fade',
        },
      ],
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(storyboard) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'generate-video-script', args: { topic: 'AI trends' } },
      makeCtx(),
    );
    const r = result.result as typeof storyboard;
    expect(r.title).toBe('The Future of AI');
    expect(r.scenes).toHaveLength(1);
    expect(r.scenes[0]?.camera).toBe('wide shot');
  });
});

// ---------------------------------------------------------------------------
// generate-image-prompt
// ---------------------------------------------------------------------------

describe('generate-image-prompt skill', () => {
  const skill = loadSkill('generate-image-prompt.skill.md');

  it('has correct name', () => {
    expect(skill.name).toBe('generate-image-prompt');
  });

  it('requires sceneDescription input', () => {
    expect(skill.inputSchema.required).toContain('sceneDescription');
  });

  it('targetModel is optional', () => {
    expect(skill.inputSchema.required).not.toContain('targetModel');
  });

  it('targetModel enum includes sdxl, flux, dalle', () => {
    const prop = skill.inputSchema.properties?.['targetModel'];
    expect(prop?.enum).toEqual(expect.arrayContaining(['sdxl', 'flux', 'dalle']));
  });

  it('requires prompt in output', () => {
    expect(skill.outputSchema.required).toContain('prompt');
  });

  it('has no allowedTools', () => {
    expect(skill.allowedTools).toBeUndefined();
  });

  it('invokes sub-agent and returns image prompt', async () => {
    const runner = vi.fn().mockResolvedValue({
      output: JSON.stringify({ prompt: 'A dramatic sunset over mountains, cinematic lighting' }),
    });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'generate-image-prompt', args: { sceneDescription: 'sunset over mountains' } },
      makeCtx(),
    );
    expect((result.result as { prompt: string }).prompt).toContain('sunset');
  });
});

// ---------------------------------------------------------------------------
// generate-video-prompt
// ---------------------------------------------------------------------------

describe('generate-video-prompt skill', () => {
  const skill = loadSkill('generate-video-prompt.skill.md');

  it('has correct name', () => {
    expect(skill.name).toBe('generate-video-prompt');
  });

  it('requires sceneDescription input', () => {
    expect(skill.inputSchema.required).toContain('sceneDescription');
  });

  it('motionStyle is optional', () => {
    expect(skill.inputSchema.required).not.toContain('motionStyle');
  });

  it('motionStyle enum includes expected values', () => {
    const prop = skill.inputSchema.properties?.['motionStyle'];
    expect(prop?.enum).toEqual(
      expect.arrayContaining(['cinematic', 'dynamic', 'subtle', 'timelapse']),
    );
  });

  it('requires prompt in output', () => {
    expect(skill.outputSchema.required).toContain('prompt');
  });

  it('has no allowedTools', () => {
    expect(skill.allowedTools).toBeUndefined();
  });

  it('invokes sub-agent and returns video prompt', async () => {
    const runner = vi.fn().mockResolvedValue({
      output: JSON.stringify({ prompt: 'Slow dolly forward, camera moves toward the subject' }),
    });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'generate-video-prompt', args: { sceneDescription: 'person walking in forest' } },
      makeCtx(),
    );
    expect((result.result as { prompt: string }).prompt).toContain('dolly');
  });
});

// ---------------------------------------------------------------------------
// summarize-url
// ---------------------------------------------------------------------------

describe('summarize-url skill', () => {
  const skill = loadSkill('summarize-url.skill.md');

  it('has correct name', () => {
    expect(skill.name).toBe('summarize-url');
  });

  it('requires url input', () => {
    expect(skill.inputSchema.required).toContain('url');
  });

  it('requires title, summary, keyPoints, contentType in output', () => {
    expect(skill.outputSchema.required).toContain('title');
    expect(skill.outputSchema.required).toContain('summary');
    expect(skill.outputSchema.required).toContain('keyPoints');
    expect(skill.outputSchema.required).toContain('contentType');
  });

  it('allows only web_fetch', () => {
    expect(skill.allowedTools).toEqual(['web_fetch']);
  });

  it('invokes sub-agent and returns structured summary', async () => {
    const summary = {
      title: 'Introduction to TypeScript',
      summary: 'A guide to TypeScript basics.',
      keyPoints: ['Static typing', 'Interfaces', 'Generics'],
      contentType: 'article',
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(summary) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'summarize-url', args: { url: 'https://example.com/typescript' } },
      makeCtx(),
    );
    const r = result.result as typeof summary;
    expect(r.title).toBe('Introduction to TypeScript');
    expect(r.keyPoints).toHaveLength(3);
    expect(r.contentType).toBe('article');
  });
});

// ---------------------------------------------------------------------------
// review-code
// ---------------------------------------------------------------------------

describe('review-code skill', () => {
  const skill = loadSkill('review-code.skill.md');

  it('has correct name', () => {
    expect(skill.name).toBe('review-code');
  });

  it('diff and path are both optional inputs', () => {
    const required = skill.inputSchema.required ?? [];
    expect(required).not.toContain('diff');
    expect(required).not.toContain('path');
  });

  it('requires summary, issues, and approved in output', () => {
    expect(skill.outputSchema.required).toContain('summary');
    expect(skill.outputSchema.required).toContain('issues');
    expect(skill.outputSchema.required).toContain('approved');
  });

  it('allows only file_read', () => {
    expect(skill.allowedTools).toEqual(['file_read']);
  });

  it('invokes sub-agent with diff and returns review result', async () => {
    const review = {
      summary: 'Minor issues found.',
      issues: [{ severity: 'warning', file: 'src/foo.ts', line: 10, message: 'Unused variable' }],
      approved: true,
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(review) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'review-code', args: { diff: '--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n+const x = 1;' } },
      makeCtx(),
    );
    const r = result.result as typeof review;
    expect(r.approved).toBe(true);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.severity).toBe('warning');
  });

  it('returns approved false when error-severity issues are present', async () => {
    const review = {
      summary: 'SQL injection vulnerability found.',
      issues: [{ severity: 'error', file: 'src/db.ts', line: 42, message: 'SQL injection risk' }],
      approved: false,
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(review) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'review-code', args: { path: 'src/db.ts' } },
      makeCtx(),
    );
    expect((result.result as typeof review).approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// analyze-trends
// ---------------------------------------------------------------------------

describe('analyze-trends skill', () => {
  const skill = loadSkill('analyze-trends.skill.md');

  it('has correct name', () => {
    expect(skill.name).toBe('analyze-trends');
  });

  it('topic, platforms, and timeRange are all optional inputs', () => {
    const required = skill.inputSchema.required ?? [];
    expect(required).not.toContain('topic');
    expect(required).not.toContain('platforms');
    expect(required).not.toContain('timeRange');
  });

  it('timeRange enum includes expected values', () => {
    const prop = skill.inputSchema.properties?.['timeRange'];
    expect(prop?.enum).toEqual(expect.arrayContaining(['day', 'week', 'month']));
  });

  it('requires trends, recommendedAngles, and topPosts in output', () => {
    expect(skill.outputSchema.required).toContain('trends');
    expect(skill.outputSchema.required).toContain('recommendedAngles');
    expect(skill.outputSchema.required).toContain('topPosts');
  });

  it('allows web_search and web_fetch', () => {
    expect(skill.allowedTools).toContain('web_search');
    expect(skill.allowedTools).toContain('web_fetch');
  });

  it('has a non-empty system prompt', () => {
    expect(skill.systemPrompt.length).toBeGreaterThan(0);
  });

  it('invokes sub-agent with correct payload via skill_run', async () => {
    const report = {
      trends: [
        {
          title: 'AI agents are replacing junior devs',
          platform: 'twitter',
          contentAngle: 'Fear vs opportunity framing',
        },
      ],
      recommendedAngles: ['Share a personal story about AI in your workflow'],
      topPosts: [{ title: 'Thread: I replaced my intern with GPT-4', url: 'https://example.com/1' }],
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(report) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);

    await tool.execute({ name: 'analyze-trends', args: { topic: 'AI coding tools' } }, makeCtx());

    expect(runner).toHaveBeenCalledOnce();
    const [payload] = runner.mock.calls[0] as [import('../subagent/subagent-runner').SubagentPayload];
    expect(payload.systemPrompt).toBe(skill.systemPrompt);
    expect(payload.prompt).toContain('analyze-trends');
    expect(payload.prompt).toContain('AI coding tools');
    expect(payload.allowedTools).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
  });

  it('returns structured trend report from sub-agent output', async () => {
    const report = {
      trends: [
        {
          title: 'Short-form video is dominating',
          platform: 'tiktok',
          engagementMetrics: { views: '2M', likes: '150K' },
          contentAngle: 'How-to tutorials outperform vlogs',
        },
      ],
      recommendedAngles: ['Make a 30-second tip video', 'Use trending audio'],
      topPosts: [
        { title: 'My 30-day TikTok experiment', url: 'https://example.com/tiktok', platform: 'tiktok' },
      ],
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(report) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'analyze-trends', args: { platforms: ['tiktok', 'instagram'], timeRange: 'week' } },
      makeCtx(),
    );
    const r = result.result as typeof report;
    expect(r.trends).toHaveLength(1);
    expect(r.trends[0]?.platform).toBe('tiktok');
    expect(r.trends[0]?.contentAngle).toBeTruthy();
    expect(r.recommendedAngles).toHaveLength(2);
    expect(r.topPosts).toHaveLength(1);
  });

  it('works with no input args (fully optional)', async () => {
    const report = {
      trends: [],
      recommendedAngles: ['General trending content is hard to pin down right now'],
      topPosts: [],
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(report) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute({ name: 'analyze-trends', args: {} }, makeCtx());
    expect(result.result).toBeDefined();
  });
});
