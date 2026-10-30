import { configDefaults, defineConfig } from 'vitest/config';

// built public exports, real processes and isolated package consumers
export default defineConfig({
  test: {
    tags: [{ name: 'full', description: 'Secondary native-history presentation coverage.' }],
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
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: 2,
  },
});
