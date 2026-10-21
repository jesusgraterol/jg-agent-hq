import { getEntry } from 'astro:content';
import { Exception } from 'jg-exception';

/**
 * Serves the same canonical API reference as the HTML page.
 * @returns The generated Markdown response.
 * @throws
 * - JG_AGENT_HQ_WEBSITE_SOURCE_INVALID: The HQ website source is invalid
 */
export const GET = async (): Promise<Response> => {
  const document = await getEntry('documents', 'api');
  if (!document?.body)
    throw new Exception('The HQ website source is invalid', {
      code: 'JG_AGENT_HQ_WEBSITE_SOURCE_INVALID',
    });
  return new Response(document.body, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
