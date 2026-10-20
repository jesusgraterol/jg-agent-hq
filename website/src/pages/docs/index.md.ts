import { getEntry } from 'astro:content';
import { Exception } from 'error-message-utils';

/**
 * Serves the same canonical document as the HTML page.
 * @returns The generated Markdown response.
 * @throws
 * - -1: The HQ website source is invalid
 */
export const GET = async (): Promise<Response> => {
  const document = await getEntry('documents', 'getting-started');
  if (!document?.body) throw new Exception('The HQ website source is invalid');
  return new Response(document.body, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
