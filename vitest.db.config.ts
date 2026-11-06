import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/*.db.spec.ts'],
    testTimeout: 15000,
    // Suites share one disposable schema; M02 temporarily installs a failure trigger.
    fileParallelism: false,
  },
});
