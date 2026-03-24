#!/usr/bin/env node
/**
 * Copies non-TypeScript assets from src/ to dist/ after tsc compilation.
 * Currently handles: src/skills/*.skill.md → dist/skills/
 */

const { cpSync, mkdirSync, readdirSync } = require('fs');
const { join } = require('path');

const root = join(__dirname, '..');
const srcSkills = join(root, 'src', 'skills');
const distSkills = join(root, 'dist', 'skills');

mkdirSync(distSkills, { recursive: true });

for (const file of readdirSync(srcSkills)) {
  if (file.endsWith('.skill.md')) {
    cpSync(join(srcSkills, file), join(distSkills, file));
    process.stdout.write(`copied: dist/skills/${file}\n`);
  }
}
