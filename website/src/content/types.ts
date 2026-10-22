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

// Complete example sources are separate from canonical rendered documentation.
export const EXAMPLE_SOURCE_RECORDS = [
  { id: 'control-session', source: 'examples/control-session.ts' },
  { id: 'review-handoff', source: 'examples/review-handoff.ts' },
  { id: 'revise-plan', source: 'examples/revise-plan.ts' },
] as const;
