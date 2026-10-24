import { Exception } from 'jg-exception';

import { EXAMPLE_DEFINITIONS, EXAMPLES_PAGE_LEDE } from './examples.ts';
import { EXAMPLE_SOURCE_RECORDS, type IExampleSources, type IWorkedExample } from './types.ts';

/**
 * Combines all three complete build-loaded helpers with their walkthroughs.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_SOURCE_INVALID: The HQ website source is invalid
 */
export const createExamples = (sources: IExampleSources): IWorkedExample[] =>
  EXAMPLE_DEFINITIONS.map((definition) => {
    const source = sources[definition.id];
    const record = EXAMPLE_SOURCE_RECORDS.find((entry) => entry.id === definition.id);
    if (!source || !record)
      throw new Exception('The HQ website source is invalid', {
        code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      });
    return { ...definition, sourcePath: record.source, source };
  });

/**
 * HTML and Markdown share the same narrative, host boundaries and complete tested helpers.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_SOURCE_INVALID: The HQ website source is invalid
 */
export const examplesMarkdown = (sources: IExampleSources): string =>
  [
    '# Worked examples',
    EXAMPLES_PAGE_LEDE,
    ...createExamples(sources).flatMap((example) => [
      `## ${example.title}`,
      example.goal,
      ...example.steps.map(
        (step) =>
          `### ${step.title}\n\n${step.commands.map((command) => `\`${command}\``).join(' · ')}\n\n${step.outcome}`,
      ),
      '### You need',
      example.prerequisites.map((text) => `- ${text}`).join('\n'),
      `\`\`\`sh\n${example.install}\n\`\`\``,
      example.setup,
      ...(example.call
        ? ['### Call the helper', `\`\`\`ts\n${example.call}\n\`\`\``]
        : [
            '### Your host supplies',
            ...example.hostFields.map((field) => `- \`${field.name}\`: ${field.text}`),
          ]),
      '### What you get back',
      `${example.resultLabel}: ${example.result}`,
      example.resultNote,
      ...(example.visual
        ? [
            example.visual.caption,
            ...example.visual.groups.map(
              (group) =>
                `- ${group.label}: ${group.items.map((item) => `${item.title} — ${item.detail}`).join('; ')}`,
            ),
          ]
        : []),
      ...example.returns.map((field) => `- \`${field.name}\`: ${field.text}`),
      '### Complete helper',
      `Source: ${example.sourcePath}. This is the same helper exercised by the public-client integration tests.`,
      `\`\`\`ts\n${example.source}\`\`\``,
    ]),
    '[API reference](/docs/api/) · [Getting started](/docs/)',
  ].join('\n\n') + '\n';
