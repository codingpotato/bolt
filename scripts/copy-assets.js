#!/usr/bin/env node
/**
 * Copies non-TypeScript assets from src/ to dist/ after tsc compilation.
 *
 * Handles:
 *   src/skills/*.skill.md          → dist/skills/
 *   src/workflows/*.json            → dist/workflows/  (workflow files + .patchmap.json sidecars)
 *
 * At runtime, src/assets.ts exports BUILTIN_SKILLS_DIR and BUILTIN_WORKFLOWS_DIR
 * anchored to __dirname, so both dev (tsx → src/) and prod (node → dist/) resolve
 * to the correct location without any extra configuration.
 */

const { cpSync, mkdirSync, readdirSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');

// --- built-in AGENT.md ---
const srcAgent = join(root, 'resources', 'AGENT.md');
const distAgent = join(root, 'dist', 'AGENT.md');
cpSync(srcAgent, distAgent);
process.stdout.write('copied: dist/AGENT.md\n');

// --- skills ---
const srcSkills = join(root, 'resources', 'skills');
const distSkills = join(root, 'dist', 'skills');
mkdirSync(distSkills, { recursive: true });
for (const file of readdirSync(srcSkills)) {
  if (file.endsWith('.skill.md')) {
    cpSync(join(srcSkills, file), join(distSkills, file));
    process.stdout.write(`copied: dist/skills/${file}\n`);
  }
}

// --- workflow files and patchmaps ---
const srcWorkflows = join(root, 'resources', 'workflows');
const distWorkflows = join(root, 'dist', 'workflows');
mkdirSync(distWorkflows, { recursive: true });
for (const file of readdirSync(srcWorkflows)) {
  if (file.endsWith('.json')) {
    cpSync(join(srcWorkflows, file), join(distWorkflows, file));
    process.stdout.write(`copied: dist/workflows/${file}\n`);
  }
}
