// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { examplesMarkdown, createExamples, readDocument } from './index.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('all walkthroughs publish their complete tested helpers and honest result boundaries', async () => {
  const sources = {
    'control-session': await readDocument(ROOT, 'examples/control-session.ts'),
    'review-handoff': await readDocument(ROOT, 'examples/review-handoff.ts'),
    'revise-plan': await readDocument(ROOT, 'examples/revise-plan.ts'),
  };
  const examples = createExamples(sources);
  const markdown = examplesMarkdown(sources);
  expect(examples.map((example) => example.id)).toStrictEqual([
    'control-session',
    'review-handoff',
    'revise-plan',
  ]);
  for (const example of examples) {
    expect(example.source).toBe(sources[example.id]);
    expect(markdown).toContain(`\`\`\`ts\n${example.source}\`\`\``);
    if (example.call) expect(markdown).toContain(example.call);
  }
  expect(markdown).toContain('Read native turn completion and handle tool permissions separately.');
  expect(markdown).toContain('Feedback may still be queued or in flight.');
  expect(markdown).toContain('it does not submit an implementation task.');
  expect(markdown).toContain('Status markers alone never create verified completion.');
  expect(markdown).not.toContain('Read this page as Markdown');
  expect(() => createExamples({ ...sources, 'review-handoff': undefined })).toThrow(
    'The HQ website source is invalid',
  );
  expect(() => createExamples({ ...sources, 'revise-plan': '' })).toThrow(
    'The HQ website source is invalid',
  );
});

test('example loading allows exactly the three authoritative sources and rejects adjacent implementation files', async () => {
  for (const source of [
    'examples/control-session.ts',
    'examples/review-handoff.ts',
    'examples/revise-plan.ts',
  ])
    expect(await readDocument(ROOT, source)).toBe(
      await readFile(new URL(`../../../${source}`, import.meta.url), 'utf8'),
    );
  for (const source of [
    'src/index.ts',
    'examples/examples.test-integration.ts',
    'examples/../README.md',
    '/examples/control-session.ts',
    'examples/control-session.ts?raw',
  ])
    await expectToRejectCode(
      readDocument(ROOT, source),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
});
