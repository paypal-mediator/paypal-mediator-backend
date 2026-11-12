import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'apps/api/test/unit/mediation*.spec.ts',
      'apps/api/test/integration/mediation.db.spec.ts',
    ],
    fileParallelism: false,
    testTimeout: 15000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/mediation',
      reporter: ['text', 'json-summary', 'html'],
      include: [
        'apps/api/src/modules/mediation/**/*.ts',
        'apps/api/src/modules/submissions/mediation-paypal.client.ts',
        'apps/api/src/modules/evidence/evidence-file-safety.ts',
        'packages/contracts/src/mediation.ts',
      ],
      thresholds: { lines: 90, statements: 85, branches: 80, functions: 90 },
    },
  },
});
