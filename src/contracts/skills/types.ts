import { z } from 'zod';

// identifiers bind selections to the provider's exact native name and source
export const SkillIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const NativeSkillInputSchema = z.object({
  name: z.string().min(1).max(256),
  path: z.string().min(1).max(4096).nullable(),
});
export type INativeSkillInput = z.infer<typeof NativeSkillInputSchema>;

// null metadata means the native interface did not supply it
export const SkillSchema = z.object({
  id: SkillIdSchema,
  name: z.string().min(1).max(256),
  description: z.string().max(8192),
  argumentHint: z.string().max(4096).nullable(),
  kind: z.enum(['skill', 'command', 'unavailable']),
  path: z.string().min(1).max(4096).nullable(),
  scope: z.string().max(128).nullable(),
  isEnabled: z.boolean(),
  requiresExplicitInvocation: z.boolean().nullable(),
  prerequisites: z
    .array(
      z.object({
        type: z.string().max(128),
        name: z.string().max(4096),
        description: z.string().max(4096).nullable(),
      }),
    )
    .max(128)
    .nullable(),
});
export type ISkill = z.infer<typeof SkillSchema>;

export const SkillPageSchema = z.object({
  state: z.enum(['available', 'partial', 'unavailable']),
  observedAt: z.number().int().nullable(),
  data: z.array(SkillSchema).max(128),
  unavailableCount: z.number().int().nonnegative(),
  nextCursor: z.string().max(16_384).nullable(),
});
export type ISkillPage = z.infer<typeof SkillPageSchema>;
export const SkillPreviewSchema = z.object({
  state: z.enum(['ready', 'missing', 'disabled', 'unavailable']),
  skill: SkillSchema.nullable(),
  text: z.string().max(65_536).nullable(),
});
export type ISkillPreview = z.infer<typeof SkillPreviewSchema>;

// explicit skill input is user intent; native agents retain workflow and permission ownership
export const MessageInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().min(1).max(65_536) }),
  z.strictObject({
    kind: z.literal('skill'),
    skillId: SkillIdSchema,
    arguments: z.string().max(16_384),
  }),
]);
export type IMessageInput = z.infer<typeof MessageInputSchema>;
