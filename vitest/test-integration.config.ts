import { configDefaults, defineConfig } from 'vitest/config';

// built public exports, real processes and isolated package consumers
export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '**/_archive/**',
      '**/_archives/**',
      '**/_backup/**',
      '**/_backups/**',
    ],
    include: [
      'src/**/*.test-integration.ts',
      'scripts/**/*.test-integration.ts',
      'examples/**/*.test-integration.ts',
    ],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
