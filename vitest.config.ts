import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 30000,
    // Every test boots a fresh PGlite and replays all migrations in
    // beforeEach; under CPU contention (parallel files, busy CI) a single
    // setup can take 15s+, so the hook budget is deliberately generous.
    hookTimeout: 60000,
    include: ['test/**/*.test.ts'],
  },
})
