/**
 * S9-3: Code review skill — focused tests for issue field completeness,
 * all severity values, optional line field, and edge cases.
 *
 * Basic structure tests (name, schema, allowedTools, approved-on-error)
 * live in built-in-skills.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillFile, type Skill } from './skill-loader';
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

const skill = loadSkill('review-code.skill.md');

// ---------------------------------------------------------------------------
// Issue severity values
// ---------------------------------------------------------------------------

describe('review-code issue severity values', () => {
  it('handles suggestion severity and preserves approved: true', async () => {
    const review = {
      summary: 'Code is clean; one style suggestion.',
      issues: [
        {
          severity: 'suggestion',
          file: 'src/utils.ts',
          line: 5,
          message: 'Consider extracting this logic into a named function for readability.',
        },
      ],
      approved: true,
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(review) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'review-code', args: { diff: '+const x = a + b + c + d;' } },
      makeCtx(),
    );
    const r = result.result as typeof review;
    expect(r.issues[0]?.severity).toBe('suggestion');
    expect(r.approved).toBe(true);
  });

  it('handles mixed severities: suggestion + warning → approved true', async () => {
    const review = {
      summary: 'Minor issues found; no blocking errors.',
      issues: [
        { severity: 'warning', file: 'src/api.ts', line: 12, message: 'Potential null dereference.' },
        { severity: 'suggestion', file: 'src/api.ts', message: 'Rename variable for clarity.' },
      ],
      approved: true,
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(review) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'review-code', args: { diff: 'some diff' } },
      makeCtx(),
    );
    const r = result.result as typeof review;
    expect(r.issues).toHaveLength(2);
    expect(r.approved).toBe(true);
  });

  it('handles error + suggestion → approved false', async () => {
    const review = {
      summary: 'SQL injection vulnerability detected.',
      issues: [
        { severity: 'error', file: 'src/db.ts', line: 42, message: 'Unsanitised user input in query.' },
        { severity: 'suggestion', file: 'src/db.ts', message: 'Use parameterised queries.' },
      ],
      approved: false,
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(review) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'review-code', args: { path: 'src/db.ts' } },
      makeCtx(),
    );
    const r = result.result as typeof review;
    expect(r.approved).toBe(false);
    const severities = r.issues.map((i) => i.severity);
    expect(severities).toContain('error');
    expect(severities).toContain('suggestion');
  });
});

// ---------------------------------------------------------------------------
// Issue field completeness — line is optional
// ---------------------------------------------------------------------------

describe('review-code issue field completeness', () => {
  it('issue without line field passes through correctly', async () => {
    const review = {
      summary: 'One style issue, no line available.',
      issues: [
        {
          severity: 'suggestion',
          file: 'src/config.ts',
          // no line field
          message: 'Consider splitting this file into smaller modules.',
        },
      ],
      approved: true,
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(review) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'review-code', args: { diff: '+export const HUGE_CONFIG = {...}' } },
      makeCtx(),
    );
    const r = result.result as typeof review;
    const issue = r.issues[0];
    expect(issue?.severity).toBe('suggestion');
    expect(issue?.file).toBe('src/config.ts');
    expect(issue?.message).toContain('splitting');
    expect('line' in (issue ?? {})).toBe(false);
  });

  it('preserves all 4 issue fields when line is present', async () => {
    const issue = {
      severity: 'error' as const,
      file: 'src/auth.ts',
      line: 77,
      message: 'Password stored as plain text.',
    };
    const review = { summary: 'Critical security issue.', issues: [issue], approved: false };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(review) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'review-code', args: { path: 'src/auth.ts' } },
      makeCtx(),
    );
    const got = (result.result as typeof review).issues[0];
    expect(got?.severity).toBe(issue.severity);
    expect(got?.file).toBe(issue.file);
    expect(got?.line).toBe(issue.line);
    expect(got?.message).toBe(issue.message);
  });

  it('returns zero issues and approved true for clean code', async () => {
    const review = { summary: 'Code looks good. No issues found.', issues: [], approved: true };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(review) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'review-code', args: { diff: '+const x: number = 1;' } },
      makeCtx(),
    );
    const r = result.result as typeof review;
    expect(r.issues).toHaveLength(0);
    expect(r.approved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// No-code-provided case
// ---------------------------------------------------------------------------

describe('review-code with no code provided', () => {
  it('skill system prompt describes the no-code fallback behaviour', () => {
    expect(skill.systemPrompt).toContain('No code provided for review');
  });

  it('passes through a no-code-provided response correctly', async () => {
    const review = {
      summary: 'No code provided for review',
      issues: [],
      approved: false,
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(review) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      { name: 'review-code', args: {} },
      makeCtx(),
    );
    const r = result.result as typeof review;
    expect(r.summary).toBe('No code provided for review');
    expect(r.issues).toHaveLength(0);
    expect(r.approved).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// file_read used when path is provided
// ---------------------------------------------------------------------------

describe('review-code uses file_read for path input', () => {
  it('system prompt instructs agent to use file_read when path is given', () => {
    expect(skill.systemPrompt).toContain('file_read');
    expect(skill.systemPrompt).toContain('path');
  });

  it('sub-agent receives path in prompt when path arg is supplied', async () => {
    const review = { summary: 'Looks fine.', issues: [], approved: true };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(review) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    await tool.execute(
      { name: 'review-code', args: { path: 'src/agent/core.ts' } },
      makeCtx(),
    );
    const [payload] = runner.mock.calls[0] as [import('../subagent/subagent-runner').SubagentPayload];
    expect(payload.prompt).toContain('src/agent/core.ts');
    expect(payload.allowedTools).toEqual(['file_read']);
  });

  it('both path and diff can be provided together', async () => {
    const review = {
      summary: 'Reviewed diff in context of full file.',
      issues: [{ severity: 'warning', file: 'src/tool.ts', line: 3, message: 'Missing return type.' }],
      approved: true,
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(review) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner);
    const result = await tool.execute(
      {
        name: 'review-code',
        args: { path: 'src/tool.ts', diff: '+function foo() { return 1; }' },
      },
      makeCtx(),
    );
    const r = result.result as typeof review;
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.severity).toBe('warning');
  });
});
