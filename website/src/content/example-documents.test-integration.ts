// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expectToRejectCode } from 'jg-exception/testing';
import { expect, test } from 'vitest';

import { examplesMarkdown, createExamples, readDocument } from './index.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test(
  'the walkthrough publishes its complete tested helper and honest result boundary',
  { tags: ['full'] },
  async () => {
    const sources = {
      'control-session': await readDocument(ROOT, 'examples/control-session.ts'),
    };
    const examples = createExamples(sources);
    const markdown = examplesMarkdown(sources);
    expect(examples.map((example) => example.id)).toStrictEqual(['control-session']);
    for (const example of examples) {
      expect(example.source).toBe(sources[example.id]);
      expect(markdown).toContain(`\`\`\`ts\n${example.source}\`\`\``);
      expect(markdown).toContain(example.call);
    }
    expect(markdown).toContain(
      'Acknowledged means delivered. Turn completion and tool permissions are reported separately.',
    );
    expect(markdown).toContain('### Read\n\n`live-items` · `approvals` · `usage`');
    expect(markdown).not.toContain('Read this page as Markdown');
    expect(() => createExamples({ 'control-session': undefined })).toThrow(
      'The HQ website source is invalid',
    );
    expect(() => createExamples({ 'control-session': '' })).toThrow(
      'The HQ website source is invalid',
    );
  },
);

test('example loading allows exactly the authoritative source and rejects adjacent implementation files', async () => {
  expect(await readDocument(ROOT, 'examples/control-session.ts')).toBe(
    await readFile(new URL('../../../examples/control-session.ts', import.meta.url), 'utf8'),
  );
  for (const source of [
    'src/index.ts',
    'examples/examples.test-integration.ts',
    'examples/shared-storage.ts',
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
