// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

import { SITE_CONFIG } from '../../src/site.config.ts';

import { readDestination, verifyDeployment, verifyPublicDestinations } from './index.ts';
import type { IDestinationFetch } from './index.ts';

test('uses bounded real HTTP reads and verifies exact release and deployment content', async () => {
  let mode:
    | 'valid'
    | 'wrong-version'
    | 'wrong-content'
    | 'wrong-mime'
    | 'soft-404'
    | 'oversized'
    | 'redirect' = 'valid';
  const server = createServer((request, response) => {
    const serve = async (): Promise<void> => {
      const target = new URL(decodeURIComponent((request.url ?? '/').slice(1)));
      if (mode === 'redirect') {
        response.writeHead(302, { Location: 'https://example.com' }).end();
        return;
      }
      if (mode === 'oversized') {
        response.end('x'.repeat(1048577));
        return;
      }
      if (target.hostname === 'registry.npmjs.org') {
        response.setHeader('Content-Type', 'application/json');
        response.end(
          JSON.stringify({
            name: 'jg-agent-hq',
            version: mode === 'wrong-version' ? '0.0.0' : SITE_CONFIG.version,
          }),
        );
        return;
      }
      if (target.hostname === 'www.npmjs.com') {
        response.writeHead(403).end('Browser authentication required');
        return;
      }
      if (target.origin !== SITE_CONFIG.url) {
        const title =
          target.hostname === 'github.com' ? 'jesusgraterol/jg-agent-hq' : target.hostname;
        response.end(
          mode === 'wrong-content'
            ? `Missing destination: ${title}`
            : `<html><head><title>${title}</title></head></html>`,
        );
        return;
      }
      const missing = target.pathname === '/hq-missing-page-check/';
      const relative = missing
        ? '404.html'
        : target.pathname.endsWith('/')
          ? `${target.pathname.slice(1)}index.html`
          : target.pathname.slice(1);
      if (missing && mode !== 'soft-404') response.statusCode = 404;
      response.setHeader(
        'Content-Type',
        target.pathname.endsWith('.png')
          ? 'image/png'
          : target.pathname.endsWith('.ico')
            ? 'image/x-icon'
            : target.pathname.endsWith('.md') && mode !== 'wrong-mime'
              ? 'text/markdown'
              : 'text/html',
      );
      response.end(
        await readFile(fileURLToPath(new URL(`../../dist/${relative}`, import.meta.url))),
      );
    };
    void serve().catch(() => {
      response.writeHead(500).end();
    });
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected the owned HTTP server');
    const fetcher: IDestinationFetch = (url, init) =>
      fetch(`http://127.0.0.1:${address.port}/${encodeURIComponent(url)}`, init);
    await verifyPublicDestinations(fetcher);
    await verifyDeployment(fetcher);
    mode = 'wrong-version';
    await expect(verifyPublicDestinations(fetcher)).rejects.toThrow(
      'The HQ website destination check failed',
    );
    mode = 'wrong-content';
    await expect(verifyPublicDestinations(fetcher)).rejects.toThrow(
      'The HQ website destination check failed',
    );
    mode = 'soft-404';
    await expect(verifyDeployment(fetcher)).rejects.toThrow(
      'The HQ website destination check failed',
    );
    mode = 'wrong-mime';
    await expect(verifyDeployment(fetcher)).rejects.toThrow(
      'The HQ website destination check failed',
    );
    mode = 'oversized';
    await expect(readDestination('https://example.com', 200, fetcher)).rejects.toThrow(
      'The HQ website destination check failed',
    );
    mode = 'redirect';
    await expect(readDestination('https://example.com', 200, fetcher)).rejects.toThrow(
      'The HQ website destination check failed',
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
