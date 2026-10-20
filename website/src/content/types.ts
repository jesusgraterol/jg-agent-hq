import type { satteri } from '@astrojs/markdown-satteri';

// infer the native processor contract without importing its transitive parser package
export type IMdastPlugin = Extract<
  NonNullable<NonNullable<Parameters<typeof satteri>[0]>['mdastPlugins']>[number],
  { name: string }
>;

// the exact two source documents that may enter the public website
export const DOCUMENT_RECORDS = [
  { id: 'getting-started', source: 'README.md' },
  { id: 'api', source: 'api/README.md' },
] as const;
