import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Exception, extractMessage } from 'jg-exception';
import { z } from 'zod';

import { PAGE_RECORDS, SITE_CONFIG } from '../../src/site.config.ts';

import type { IDestinationFetch, IDestinationResponse } from './types.ts';

const PackageVersion = z.object({
  name: z.literal('jg-agent-hq'),
  version: z.literal(SITE_CONFIG.version),
});

/**
 * Reads one expected destination with a deadline, bounded body and no silent redirects.
 * @returns Its decoded text and media type after the HTTP status is verified.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED: The HQ website destination check failed
 */
export const readDestination = async (
  url: string,
  status: number,
  fetcher: IDestinationFetch = fetch,
): Promise<IDestinationResponse> => {
  let response: Response | undefined;
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
      headers: { Accept: 'text/html, application/json, text/plain;q=0.8' },
    });
    if (response.status !== status || !response.body) {
      await response.body?.cancel();
      throw new Exception(`${url} answered ${response.status} instead of ${status}`, {
        code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED',
      });
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1048576)
          throw new Exception(`${url} answered more than 1 MiB`, {
            code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED',
          });
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return {
      body: new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      contentType: response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '',
    };
  } catch (cause) {
    throw new Exception(`The HQ website destination check failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED',
      cause,
    });
  }
};

/**
 * Requires the exact npm release and recognizable public project destinations.
 * @returns Completion after all external destinations pass.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED: The HQ website destination check failed
 */
export const verifyPublicDestinations = async (
  fetcher: IDestinationFetch = fetch,
): Promise<void> => {
  const body = await readDestination(
    `https://registry.npmjs.org/jg-agent-hq/${SITE_CONFIG.version}`,
    200,
    fetcher,
  );
  let packageData: unknown;
  try {
    packageData = JSON.parse(body.body);
  } catch (cause) {
    throw new Exception('The HQ website destination check failed', {
      code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED',
      cause,
    });
  }
  if (!PackageVersion.safeParse(packageData).success)
    throw new Exception('The HQ website destination check failed', {
      code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED',
    });
  for (const [url, expected] of [
    [SITE_CONFIG.repositoryUrl, 'jesusgraterol/jg-agent-hq'],
    [SITE_CONFIG.skillsUrl, 'jg-skills'],
    [SITE_CONFIG.packagesUrl, 'jg-packages'],
  ] as const) {
    const html = await readDestination(url, 200, fetcher);
    const title = /<title\b[^>]*>([^<]+)<\/title>/iu.exec(html.body)?.[1];
    if (!title?.includes(expected))
      throw new Exception(`The HQ website destination check failed: unexpected content at ${url}`, {
        code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED',
      });
  }
};

/**
 * Verifies the deployed pages, discovery, images and actual missing-page status.
 * @returns Completion after the fixed production origin passes.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED: The HQ website destination check failed
 */
export const verifyDeployment = async (fetcher: IDestinationFetch = fetch): Promise<void> => {
  for (const record of PAGE_RECORDS) {
    const htmlResponse = await readDestination(
      new URL(record.path, SITE_CONFIG.url).href,
      200,
      fetcher,
    );
    const html = htmlResponse.body;
    if (
      htmlResponse.contentType !== 'text/html' ||
      !html.includes(`<title>${record.title}</title>`) ||
      !html.includes(new URL(record.markdown, SITE_CONFIG.url).href) ||
      (!html.includes(`jg-agent-hq@${SITE_CONFIG.version}`) && record.id === 'home')
    )
      throw new Exception(
        `The HQ website destination check failed: unexpected page at ${record.path}`,
        {
          code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED',
        },
      );
    const markdownResponse = await readDestination(
      new URL(record.markdown, SITE_CONFIG.url).href,
      200,
      fetcher,
    );
    const markdown = markdownResponse.body;
    if (
      !['text/markdown', 'text/plain'].includes(markdownResponse.contentType) ||
      !markdown.startsWith('# ') ||
      markdown.includes('<!DOCTYPE') ||
      markdown.includes('<!doctype')
    )
      throw new Exception(
        `The HQ website destination check failed: unexpected Markdown at ${record.markdown}`,
        { code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED' },
      );
  }
  const missing = await readDestination(`${SITE_CONFIG.url}/hq-missing-page-check/`, 404, fetcher);
  if (
    !missing.body.includes('Page not found') ||
    !missing.body.includes('noindex') ||
    missing.body.includes('rel="canonical"')
  )
    throw new Exception('The HQ website destination check failed: unexpected missing page', {
      code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED',
    });
  for (const [path, marker] of [
    ['robots.txt', 'sitemap-index.xml'],
    ['sitemap-index.xml', 'sitemap-0.xml'],
    ['sitemap-0.xml', `${SITE_CONFIG.url}/docs/api/`],
    ['llms.txt', `${SITE_CONFIG.url}/docs/`],
  ] as const) {
    if (!(await readDestination(`${SITE_CONFIG.url}/${path}`, 200, fetcher)).body.includes(marker))
      throw new Exception(`The HQ website destination check failed: ${path} lacks ${marker}`, {
        code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED',
      });
  }
  for (const path of ['/og/jg-agent-hq.png', '/favicons/192x192.png', '/favicon.ico']) {
    let response: Response;
    try {
      response = await fetcher(`${SITE_CONFIG.url}${path}`, {
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
        method: 'HEAD',
      });
    } catch (cause) {
      throw new Exception(`The HQ website destination check failed: ${extractMessage(cause)}`, {
        code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED',
        cause,
      });
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (
      response.status !== 200 ||
      !contentType.startsWith(path.endsWith('.png') ? 'image/png' : 'image/')
    )
      throw new Exception(
        `The HQ website destination check failed: ${path} answered ${response.status} ${contentType}`,
        { code: 'JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED' },
      );
  }
};

/**
 * Verifies the deployment until one attempt passes or the attempts run out, because GitHub Pages
 * can keep serving part of the previous deployment for a short while after the new one reports
 * success. Each failed attempt waits before the next; the last attempt's failure is thrown.
 * @param options How many attempts to make and how long to wait between them.
 * @returns Completion once an attempt passes.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_DESTINATION_FAILED: The HQ website destination check failed
 */
export const verifyDeploymentWhenLive = async (
  { attempts, delayMs }: { attempts: number; delayMs: number },
  fetcher: IDestinationFetch = fetch,
): Promise<void> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await verifyDeployment(fetcher);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await setTimeout(delayMs);
    }
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await verifyPublicDestinations();
