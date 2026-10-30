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
    include: ['src/**/*.test-integration.ts', 'scripts/**/*.test-integration.ts'],
    exclude: ['**/_archive/**', '**/_archives/**', '**/_backup/**', '**/_backups/**'],
    testTimeout: 60000,
  },
});
