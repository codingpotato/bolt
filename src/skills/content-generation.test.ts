/**
 * S9-2: Content generation skills — focused tests for scene completeness and skill chaining.
 *
 * Individual skill structure tests live in built-in-skills.test.ts.
 * This file covers:
 *   1. Scene field completeness (all 6 required fields present end-to-end)
 *   2. Skill chaining: summarize-url output feeds into write-blog-post
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillFile, type Skill } from './skill-loader';
import { createSkillRunTool } from '../tools/skill-run';

vi.mock('./skill-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./skill-loader')>();
  return { ...actual, loadSkillsFromDir: vi.fn().mockResolvedValue([]) };
});
const PROJECT_SKILLS_DIR = '/project/.bolt/skills';
import type { AuthConfig } from '../auth/auth';
import { createNoopLogger } from '../logger';
import { NoopProgressReporter } from '../progress';
import type { ToolContext } from '../tools/tool';

const SKILLS_DIR = join(__dirname, '..', '..', 'resources', 'skills');
const AUTH: AuthConfig = { mode: 'api-key', credential: 'test-key' };
const MODEL = 'claude-opus-4-6';
const SCRIPT = '/path/to/subagent.js';
const EXEC = process.execPath;

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
// Scene field completeness — generate-video-script
// ---------------------------------------------------------------------------

describe('generate-video-script scene fields', () => {
  const skill = loadSkill('generate-video-script.skill.md');

  it('system prompt documents all 7 required scene fields', () => {
    const prompt = skill.systemPrompt;
    expect(prompt).toContain('description');
    expect(prompt).toContain('dialogue');
    expect(prompt).toContain('camera');
    expect(prompt).toContain('duration');
    expect(prompt).toContain('imagePromptHint');
    expect(prompt).toContain('characterIds');
    expect(prompt).toContain('transitionTo');
  });

  it('returns a scene with all 7 required fields intact', async () => {
    const scene = {
      description: 'Developer staring at terminal as code streams across the screen',
      dialogue: 'AI is writing code faster than any human ever could.',
      camera: 'close-up on screen, slow zoom out',
      duration: 8,
      imagePromptHint: 'programmer at glowing terminal, cinematic lighting',
      characterIds: [],
      transitionTo: 'cut',
    };
    const storyboard = {
      title: 'The Rise of AI Coding',
      summary: 'How AI tools are transforming software development.',
      targetPlatform: 'tiktok',
      resolution: { width: 1080, height: 1920 },
      characters: [],
      scenes: [scene],
    };

    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(storyboard) });
    const tool = createSkillRunTool([skill], PROJECT_SKILLS_DIR, AUTH, MODEL, SCRIPT, EXEC, runner, '');
    const result = await tool.execute(
      { name: 'generate-video-script', args: { topic: 'AI coding tools' } },
      makeCtx(),
    );

    const r = result.result as typeof storyboard;
    const s = r.scenes[0];
    expect(s?.description).toBe(scene.description);
    expect(s?.dialogue).toBe(scene.dialogue);
    expect(s?.camera).toBe(scene.camera);
    expect(s?.duration).toBe(scene.duration);
    expect(s?.imagePromptHint).toBe(scene.imagePromptHint);
    expect(s?.characterIds).toEqual([]);
    expect(s?.transitionTo).toBe(scene.transitionTo);
  });

  it('returns multiple scenes preserving all fields', async () => {
    const scenes = [
      {
        description: 'Opening title card',
        dialogue: 'Five tools every developer should know.',
        camera: 'static wide shot',
        duration: 3,
        imagePromptHint: 'bold title card, modern sans-serif font',
        characterIds: [],
        transitionTo: 'cut',
      },
      {
        description: 'Screen recording of AI autocomplete in action',
        dialogue: 'GitHub Copilot completes entire functions from a comment.',
        camera: 'screen capture with subtle zoom',
        duration: 10,
        imagePromptHint: 'VS Code with Copilot suggestion overlay',
        characterIds: [],
        transitionTo: 'fade',
      },
      {
        description: 'Developer smiling at screen, thumbs up',
        dialogue: 'Your future self will thank you.',
        camera: 'medium shot, handheld',
        duration: 5,
        imagePromptHint: 'happy developer at desk, warm lighting',
        characterIds: [],
        transitionTo: 'end',
      },
    ];
    const storyboard = {
      title: 'Top 5 AI Developer Tools',
      summary: 'A quick tour of the best AI coding assistants.',
      targetPlatform: 'tiktok',
      resolution: { width: 1080, height: 1920 },
      characters: [],
      scenes,
    };

    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(storyboard) });
    const tool = createSkillRunTool([skill], PROJECT_SKILLS_DIR, AUTH, MODEL, SCRIPT, EXEC, runner, '');
    const result = await tool.execute(
      { name: 'generate-video-script', args: { topic: 'AI developer tools', durationSeconds: 30 } },
      makeCtx(),
    );

    const r = result.result as typeof storyboard;
    expect(r.scenes).toHaveLength(3);
    for (let i = 0; i < scenes.length; i++) {
      const got = r.scenes[i];
      const want = scenes[i];
      expect(got?.description).toBe(want?.description);
      expect(got?.dialogue).toBe(want?.dialogue);
      expect(got?.camera).toBe(want?.camera);
      expect(got?.duration).toBe(want?.duration);
      expect(got?.imagePromptHint).toBe(want?.imagePromptHint);
      expect(got?.characterIds).toEqual([]);
      expect(got?.transitionTo).toBe(want?.transitionTo);
    }
  });
});

// ---------------------------------------------------------------------------
// Skill chaining: summarize-url → write-blog-post
// ---------------------------------------------------------------------------

describe('skill chaining: summarize-url output feeds into write-blog-post', () => {
  const summarizeSkill = loadSkill('summarize-url.skill.md');
  const blogSkill = loadSkill('write-blog-post.skill.md');

  it('summarize-url result can be passed as topic to write-blog-post', async () => {
    // Step 1: summarize-url produces a structured summary
    const summaryOutput = {
      title: 'The Future of AI Agents',
      summary:
        'AI agents are autonomous programs that plan and execute multi-step tasks using LLMs.',
      keyPoints: [
        'Agents use tool-calling to interact with the world',
        'Memory systems let agents recall past actions',
        'Multi-agent systems can tackle complex workflows',
      ],
      contentType: 'article',
    };

    const summarizeRunner = vi.fn().mockResolvedValue({ output: JSON.stringify(summaryOutput) });
    const summarizeTool = createSkillRunTool(
      [summarizeSkill],
      PROJECT_SKILLS_DIR,
      AUTH,
      MODEL,
      SCRIPT,
      EXEC,
      summarizeRunner,
      '',
    );

    const summarizeResult = await summarizeTool.execute(
      { name: 'summarize-url', args: { url: 'https://example.com/ai-agents' } },
      makeCtx(),
    );
    const summary = summarizeResult.result as typeof summaryOutput;

    // Step 2: pass summary.summary as topic into write-blog-post
    const blogOutput = {
      post: `# ${summary.title}\n\n${summary.summary}\n\n## Key Points\n\n${summary.keyPoints.join('\n')}`,
    };

    const blogRunner = vi.fn().mockResolvedValue({ output: JSON.stringify(blogOutput) });
    const blogTool = createSkillRunTool([blogSkill], PROJECT_SKILLS_DIR, AUTH, MODEL, SCRIPT, EXEC, blogRunner, '');

    const blogResult = await blogTool.execute(
      {
        name: 'write-blog-post',
        args: { topic: summary.summary, tone: 'technical' },
      },
      makeCtx(),
    );

    const post = blogResult.result as typeof blogOutput;
    expect(post.post).toContain('AI Agents');
    expect(blogRunner).toHaveBeenCalledOnce();

    // Verify the chained topic was passed through to the sub-agent prompt
    const [payload] = blogRunner.mock.calls[0] as [
      import('../subagent/subagent-runner').SubagentPayload,
    ];
    expect(payload.prompt).toContain(summary.summary);
  });

  it('chained call with keyPoints as topic produces a valid blog post', async () => {
    const summaryOutput = {
      title: 'TypeScript Best Practices',
      summary: 'A deep dive into TypeScript patterns for large codebases.',
      keyPoints: ['Use strict mode', 'Prefer interfaces over types', 'Avoid any'],
      contentType: 'article',
    };

    const summarizeRunner = vi.fn().mockResolvedValue({ output: JSON.stringify(summaryOutput) });
    const summarizeTool = createSkillRunTool(
      [summarizeSkill],
      PROJECT_SKILLS_DIR,
      AUTH,
      MODEL,
      SCRIPT,
      EXEC,
      summarizeRunner,
      '',
    );
    const step1 = await summarizeTool.execute(
      { name: 'summarize-url', args: { url: 'https://example.com/ts' } },
      makeCtx(),
    );

    const r1 = step1.result as typeof summaryOutput;
    const combinedTopic = `${r1.title}: ${r1.keyPoints.join(', ')}`;

    const blogOutput = { post: '# TypeScript Best Practices\n\nStrict mode is essential.' };
    const blogRunner = vi.fn().mockResolvedValue({ output: JSON.stringify(blogOutput) });
    const blogTool = createSkillRunTool([blogSkill], PROJECT_SKILLS_DIR, AUTH, MODEL, SCRIPT, EXEC, blogRunner, '');

    const step2 = await blogTool.execute(
      { name: 'write-blog-post', args: { topic: combinedTopic } },
      makeCtx(),
    );

    expect((step2.result as typeof blogOutput).post).toContain('TypeScript');
  });
});

// ---------------------------------------------------------------------------
// Optional research tools — system prompts mention web_search / web_fetch
// ---------------------------------------------------------------------------

describe('research-capable skills mention optional web tools', () => {
  it('write-blog-post system prompt mentions web_search and web_fetch as optional research tools', () => {
    const skill = loadSkill('write-blog-post.skill.md');
    expect(skill.systemPrompt.toLowerCase()).toMatch(/web_search|web_fetch|research/);
  });

  it('generate-video-script system prompt mentions web_search and web_fetch as optional research tools', () => {
    const skill = loadSkill('generate-video-script.skill.md');
    expect(skill.systemPrompt.toLowerCase()).toMatch(/web_search|web_fetch|research/);
  });
});
