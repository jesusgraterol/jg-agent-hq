import { requestAgentHq } from 'jg-agent-hq';
import type { IActionReceipt, IProviderId } from 'jg-agent-hq/contracts';
import { waitUntil } from 'jg-utilities';

/**
 * Creates one native session, sends explicit input and returns actual observations.
 * Start the local controller and sign in to the selected native CLI first. Retain
 * actionIds before calling; inspect those receipts after a lost client response.
 * Acknowledgement is delivery, while completion and tool permission remain native.
 */
export const controlSession = async (input: {
  stateRoot: string;
  workspaceRoot: string;
  provider: IProviderId;
  name: string;
  text: string;
  actionIds: { create: string; message: string };
}) => {
  const { stateRoot } = input;
  const status = await requestAgentHq(stateRoot, { kind: 'status' });
  if (status.kind !== 'status') throw new Error('Expected runtime status');
  const runtimeEpoch = status.result.runtimeEpoch;

  /** Reads the same admitted action; it never retries its native effect. */
  const acknowledged = (actionId: string): Promise<IActionReceipt> =>
    waitUntil(
      async () => {
        const response = await requestAgentHq(stateRoot, { kind: 'receipt', actionId });
        if (response.kind !== 'receipt') throw new Error('Expected action receipt');
        const receipt = response.result;
        if (!receipt || ['queued', 'submitted'].includes(receipt.delivery)) return;
        if (receipt.delivery !== 'acknowledged')
          throw new Error(`Inspect action ${actionId}: ${receipt.delivery}`);
        return receipt;
      },
      { timeoutSeconds: 30, intervalSeconds: 0.1 },
    );

  await requestAgentHq(stateRoot, {
    kind: 'action',
    action: {
      id: input.actionIds.create,
      runtimeEpoch,
      command: {
        kind: 'thread-create',
        provider: input.provider,
        workspaceRoot: input.workspaceRoot,
        name: input.name,
      },
    },
  });
  const created = await acknowledged(input.actionIds.create);
  if (!created.threadId) throw new Error('Creation has no managed thread');
  const threadId = created.threadId;
  const thread = await waitUntil(
    async () => {
      const response = await requestAgentHq(stateRoot, { kind: 'managed-thread', threadId });
      if (response.kind !== 'managed-thread') throw new Error('Expected managed thread');
      if (response.result?.ownership === 'uncertain' || response.result?.state === 'failed')
        throw new Error(`Inspect thread ${threadId} before sending input`);
      return response.result?.state === 'idle' ? response.result : undefined;
    },
    { timeoutSeconds: 30, intervalSeconds: 0.1 },
  );

  await requestAgentHq(stateRoot, {
    kind: 'action',
    action: {
      id: input.actionIds.message,
      runtimeEpoch,
      command: { kind: 'message', threadId, input: { kind: 'text', text: input.text } },
    },
  });
  const receipt = await acknowledged(input.actionIds.message);
  const [liveItems, approvals, usage] = await Promise.all([
    requestAgentHq(stateRoot, { kind: 'live-items', threadId }),
    requestAgentHq(stateRoot, { kind: 'approvals', threadId, state: 'pending' }),
    requestAgentHq(stateRoot, { kind: 'usage', provider: input.provider }),
  ]);
  if (liveItems.kind !== 'live-items' || approvals.kind !== 'approvals' || usage.kind !== 'usage')
    throw new Error('Expected session observations');
  return {
    thread,
    receipt,
    liveItems: liveItems.result,
    approvals: approvals.result.data,
    usage: usage.result,
  };
};
