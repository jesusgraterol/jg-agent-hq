import { z } from 'zod';

// permission-affecting native requests reject unknown fields rather than silently widening a grant
const PathSchema = z.string().min(1).max(4096);
const SpecialPathSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('root') }),
  z.strictObject({ kind: z.literal('minimal') }),
  z.strictObject({ kind: z.literal('project_roots'), subpath: PathSchema.nullable().optional() }),
  z.strictObject({ kind: z.literal('tmpdir') }),
  z.strictObject({ kind: z.literal('slash_tmp') }),
  z.strictObject({
    kind: z.literal('unknown'),
    path: PathSchema,
    subpath: PathSchema.nullable().optional(),
  }),
]);
const FilePathSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('path'), path: PathSchema }),
  z.strictObject({ type: z.literal('glob_pattern'), pattern: PathSchema }),
  z.strictObject({ type: z.literal('special'), value: SpecialPathSchema }),
]);
export const PermissionsSchema = z.strictObject({
  fileSystem: z
    .strictObject({
      entries: z
        .array(z.strictObject({ access: z.enum(['read', 'write', 'deny']), path: FilePathSchema }))
        .max(128)
        .nullable()
        .optional(),
      globScanMaxDepth: z.number().int().positive().nullable().optional(),
      read: z.array(PathSchema).max(128).nullable().optional(),
      write: z.array(PathSchema).max(128).nullable().optional(),
    })
    .nullable()
    .optional(),
  network: z.strictObject({ enabled: z.boolean().nullable().optional() }).nullable().optional(),
});
const PromptFields = {
  threadId: PathSchema,
  turnId: PathSchema,
  itemId: PathSchema,
  startedAtMs: z.number().int().safe(),
  reason: z.string().max(65_536).nullable().optional(),
};
export const CommandApprovalSchema = z.strictObject({
  ...PromptFields,
  approvalId: PathSchema.nullable().optional(),
  kind: z.enum(['command', 'writeStdin']).default('command'),
  command: z.string().max(65_536).nullable().optional(),
  cwd: PathSchema.nullable().optional(),
  environmentId: PathSchema.nullable().optional(),
  commandActions: z.array(z.unknown()).max(128).nullable().optional(),
  additionalPermissions: PermissionsSchema.nullable().optional(),
  availableDecisions: z.array(z.unknown()).max(32).nullable().optional(),
  proposedExecpolicyAmendment: z.array(z.string()).max(128).nullable().optional(),
  proposedNetworkPolicyAmendments: z.array(z.unknown()).max(128).nullable().optional(),
  networkApprovalContext: z.unknown().optional(),
});
export const FileApprovalSchema = z.strictObject({
  ...PromptFields,
  grantRoot: PathSchema.nullable().optional(),
});
export const PermissionApprovalSchema = z.strictObject({
  ...PromptFields,
  cwd: PathSchema,
  environmentId: PathSchema.nullable().optional(),
  permissions: PermissionsSchema,
});
export const QuestionApprovalSchema = z.strictObject({
  threadId: PathSchema,
  turnId: PathSchema,
  itemId: PathSchema,
  isBlocking: z.boolean(),
  autoResolutionMs: z.number().int().nonnegative().nullable().optional(),
  questions: z
    .array(
      z.strictObject({
        id: PathSchema,
        header: z.string().max(4096),
        question: z.string().max(8192),
        isSecret: z.boolean().default(false),
        isOther: z.boolean().default(false),
        options: z
          .array(z.strictObject({ label: z.string().max(8192), description: z.string().max(8192) }))
          .max(32)
          .nullable()
          .optional(),
      }),
    )
    .min(1)
    .max(32),
});
export type ICodexPrompt =
  | { kind: 'command'; params: z.infer<typeof CommandApprovalSchema> }
  | { kind: 'file-change'; params: z.infer<typeof FileApprovalSchema> }
  | { kind: 'permission'; params: z.infer<typeof PermissionApprovalSchema> }
  | { kind: 'question'; params: z.infer<typeof QuestionApprovalSchema> };
