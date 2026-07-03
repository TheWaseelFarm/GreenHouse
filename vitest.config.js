import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['_lib/**/*.js', 'api/**/*.js'],
      reporter: ['text', 'html'],
    },
  },
});
