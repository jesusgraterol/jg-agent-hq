import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';

import { canonicalDocuments, exampleSources, EXAMPLE_SOURCE_RECORDS } from './content/index.ts';

const documents = defineCollection({
  loader: canonicalDocuments(),
  schema: z.strictObject({ source: z.enum(['README.md', 'api/README.md']) }),
});
const examples = defineCollection({
  loader: exampleSources(),
  schema: z.strictObject({ source: z.enum(EXAMPLE_SOURCE_RECORDS.map((record) => record.source)) }),
});
export const collections = { documents, examples };
