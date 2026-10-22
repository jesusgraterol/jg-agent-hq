// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { examplesMarkdown, createControlExample, readDocument } from './index.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('the walkthrough publishes the complete tested helper verbatim with one caller and honest result boundaries', async () => {
  const source = await readFile(
    new URL('../../../examples/control-session.ts', import.meta.url),
    'utf8',
  );
  const example = createControlExample(source);
  expect(example.source).toBe(source);
  const markdown = examplesMarkdown(source);
  expect(markdown).toContain(`\`\`\`ts\n${source}\`\`\``);
  expect(markdown).toContain(example.call);
  expect(markdown).toContain('Read native turn completion and handle tool permissions separately.');
  expect(markdown).toContain('Caller action IDs retained before submission');
  expect(markdown).not.toContain('Read this page as Markdown');
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
