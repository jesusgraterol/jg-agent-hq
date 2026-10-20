import { SITE_CONFIG } from '../site.config.ts';

/** Serves discovery rules for the fixed production origin. */
export const GET = (): Response =>
  new Response(`User-agent: *\nAllow: /\nSitemap: ${SITE_CONFIG.url}/sitemap-index.xml\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
