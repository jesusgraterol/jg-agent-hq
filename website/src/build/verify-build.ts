import { readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { Exception, extractMessage } from 'jg-exception';

import {
  DOCUMENT_RECORDS,
  readDocument,
  HOME_CONTENT,
  homeMarkdown,
  examplesMarkdown,
} from '../content/index.ts';
import { PAGE_RECORDS, SITE_CONFIG } from '../site.config.ts';

import type { IBuildVerification } from './types.ts';

const EXCLUDED = new Set(['_archive', '_archives', '_backup', '_backups']);

/**
 * Verifies static pages through Chromium's DOM without executing scripts or loading resources.
 * @returns The checked page and file counts after Chromium closes.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_BUILD_INVALID: The HQ website build is invalid
 */
export const verifyBuild = async (directory: string): Promise<IBuildVerification> => {
  const browser = await chromium.launch();
  let operation = 'artifact inventory';
  try {
    const root = await realpath(directory);
    const files = new Set<string>();
    const visit = async (folder: string): Promise<void> => {
      for (const entry of await readdir(resolve(root, folder), { withFileTypes: true })) {
        if (EXCLUDED.has(entry.name) || entry.isSymbolicLink())
          throw new Exception('The HQ website build is invalid', {
            code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
          });
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) files.add(path);
        else
          throw new Exception('The HQ website build is invalid', {
            code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
          });
      }
    };
    await visit('');
    for (const path of files)
      if (
        /(?:\.map$|\.test-(?:unit|integration|e2e|bench)\.|(?:^|\/)(?:node_modules|AGENTS\.md|CLAUDE\.md)(?:\/|$))/u.test(
          path,
        )
      )
        throw new Exception(`The HQ website build is invalid: ${path}`, {
          code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
        });
    const required = [
      '404.html',
      'robots.txt',
      'llms.txt',
      'sitemap-index.xml',
      'sitemap-0.xml',
      'favicon.ico',
      'favicons/32x32.png',
      'favicons/192x192.png',
      'og/jg-agent-hq.png',
    ];
    for (const path of required)
      if (!files.has(path))
        throw new Exception(`The HQ website build is invalid: missing ${path}`, {
          code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
        });
    for (const [path, width, height] of [
      ['og/jg-agent-hq.png', 1200, 630],
      ['favicons/32x32.png', 32, 32],
      ['favicons/192x192.png', 192, 192],
    ] as const) {
      const png = await readFile(resolve(root, path));
      if (
        png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        png.readUInt32BE(16) !== width ||
        png.readUInt32BE(20) !== height
      )
        throw new Exception('The HQ website build is invalid', {
          code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
        });
    }
    for (const path of files) {
      if (!/\.(?:html|md|js|css|json|txt|xml)$/u.test(path)) continue;
      operation = `output ${path}`;
      const text = await readFile(resolve(root, path), 'utf8');
      if (/(?:\/home\/|\/Users\/|[A-Z]:\\|sourceMappingURL=|__INSTALL_)/u.test(text))
        throw new Exception('The HQ website build is invalid', {
          code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
        });
    }
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route('**/*', (route) => route.abort());
    const page = await context.newPage();
    const anchors = new Map<string, Set<string>>();
    const references: { href: string; from: string }[] = [];
    const titles = new Set<string>();
    for (const record of [
      ...PAGE_RECORDS,
      {
        id: '404',
        path: '/404.html',
        markdown: '',
        title: 'Page not found | jg-agent-hq',
        description: '',
      },
    ]) {
      operation = `page ${record.path}`;
      const path = record.path.endsWith('/')
        ? `${record.path.slice(1)}index.html`
        : record.path.slice(1);
      const html = await readFile(resolve(root, path), 'utf8');
      if (
        /(?:\/home\/|\/Users\/|[A-Z]:\\|\.test-(?:unit|integration|e2e|bench)\.|__INSTALL_|sourceMappingURL=)/u.test(
          html,
        )
      )
        throw new Exception('The HQ website build is invalid', {
          code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
        });
      await page.setContent(html);
      const data = await page.evaluate(() => ({
        title: document.title,
        headings: [...document.querySelectorAll('main h1')].map((element) =>
          element.textContent?.trim(),
        ),
        description: document.querySelector('meta[name="description"]')?.getAttribute('content'),
        canonical: [...document.querySelectorAll('link[rel="canonical"]')].map((element) =>
          element.getAttribute('href'),
        ),
        robots: document.querySelector('meta[name="robots"]')?.getAttribute('content'),
        alternate: document
          .querySelector('link[rel="alternate"][type="text/markdown"]')
          ?.getAttribute('href'),
        ogUrl: document.querySelector('meta[property="og:url"]')?.getAttribute('content'),
        ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content'),
        ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content'),
        ids: [...document.querySelectorAll('[id]')].map((element) => element.id),
        references: [...document.querySelectorAll('[href],[src]')].flatMap((element) =>
          [element.getAttribute('href'), element.getAttribute('src')].filter(
            (href): href is string => href !== null,
          ),
        ),
        structuredData: [...document.querySelectorAll('script[type="application/ld+json"]')].map(
          (element) => element.textContent ?? '',
        ),
        text: document.querySelector('main')?.textContent ?? '',
      }));
      if (
        data.title !== record.title ||
        titles.has(data.title) ||
        data.headings.length !== 1 ||
        !data.headings[0] ||
        new Set(data.ids).size !== data.ids.length
      )
        throw new Exception('The HQ website build is invalid', {
          code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
        });
      titles.add(data.title);
      anchors.set(record.path, new Set(data.ids));
      references.push(...data.references.map((href) => ({ href, from: record.path })));
      if (record.id === '404') {
        if (
          !data.robots?.includes('noindex') ||
          data.canonical.length !== 0 ||
          data.structuredData.length !== 0
        )
          throw new Exception('The HQ website build is invalid', {
            code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
          });
      } else {
        const canonical = new URL(record.path, SITE_CONFIG.url).href;
        if (
          data.canonical.length !== 1 ||
          data.canonical[0] !== canonical ||
          data.ogUrl !== canonical ||
          data.ogTitle !== record.title ||
          data.description !== record.description ||
          data.alternate !== new URL(record.markdown, SITE_CONFIG.url).href ||
          data.ogImage !== `${SITE_CONFIG.url}/og/jg-agent-hq.png` ||
          !data.robots?.startsWith('index') ||
          data.structuredData.length !== 1
        )
          throw new Exception('The HQ website build is invalid', {
            code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
          });
        for (const json of data.structuredData) {
          const parsed: unknown = JSON.parse(json);
          if (!parsed || typeof parsed !== 'object' || !json.includes(canonical))
            throw new Exception('The HQ website build is invalid', {
              code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
            });
        }
        const markdown = await readFile(resolve(root, record.markdown.slice(1)), 'utf8');
        const source = DOCUMENT_RECORDS.find((item) => item.id === record.id);
        const expected = source
          ? await readDocument(fileURLToPath(new URL('../../../', import.meta.url)), source.source)
          : record.id === 'examples'
            ? examplesMarkdown({
                'control-session': await readDocument(
                  fileURLToPath(new URL('../../../', import.meta.url)),
                  'examples/control-session.ts',
                ),
                'review-handoff': await readDocument(
                  fileURLToPath(new URL('../../../', import.meta.url)),
                  'examples/review-handoff.ts',
                ),
                'revise-plan': await readDocument(
                  fileURLToPath(new URL('../../../', import.meta.url)),
                  'examples/revise-plan.ts',
                ),
              })
            : homeMarkdown();
        if (
          markdown !== expected ||
          data.text.includes('Read this page as Markdown') ||
          (record.id === 'home' &&
            (data.headings[0] !== HOME_CONTENT.title ||
              !data.text.includes(`npm install jg-agent-hq@${SITE_CONFIG.version}`)))
        )
          throw new Exception('The HQ website build is invalid', {
            code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
          });
        for (const heading of markdown.matchAll(/^#{1,6} (.+)$/gmu))
          if (!data.text.includes(heading[1]!.replace(/`/gu, '')))
            throw new Exception('The HQ website build is invalid', {
              code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
            });
      }
    }
    for (const { href, from } of references) {
      operation = `link ${href} from ${from}`;
      const url = new URL(href, new URL(from, SITE_CONFIG.url));
      if (!['https:', 'http:'].includes(url.protocol))
        throw new Exception('The HQ website build is invalid', {
          code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
        });
      if (url.origin !== SITE_CONFIG.url) continue;
      const relativePath = decodeURIComponent(url.pathname).slice(1);
      const local = resolve(
        root,
        relativePath.endsWith('/') || relativePath === ''
          ? `${relativePath}index.html`
          : relativePath,
      );
      const child = relative(root, local);
      if (
        isAbsolute(child) ||
        child === '..' ||
        child.startsWith(`..${sep}`) ||
        !files.has(child.split(sep).join('/'))
      )
        throw new Exception(`The HQ website build is invalid: unresolved ${href}`, {
          code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
        });
      if (url.hash && !anchors.get(url.pathname)?.has(decodeURIComponent(url.hash.slice(1))))
        throw new Exception(`The HQ website build is invalid: missing anchor ${href}`, {
          code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
        });
    }
    operation = 'public discovery';
    const sitemap = await readFile(resolve(root, 'sitemap-0.xml'), 'utf8');
    const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map((match) => match[1]);
    if (
      sitemapUrls.length !== PAGE_RECORDS.length ||
      PAGE_RECORDS.some(
        (record) => !sitemapUrls.includes(new URL(record.path, SITE_CONFIG.url).href),
      )
    )
      throw new Exception('The HQ website build is invalid', {
        code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
      });
    const index = await readFile(resolve(root, 'sitemap-index.xml'), 'utf8');
    const robots = await readFile(resolve(root, 'robots.txt'), 'utf8');
    const llms = await readFile(resolve(root, 'llms.txt'), 'utf8');
    if (
      !index.includes(`${SITE_CONFIG.url}/sitemap-0.xml`) ||
      !robots.includes(`Sitemap: ${SITE_CONFIG.url}/sitemap-index.xml`) ||
      llms.includes('/404') ||
      PAGE_RECORDS.some((record) => !llms.includes(new URL(record.path, SITE_CONFIG.url).href))
    )
      throw new Exception('The HQ website build is invalid', {
        code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
      });
    return { pages: PAGE_RECORDS.length + 1, files: files.size };
  } catch (cause) {
    throw new Exception(`The HQ website build is invalid: ${operation}: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_WEBSITE_BUILD_INVALID',
      cause,
    });
  } finally {
    await browser.close();
  }
};
