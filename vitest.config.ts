import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // CI fails if any threshold is not met
      thresholds: {
        'src/tools/**': { lines: 90, functions: 90, branches: 90 },
        'src/memory/**': { lines: 85, functions: 85, branches: 85 },
        'src/tasks/**': { lines: 85, functions: 85, branches: 85 },
        'src/agent/**': { lines: 70, functions: 70, branches: 70 },
      },
    },
  },
});
