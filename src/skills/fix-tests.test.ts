/**
 * S9-4: Automated test-and-fix workflow — focused tests for the fix-tests skill.
 *
 * Basic structure tests (name, schema, allowedTools) live in built-in-skills.test.ts.
 * This file covers:
 *   1. Pass-on-first-run (no fix needed)
 *   2. Failure → fix → pass (single retry)
 *   3. Exhausted retries (tests never pass)
 *   4. fixesApplied list correctness
 *   5. attempts counter correctness
 *   6. System prompt instructions (bash, file_read, file_edit, file_write, maxRetries)
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

const skill = loadSkill('fix-tests.skill.md');

// ---------------------------------------------------------------------------
// Pass on first run — no fix needed
// ---------------------------------------------------------------------------

describe('fix-tests: pass on first run', () => {
  it('returns passed: true, attempts: 1, empty fixesApplied', async () => {
    const result = {
      passed: true,
      attempts: 1,
      finalOutput: 'All 42 tests passed.',
      fixesApplied: [],
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(result) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner, "");
    const r = (
      await tool.execute({ name: 'fix-tests', args: { command: 'npm test', maxRetries: 3 } }, makeCtx())
    ).result as typeof result;
    expect(r.passed).toBe(true);
    expect(r.attempts).toBe(1);
    expect(r.fixesApplied).toHaveLength(0);
    expect(r.finalOutput).toContain('42 tests passed');
  });

  it('omitting command leaves it absent from serialised args (default is LLM-inferred)', async () => {
    const result = { passed: true, attempts: 1, finalOutput: 'ok', fixesApplied: [] };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(result) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner, "");
    await tool.execute({ name: 'fix-tests', args: { maxRetries: 3 } }, makeCtx());
    const [payload] = runner.mock.calls[0] as [import('../subagent/subagent-runner').SubagentPayload];
    // command has a YAML default but skill-loader never injects defaults into args;
    // the LLM must rely on the system prompt fallback ("run npm test if command absent")
    expect(payload.prompt).not.toContain('"command"');
  });

  it('system prompt specifies npm test as the fallback when command is absent', () => {
    expect(skill.systemPrompt).toContain('npm test');
  });
});

// ---------------------------------------------------------------------------
// Single fix cycle: failure → fix → pass
// ---------------------------------------------------------------------------

describe('fix-tests: fix on first retry', () => {
  it('returns passed: true, attempts: 2, one fix recorded', async () => {
    const result = {
      passed: true,
      attempts: 2,
      finalOutput: 'All 42 tests passed.',
      fixesApplied: ['Fixed off-by-one error in src/utils.ts line 17'],
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(result) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner, "");
    const r = (
      await tool.execute({ name: 'fix-tests', args: { command: 'npm test', maxRetries: 3 } }, makeCtx())
    ).result as typeof result;
    expect(r.passed).toBe(true);
    expect(r.attempts).toBe(2);
    expect(r.fixesApplied).toHaveLength(1);
    expect(r.fixesApplied[0]).toContain('off-by-one');
  });
});

// ---------------------------------------------------------------------------
// Retries exhausted — tests never pass
// ---------------------------------------------------------------------------

describe('fix-tests: retries exhausted', () => {
  it('returns passed: false after maxRetries cycles', async () => {
    const result = {
      passed: false,
      attempts: 4, // initial run + 3 fix attempts
      finalOutput: 'FAIL: src/parser.test.ts\n  Expected 42, got 43\n3 tests failed.',
      fixesApplied: [
        'Changed return value in parse() from n+1 to n',
        'Reverted accidental whitespace removal in token handler',
        'Fixed regex pattern for numeric literals',
      ],
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(result) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner, "");
    const r = (
      await tool.execute({ name: 'fix-tests', args: { command: 'npm test', maxRetries: 3 } }, makeCtx())
    ).result as typeof result;
    expect(r.passed).toBe(false);
    expect(r.attempts).toBe(4);
    expect(r.fixesApplied).toHaveLength(3);
    expect(r.finalOutput).toContain('3 tests failed');
  });

  it('respects a custom maxRetries value', async () => {
    const result = {
      passed: false,
      attempts: 2, // initial run + 1 fix attempt
      finalOutput: 'FAIL: 1 test failed.',
      fixesApplied: ['Attempted null-check in src/index.ts'],
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(result) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner, "");
    const r = (
      await tool.execute({ name: 'fix-tests', args: { command: 'npm test', maxRetries: 1 } }, makeCtx())
    ).result as typeof result;
    expect(r.passed).toBe(false);
    expect(r.attempts).toBe(2);
    expect(r.fixesApplied).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// fixesApplied list correctness
// ---------------------------------------------------------------------------

describe('fix-tests: fixesApplied list', () => {
  it('preserves all fix descriptions in order', async () => {
    const fixes = [
      'Added missing await in async handler',
      'Corrected expected value in assertion',
    ];
    const result = { passed: true, attempts: 3, finalOutput: 'All tests passed.', fixesApplied: fixes };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(result) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner, "");
    const r = (
      await tool.execute({ name: 'fix-tests', args: { command: 'npm test', maxRetries: 3 } }, makeCtx())
    ).result as typeof result;
    expect(r.fixesApplied).toEqual(fixes);
  });
});

// ---------------------------------------------------------------------------
// attempts counter
// ---------------------------------------------------------------------------

describe('fix-tests: attempts counter', () => {
  it('attempts equals 1 when passing on the first run', async () => {
    const result = { passed: true, attempts: 1, finalOutput: 'ok', fixesApplied: [] };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(result) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner, "");
    const r = (
      await tool.execute({ name: 'fix-tests', args: { maxRetries: 3 } }, makeCtx())
    ).result as typeof result;
    expect(r.attempts).toBe(1);
  });

  it('attempts equals maxRetries+1 when all retries are exhausted', async () => {
    const maxRetries = 5;
    const result = {
      passed: false,
      attempts: maxRetries + 1,
      finalOutput: 'still failing',
      fixesApplied: Array.from({ length: maxRetries }, (_, i) => `fix attempt ${i + 1}`),
    };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(result) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner, "");
    const r = (
      await tool.execute({ name: 'fix-tests', args: { command: 'npm test', maxRetries } }, makeCtx())
    ).result as typeof result;
    expect(r.attempts).toBe(maxRetries + 1);
    expect(r.fixesApplied).toHaveLength(maxRetries);
  });
});

// ---------------------------------------------------------------------------
// System prompt instructions
// ---------------------------------------------------------------------------

describe('fix-tests system prompt', () => {
  it('instructs agent to use bash to run tests', () => {
    expect(skill.systemPrompt).toContain('bash');
  });

  it('instructs agent to use file_read to inspect failing source files', () => {
    expect(skill.systemPrompt).toContain('file_read');
  });

  it('instructs agent to use file_edit for targeted fixes', () => {
    expect(skill.systemPrompt).toContain('file_edit');
  });

  it('instructs agent to use file_write for full rewrites', () => {
    expect(skill.systemPrompt).toContain('file_write');
  });

  it('instructs agent to respect maxRetries limit', () => {
    expect(skill.systemPrompt).toContain('maxRetries');
  });

  it('instructs agent not to exceed the retry limit', () => {
    // The prompt must describe stopping behaviour
    expect(skill.systemPrompt.toLowerCase()).toMatch(/exhaust|retry|retries/);
  });
});

// ---------------------------------------------------------------------------
// Sub-agent payload
// ---------------------------------------------------------------------------

describe('fix-tests sub-agent payload', () => {
  it('sends correct allowedTools to sub-agent', async () => {
    const result = { passed: true, attempts: 1, finalOutput: 'ok', fixesApplied: [] };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(result) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner, "");
    await tool.execute({ name: 'fix-tests', args: { command: 'npm test', maxRetries: 3 } }, makeCtx());
    const [payload] = runner.mock.calls[0] as [import('../subagent/subagent-runner').SubagentPayload];
    expect(payload.allowedTools).toEqual(expect.arrayContaining(['bash', 'file_read', 'file_edit', 'file_write']));
  });

  it('includes command and maxRetries in the prompt', async () => {
    const result = { passed: true, attempts: 1, finalOutput: 'ok', fixesApplied: [] };
    const runner = vi.fn().mockResolvedValue({ output: JSON.stringify(result) });
    const tool = createSkillRunTool([skill], AUTH, MODEL, SCRIPT, runner, "");
    await tool.execute(
      { name: 'fix-tests', args: { command: 'npx vitest run', maxRetries: 5 } },
      makeCtx(),
    );
    const [payload] = runner.mock.calls[0] as [import('../subagent/subagent-runner').SubagentPayload];
    expect(payload.prompt).toContain('npx vitest run');
    expect(payload.prompt).toContain('5');
  });
});
