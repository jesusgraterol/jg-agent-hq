import { z } from 'zod';

/*
 * One machine-wide jg-locks lock and its holder, mirroring jg-locks' ILockState. `owner` is null
 * when the lock is free or its owner.json can't be read, and `isOwnerAlive` is null when there is
 * no owner or it runs on another host. jg-locks reads at most 4,096 bytes of owner.json, which
 * bounds every owner string.
 */
export const LockStateSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  state: z.enum([
    'free',
    'held',
    'owner-gone',
    'ownerless',
    'other-host',
    'recovery-in-progress',
    'unexpected-entries',
  ]),
  owner: z
    .object({
      pid: z.number().int().positive(),
      nonce: z.string().min(1).max(4096),
      hostname: z.string().max(4096),
      program: z.string().max(4096).nullable(),
      cwd: z.string().max(4096).nullable(),
      startedAt: z.string().max(4096).nullable(),
      metadata: z.record(z.string().max(4096), z.string().max(4096)),
    })
    .nullable(),
  isOwnerAlive: z.boolean().nullable(),
});
export type ILockState = z.infer<typeof LockStateSchema>;

// the present locks sorted by name, at most the 256 jg-locks lists, and whether more exist
export const LocksSchema = z.object({
  data: z.array(LockStateSchema).max(256),
  isTruncated: z.boolean(),
});
export type ILocks = z.infer<typeof LocksSchema>;
