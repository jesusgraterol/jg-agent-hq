import { configDefaults, defineConfig } from 'vitest/config';

// focused application decisions without filesystem state
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
    include: ['src/**/*.test-unit.ts'],
  },
});
