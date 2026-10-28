import { z } from 'zod';

import { NativeLineageSchema, SessionStateSchema } from '../../contracts/index.js';

/*
 * One running or waiting session as the store knows it. A managed session carries its thread,
 * and an observed Claude session its history index entry when its transcript is indexed; an
 * observed session's workspace is resolved outside the store.
 */
export const ActiveSessionRecordSchema = z.object({
  provider: z.string(),
  nativeId: z.string(),
  state: SessionStateSchema.extract(['running', 'waiting']),
  changedAt: z.number().int(),
  thread: z
    .object({
      id: z.uuid(),
      ownership: z.enum(['managed', 'uncertain']),
      name: z.string(),
      workspaceRoot: z.string(),
      nativeLineage: NativeLineageSchema.nullable(),
      createdAt: z.number().int(),
      updatedAt: z.number().int(),
    })
    .nullable(),
  history: z
    .object({
      name: z.string().nullable(),
      createdAt: z.number().int(),
      updatedAt: z.number().int(),
      isSupported: z.boolean(),
    })
    .nullable(),
});
export type IActiveSessionRecord = z.infer<typeof ActiveSessionRecordSchema>;
export const ActiveSessionRecordsSchema = z.object({
  data: z.array(ActiveSessionRecordSchema).max(128),
  isTruncated: z.boolean(),
});
