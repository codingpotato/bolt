import { join } from 'path';

/**
 * Built-in asset paths — resolved relative to this file using __dirname so that
 * the same code works in both dev (tsx running src/) and prod (node running dist/).
 *
 * Build step (scripts/copy-assets.js) copies src/AGENT.md, src/skills/, and
 * src/workflows/ to dist/ so these paths are always valid at runtime.
 */
export const BUILTIN_AGENT_MD = join(__dirname, 'AGENT.md');
export const BUILTIN_SKILLS_DIR = join(__dirname, 'skills');
export const BUILTIN_WORKFLOWS_DIR = join(__dirname, 'workflows');
