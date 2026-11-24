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
      // .env.local points FILES_ROOT at a server path that does not exist locally.
      // Keep test uploads inside the project so image routes can write files.
      FILES_ROOT: './uploads',
    },
    include: ['test/**/*.test.ts'],
  },
});
