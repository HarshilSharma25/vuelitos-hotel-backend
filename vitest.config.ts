import { defineConfig } from 'vitest/config';

export default defineConfig({
  css: { postcss: {} },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
    },
    include: ['test/**/*.test.ts'],
  },
});
