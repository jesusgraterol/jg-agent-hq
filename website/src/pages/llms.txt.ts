import { buildLlmsText } from 'jg-site';

import { PAGE_RECORDS, SITE_CONFIG } from '../site.config.ts';

/** Serves the bounded index of canonical HTML pages. */
export const GET = (): Response =>
  new Response(
    buildLlmsText({
      name: SITE_CONFIG.name,
      summary: 'Workspace primitives for native coding agents.',
      sections: [
        {
          heading: 'Documentation',
          links: PAGE_RECORDS.map((page) => ({
            title: page.title,
            description: page.description,
            url: new URL(page.path, SITE_CONFIG.url).href,
          })),
        },
      ],
    }),
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
