import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test-unit.ts'],
    exclude: ['**/_archive/**', '**/_archives/**', '**/_backup/**', '**/_backups/**'],
  },
});
