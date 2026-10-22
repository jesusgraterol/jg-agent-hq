import { homeMarkdown } from '../content/index.ts';

/** Serves the homepage's static Markdown counterpart. */
export const GET = (): Response =>
  new Response(homeMarkdown(), { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } });
