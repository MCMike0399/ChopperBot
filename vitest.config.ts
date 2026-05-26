import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
    environment: 'node',
    testTimeout: 10_000,
  },
});
