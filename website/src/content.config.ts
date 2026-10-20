import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';

import { canonicalDocuments } from './content/index.ts';

const documents = defineCollection({
  loader: canonicalDocuments(),
  schema: z.strictObject({ source: z.enum(['README.md', 'api/README.md']) }),
});
export const collections = { documents };
