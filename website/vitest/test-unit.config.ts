import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    tags: [
      {
        name: 'full',
        description: 'Additional website content, presentation, and asset coverage.',
      },
    ],
    include: ['src/**/*.test-unit.ts'],
    exclude: ['**/_archive/**', '**/_archives/**', '**/_backup/**', '**/_backups/**'],
  },
});
