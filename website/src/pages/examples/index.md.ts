import { getEntry } from 'astro:content';

import { examplesMarkdown } from '../../content/index.ts';

/** Serves the complete source-backed walkthrough as Markdown. */
export const GET = async (): Promise<Response> =>
  new Response(examplesMarkdown((await getEntry('examples', 'control-session'))?.body ?? ''), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
