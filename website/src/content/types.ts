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
] as const;

export type IExampleId = (typeof EXAMPLE_SOURCE_RECORDS)[number]['id'];

export interface IExampleDefinition {
  id: IExampleId;
  number: string;
  category: string;
  title: string;
  goal: string;
  install: string;
  prerequisites: readonly string[];
  // each step names the commands it sends and what the host sees afterwards
  steps: readonly { title: string; commands: readonly string[]; outcome: string }[];
  setup: string;
  call: string;
  result: string;
  resultLabel: string;
  resultNote: string;
  returns: readonly { name: string; text: string }[];
}

export type IExampleSources = Record<IExampleId, string | undefined>;
export interface IWorkedExample extends IExampleDefinition {
  sourcePath: (typeof EXAMPLE_SOURCE_RECORDS)[number]['source'];
  source: string;
}
