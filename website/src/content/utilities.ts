import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Loader } from 'astro/loaders';
import { Exception, extractMessage } from 'jg-exception';

import { SITE_CONFIG } from '../site.config.ts';

import { DOCUMENT_RECORDS, EXAMPLE_SOURCE_RECORDS, type IMdastPlugin } from './types.ts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Resolves public documentation links without allowing active or local URL schemes.
 * @returns A canonical web URL or same-page fragment.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_SOURCE_INVALID: The HQ website source is invalid
 */
export const resolveDocumentLink = (href: string, source: string): string => {
  if (
    /[%\\]/u.test(href) ||
    [...href].some((character) => character.charCodeAt(0) <= 32) ||
    href.startsWith('//')
  )
    throw new Exception('The HQ website source is invalid', {
      code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
    });
  if (href.startsWith('#')) return href;
  if (/^https:\/\//u.test(href)) {
    const url = URL.parse(href);
    if (url && !url.username && !url.password) return url.href;
    throw new Exception('The HQ website source is invalid', {
      code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
    });
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(href) || href.startsWith('/'))
    throw new Exception('The HQ website source is invalid', {
      code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
    });
  const url = new URL(href, `https://source.invalid/${source}`);
  const path = url.pathname.slice(1);
  if (
    ![
      'README.md',
      'api/README.md',
      'errors/README.md',
      ...EXAMPLE_SOURCE_RECORDS.map((record) => record.source),
    ].includes(path) ||
    url.search
  )
    throw new Exception('The HQ website source is invalid', {
      code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
    });
  if (path === 'README.md') return `/docs/${url.hash}`;
  if (path === 'api/README.md') return `/docs/api/${url.hash}`;
  const example = EXAMPLE_SOURCE_RECORDS.find((record) => record.source === path);
  if (example) return `/examples/#${example.id}`;
  return `${SITE_CONFIG.repositoryUrl}/blob/main/${path}${url.hash}`;
};

// raw source HTML is unnecessary for the two canonical documents
export const canonicalMarkdownPlugin: IMdastPlugin = {
  name: 'hq-canonical-documents',
  html: () => {
    throw new Exception('The HQ website source is invalid', {
      code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
    });
  },
  link: (node, context) => {
    const source = context.fileURL
      ? relative(REPOSITORY_ROOT, fileURLToPath(context.fileURL)).split(sep).join('/')
      : 'README.md';
    context.setProperty(node, 'url', resolveDocumentLink(node.url, source));
  },
  definition: (node, context) => {
    const source = context.fileURL
      ? relative(REPOSITORY_ROOT, fileURLToPath(context.fileURL)).split(sep).join('/')
      : 'README.md';
    context.setProperty(node, 'url', resolveDocumentLink(node.url, source));
  },
  image: () => {
    throw new Exception('The HQ website source is invalid', {
      code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
    });
  },
};

/**
 * Reads one allowlisted canonical document or complete source example; the open handle bounds the read to 1 MiB.
 * @returns The exact UTF-8 source body.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_SOURCE_INVALID: The HQ website source is invalid
 */
export const readDocument = async (repositoryRoot: string, source: string): Promise<string> => {
  let handle;
  try {
    if (
      ![...DOCUMENT_RECORDS, ...EXAMPLE_SOURCE_RECORDS].some((record) => record.source === source)
    )
      throw new Exception('The HQ website source is invalid', {
        code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      });
    const root = await realpath(repositoryRoot);
    const path = resolve(root, source);
    if ((await realpath(path)) !== path)
      throw new Exception('The HQ website source is invalid', {
        code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      });
    if (!(await lstat(path)).isFile())
      throw new Exception('The HQ website source is invalid', {
        code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      });
    handle = await open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > 1048576)
      throw new Exception('The HQ website source is invalid', {
        code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      });
    const buffer = Buffer.alloc(1048577);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > 1048576)
      throw new Exception('The HQ website source is invalid', {
        code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      });
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch (error) {
    throw new Exception(`The HQ website source is invalid: ${extractMessage(error)}`, {
      code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
      cause: error,
    });
  } finally {
    await handle?.close();
  }
};

/**
 * Loads exactly the canonical README and API document, with one read and render each.
 * @returns Astro's native content loader.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_SOURCE_INVALID: The HQ website source is invalid
 */
export const canonicalDocuments = (): Loader => ({
  name: 'hq-canonical-documents',
  load: async (context) => {
    context.store.clear();
    for (const record of DOCUMENT_RECORDS) {
      const body = await readDocument(REPOSITORY_ROOT, record.source);
      const fileURL = pathToFileURL(resolve(REPOSITORY_ROOT, record.source));
      const rendered = await context.renderMarkdown(body, { fileURL });
      const data = await context.parseData({ id: record.id, data: { source: record.source } });
      context.store.set({
        id: record.id,
        body,
        data,
        digest: context.generateDigest(body),
        rendered,
        filePath: relative(
          dirname(fileURLToPath(new URL('../../', import.meta.url))),
          fileURLToPath(fileURL),
        ),
      });
    }
  },
});

/**
 * Loads only the three complete source examples during content sync, before Astro relocates server chunks.
 * @returns The native content loader, without rendering TypeScript as Markdown.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_SOURCE_INVALID: The HQ website source is invalid
 */
export const exampleSources = (): Loader => ({
  name: 'hq-example-sources',
  load: async (context) => {
    context.store.clear();
    for (const record of EXAMPLE_SOURCE_RECORDS) {
      const body = await readDocument(REPOSITORY_ROOT, record.source);
      const data = await context.parseData({ id: record.id, data: { source: record.source } });
      context.store.set({ id: record.id, body, data, digest: context.generateDigest(body) });
    }
  },
});
