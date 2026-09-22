import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // main.ts runs only as a spawned process and index.ts only re-exports;
      // coverage cannot observe the first and has nothing to measure in the second.
      exclude: ['src/main.ts', 'src/index.ts'],
      reporter: ['text', 'lcov'],
      // A floor, not a target: it fails CI on a real regression, and leaves room
      // for the I/O failure paths that no portable test can provoke.
      thresholds: { statements: 95, branches: 88, functions: 95, lines: 95 },
    },
  },
})
