import { getEntry } from 'astro:content';

import { examplesMarkdown } from '../../content/index.ts';

/** Serves all three source-backed walkthroughs as Markdown. */
export const GET = async (): Promise<Response> =>
  new Response(
    examplesMarkdown({
      'control-session': (await getEntry('examples', 'control-session'))?.body,
      'review-handoff': (await getEntry('examples', 'review-handoff'))?.body,
      'revise-plan': (await getEntry('examples', 'revise-plan'))?.body,
    }),
    { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } },
  );
