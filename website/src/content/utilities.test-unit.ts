// @vitest-environment node
import { expectToRejectCode, expectToThrowCode } from 'jg-exception/testing';
import { createSatteriMarkdownProcessor } from '@astrojs/markdown-satteri';
import { describe, expect, test } from 'vitest';

import { canonicalMarkdownPlugin, resolveDocumentLink } from './index.ts';

describe('canonical source policy', () => {
  test.each([
    ['api/README.md#claude-history', 'README.md', '/docs/api/#claude-history'],
    ['../README.md', 'api/README.md', '/docs/'],
    ['#native-control', 'api/README.md', '#native-control'],
    [
      '../errors/README.md',
      'api/README.md',
      'https://github.com/jesusgraterol/jg-agent-hq/blob/main/errors/README.md',
    ],
    [
      '../docs/recovery.md#restore',
      'api/README.md',
      'https://github.com/jesusgraterol/jg-agent-hq/blob/main/docs/recovery.md#restore',
    ],
    ['https://example.com/reference', 'README.md', 'https://example.com/reference'],
  ])('resolveDocumentLink(%s, %s) -> %s', { tags: ['full'] }, (href, source, expected) => {
    expect(resolveDocumentLink(href, source)).toBe(expected);
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html,test',
    'file:///etc/passwd',
    '//example.com',
    '../private.md',
    'docs/private.md',
    'https://name:secret@example.com',
    'https://example.com/\n',
    '..\\README.md',
    '%2f%2fexample.com',
  ])('rejects unsafe URL %s', (href) => {
    expectToThrowCode(
      () => resolveDocumentLink(href, 'README.md'),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
  });

  test.each([
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '[active](javascript:alert)',
    '![remote](https://example.com/image.png)',
  ])('rejects unsafe Markdown %s through the real processor', async (source) => {
    const processor = await createSatteriMarkdownProcessor({
      mdastPlugins: [canonicalMarkdownPlugin],
    });
    await expectToRejectCode(
      processor.render(source),
      'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      'The HQ website source is invalid',
    );
  });

  test(
    'rewrites reference definitions but retains literal code examples',
    { tags: ['full'] },
    async () => {
      const processor = await createSatteriMarkdownProcessor({
        mdastPlugins: [canonicalMarkdownPlugin],
      });
      const result = await processor.render('[API][api]\n\n[api]: api/README.md\n\n`<directory>`');
      expect(result.code).toContain('href="/docs/api/"');
      expect(result.code).toContain('&lt;directory&gt;');
    },
  );
});
