import { join } from 'path';

/**
 * Built-in asset paths — resolved relative to the project root so that
 * the same code works in both dev (tsx running src/) and prod (node running dist/).
 *
 * The resources/ folder contains AGENT.md, skills/, and workflows/ which are
 * copied to dist/ during build (scripts/copy-assets.js) for production.
 *
 * Uses process.cwd() because npm scripts always run from the project root.
 */
const PROJECT_ROOT = process.cwd();

export const BUILTIN_AGENT_MD = join(PROJECT_ROOT, 'resources', 'AGENT.md');
export const BUILTIN_SKILLS_DIR = join(PROJECT_ROOT, 'resources', 'skills');
export const BUILTIN_WORKFLOWS_DIR = join(PROJECT_ROOT, 'resources', 'workflows');
