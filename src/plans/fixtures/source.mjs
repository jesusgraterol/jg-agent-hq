import { readFile } from 'node:fs/promises';
export const loadManifest = async (path) => {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.some((entry) => typeof entry !== 'string' || !entry.trim())
  ) {
    throw new Error('Invalid manifest');
  }
  return [...new Set(manifest.files)].sort();
};
export const createCatalogTable = (database) =>
  database.exec(
    'CREATE TABLE IF NOT EXISTS catalog_entry (path TEXT PRIMARY KEY, size INTEGER NOT NULL)',
  );
