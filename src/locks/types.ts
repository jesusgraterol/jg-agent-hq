import { z } from 'zod';

// owner record written into `.runtime/hq.lock` right after exclusive creation
export const HqLockOwnerSchema = z.strictObject({
  pid: z.number().int().positive(),
  nonce: z.uuid(),
  command: z.string().min(1),
  createdAt: z.iso.datetime(),
});

export type IHqLockOwner = z.infer<typeof HqLockOwnerSchema>;

// whether the owner process exists; `unknown` covers processes this user cannot signal
export type IOwnerLiveness = 'alive' | 'dead' | 'unknown';

// validation at the public acquisition boundary
export const HqLockAcquisitionSchema = z.strictObject({
  command: z
    .string()
    .trim()
    .min(1)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  waitTimeoutMs: z.number().finite().nonnegative(),
  setupWindowMs: z.number().finite().nonnegative(),
  pollIntervalMs: z.number().finite().positive(),
});

// timing overrides for acquisition
export type IHqLockOptions = {
  waitTimeoutMs?: number;
  setupWindowMs?: number;
  pollIntervalMs?: number;
};

// lock state reported without acquiring it
export type IHqLockState =
  | { kind: 'free' }
  | { kind: 'held'; owner: IHqLockOwner; liveness: IOwnerLiveness; ageMs: number }
  | { kind: 'unreadable'; ageMs: number };
