import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.{git,cache,output,temp}/**',
      '**/.claude/worktrees/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // CI fails if any threshold is not met.
      // Thresholds are set 3-5% below current actual coverage to catch regressions
      // without being brittle. Tiers: 90% (pure logic), 85% (stateful/coordinating),
      // 70% (integration boundary). src/cli is skipped — index.ts is an entry point
      // with 0% coverage by design. src/content is not yet implemented (Sprint 9).
      thresholds: {
        'src/ffmpeg/**': { lines: 90, functions: 90, branches: 90 },
        'src/tools/**': { lines: 90, functions: 90, branches: 90 },
        'src/memory/**': { lines: 85, functions: 85, branches: 85 },
        'src/tasks/**': { lines: 85, functions: 85, branches: 85 },
        'src/agent/**': { lines: 70, functions: 70, branches: 70 },
        'src/channels/**': { lines: 85, functions: 80, branches: 80 },
        'src/config/**': { lines: 90, functions: 90, branches: 90 },
        'src/logger/**': { lines: 90, functions: 90, branches: 90 },
        'src/progress/**': { lines: 85, functions: 80, branches: 80 },
        'src/search/**': { lines: 85, functions: 80, branches: 85 },
        'src/skills/**': { lines: 85, functions: 80, branches: 85 },
        'src/slash-commands/**': { lines: 85, functions: 85, branches: 85 },
        'src/subagent/**': { lines: 90, functions: 90, branches: 90 },
        'src/todo/**': { lines: 90, functions: 85, branches: 90 },
        'src/agent-prompt/**': { lines: 90, functions: 90, branches: 90 },
        'src/audit/**': { lines: 90, functions: 90, branches: 90 },
        'src/auth/**': { lines: 90, functions: 90, branches: 90 },
      },
    },
  },
});
