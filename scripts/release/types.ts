import { z } from 'zod';

// this package publishes stable semantic versions; registry responses tolerate additive fields
export const ReleaseVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
export const ReleaseManifestSchema = z.object({
  name: z.literal('jg-agent-hq'),
  version: ReleaseVersionSchema,
});
export const RegistryReleaseSchema = ReleaseManifestSchema.extend({
  dist: z.object({ integrity: z.string().min(1) }),
});

// only the external registry transport is replaced by release tests
export type IRegistryFetch = (url: string, init: RequestInit) => Promise<Response>;
