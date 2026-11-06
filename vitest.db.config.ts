import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['apps/**/*.db.spec.ts'], testTimeout: 15000 },
});
