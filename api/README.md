# Public API

Import the named exports from `jg-agent-hq`. Internal module paths are private.

## Lock lifecycle

- `acquireHqLock(root, command, options?)` acquires `.runtime/hq.lock` and returns an asynchronous release function. The caller owns the trusted state root and supplies a non-empty, single-line operation label. Surrounding whitespace is trimmed. The returned release function is idempotent and refuses a replaced owner.
- `withHqLock(root, command, operation, options?)` runs an asynchronous operation under the lock. It releases on success or failure; operation failures propagate unchanged. If cleanup also fails, the original operation error stays primary and cleanup failure is reported on stderr.
- `readHqLockState(root, now?)` reports free, held or unreadable without acquiring or reclaiming the lock. Held state includes the owner, liveness and age.
- `getOwnerLiveness(pid)` reports alive, dead or unknown. An unverifiable owner is not evidence that recovery is safe.
- `releaseHqLock(root, nonce)` is deliberate operator recovery. Confirm first that the inspected owner and its children have stopped. It checks the inspected nonce rather than liveness, because a reused PID must not prevent recovery.

`IHqLockOptions` retains the wait timeout, setup window and poll interval. Defaults are 120 seconds, 16 seconds and 200 milliseconds. Durations must be finite and non-negative; the poll interval must be positive. Invalid acquisition arguments fail before filesystem writes. An empty freshly created file is tolerated only within the setup window. Owner records are bounded to 16,384 UTF-8 bytes. The private directory and lock must belong to the current user and have no group/other access.

`IHqLockOwner`, `IOwnerLiveness`, `IHqLockOptions` and `IHqLockState` describe the contracts. `RUNTIME_DIRECTORY` and `HQ_LOCK_FILE` expose the established names.

All operations may expose the relevant intentional contracts in [errors](../errors/README.md). Filesystem failures outside those classifications propagate to the trusted Node caller. The returned acquisition release function can expose the ownership-changed contract.
