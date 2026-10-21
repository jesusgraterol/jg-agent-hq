import { Exception } from 'jg-exception';
import { z } from 'zod';

import {
  BrowserActionSchema,
  type IBrowserAction,
  type IBrowserReceipt,
} from '../../contracts/index.js';
import type { IStore } from '../../store/index.js';

const OperatorSchema = z.string().min(1).max(256);

/** Serializes host admission and owns effects independently of an HTTP connection. */
export const createBrowserActions = (store: IStore) => {
  const pending = new Set<Promise<IBrowserReceipt>>();
  let isClosing = false;
  const read = async (id: string, operatorId: string): Promise<IBrowserReceipt | null> => {
    const parsed = z
      .object({ id: z.uuid(), operatorId: OperatorSchema })
      .safeParse({ id, operatorId });
    if (!parsed.success)
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
      });
    const receipt = await store.getBrowserAction(id, operatorId);
    if (receipt?.kind === 'native') receipt.native = await store.getAction(receipt.nativeActionId);
    return receipt;
  };
  const perform = (
    input: IBrowserAction,
    operatorId: string,
    execute: (action: IBrowserAction, nativeActionId: string) => Promise<void>,
  ): Promise<IBrowserReceipt> => {
    if (isClosing || pending.size >= 32)
      return Promise.reject(
        new Exception('The HQ action conflicts with its recorded state', {
          code: 'JG_AGENT_HQ_ACTION_CONFLICT',
          data: {
            kind: 'state-conflict',
          },
        }),
      );
    const task = (async () => {
      const action = BrowserActionSchema.safeParse(input);
      if (!action.success || !OperatorSchema.safeParse(operatorId).success)
        throw new Exception('The HQ request is invalid', {
          code: 'JG_AGENT_HQ_REQUEST_INVALID',
          data: { kind: 'invalid-request' },
        });
      const admission = await store.admitBrowserAction(action.data, operatorId);
      if (admission.isNew) {
        try {
          await execute(action.data, admission.receipt.nativeActionId);
          await store.settleBrowserAction(action.data.id, operatorId, 'acknowledged');
        } catch (cause) {
          // effects may have committed before an error; only reconciliation can establish their outcome
          await store.settleBrowserAction(action.data.id, operatorId, 'uncertain');
          throw cause;
        }
      }
      return (await read(action.data.id, operatorId))!;
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => undefined);
    return task;
  };
  return {
    read,
    perform,
    close: async () => {
      isClosing = true;
      await Promise.allSettled([...pending]);
    },
  };
};
