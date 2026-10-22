import { requestAgentHq } from 'jg-agent-hq';
import type { IHandoff, IHandoffPreview } from 'jg-agent-hq/contracts';
import { waitUntil } from 'jg-utilities';

/**
 * Opens review in the other provider and delivers only explicitly selected findings.
 * Both providers must be signed in, with jg-review-session and jg-feedback available.
 * The host presents each exact preview and lets the user select a completed native
 * reviewer message. Feedback delivery grants no implementation or tool permission.
 */
export const reviewHandoff = async (input: {
  stateRoot: string;
  handoffId: string;
  sourceThreadId: string;
  commit: string | null;
  confirmPreview: (preview: IHandoffPreview) => Promise<boolean>;
  selectFindings: (review: IHandoff) => Promise<{ turnId: string; itemId: string }>;
}): Promise<IHandoff> => {
  const { stateRoot, handoffId: id } = input;
  const status = await requestAgentHq(stateRoot, { kind: 'status' });
  if (status.kind !== 'status') throw new Error('Expected runtime status');
  await requestAgentHq(stateRoot, {
    kind: 'handoff',
    command: {
      kind: 'create',
      id,
      runtimeEpoch: status.result.runtimeEpoch,
      sourceThreadId: input.sourceThreadId,
      purpose: 'review',
      commit: input.commit,
    },
  });

  /** Reads exact durable handoff identity without resending native input. */
  const show = async (): Promise<IHandoff> => {
    const response = await requestAgentHq(stateRoot, {
      kind: 'handoff',
      command: { kind: 'show', id },
    });
    if (response.kind !== 'handoff' || response.result.kind !== 'handoff')
      throw new Error('Expected handoff');
    return response.result.handoff;
  };
  await waitUntil(
    async () => {
      const handoff = await show();
      if (['uncertain', 'failed', 'canceled'].includes(handoff.creation.delivery))
        throw new Error(`Inspect handoff ${id}: ${handoff.creation.delivery}`);
      return handoff.creation.delivery === 'delivered' ? handoff : undefined;
    },
    { timeoutSeconds: 30, intervalSeconds: 0.1 },
  );

  /** A changed source invalidates this preview; the host must present any replacement. */
  const sendConfirmed = async (phase: 'review' | 'feedback'): Promise<boolean> => {
    const response = await requestAgentHq(stateRoot, {
      kind: 'handoff',
      command: { kind: 'preview', id, phase },
    });
    if (response.kind !== 'handoff' || response.result.kind !== 'preview')
      throw new Error('Expected handoff preview');
    const preview = response.result.preview;
    if (preview.state !== 'ready') throw new Error(`Handoff preview: ${preview.state}`);
    if (!(await input.confirmPreview(preview))) return false;
    await requestAgentHq(stateRoot, {
      kind: 'handoff',
      command: { kind: 'send', id, phase, expectedPreviewDigest: preview.digest },
    });
    return true;
  };
  if (!(await sendConfirmed('review'))) return show();
  const selection = await input.selectFindings(await show());
  // HQ validates that the selected item belongs to this completed reviewer turn.
  await requestAgentHq(stateRoot, {
    kind: 'handoff',
    command: { kind: 'collect', id, ...selection },
  });
  await sendConfirmed('feedback');
  return show();
};
