import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    benchmark: { include: ['test/**/*.bench.ts'] },
    testTimeout: 60000,
  },
});
