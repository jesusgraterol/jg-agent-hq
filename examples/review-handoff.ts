import { requestAgentHq } from 'jg-agent-hq';
import type {
  ICollaborationCommand,
  ICollaborationRequestRecord,
  ICollaborationResponse,
  IRequestSpecification,
} from 'jg-agent-hq/contracts';
import { waitUntil } from 'jg-utilities';

/**
 * Requests a review and returns its exact report reference for author assessment.
 * The host has already created the task, stream, memberships and any selected skill grants.
 * Either agent may use any provider. A null skill selection requires no installed skills.
 * Connect confirmRequest to an actual operator decision; native permissions stay separate.
 */
export const reviewHandoff = async (input: {
  stateRoot: string;
  operatorRef: string;
  taskId: string;
  streamId: string;
  requestIds: { review: string; feedback: string };
  dispatchIds: { review: string; feedback: string };
  review: IRequestSpecification;
  feedback: Omit<IRequestSpecification, 'targetReferences'>;
  confirmRequest: (
    phase: 'review' | 'feedback',
    specification: IRequestSpecification,
  ) => Promise<boolean>;
}): Promise<{
  review: ICollaborationRequestRecord | null;
  feedback: ICollaborationRequestRecord | null;
}> => {
  const call = async (command: ICollaborationCommand): Promise<ICollaborationResponse> => {
    const response = await requestAgentHq(input.stateRoot, {
      kind: 'collaboration',
      actor: { kind: 'host', operatorRef: input.operatorRef },
      command,
    });
    if (response.kind !== 'collaboration') throw new Error('Expected collaboration response');
    return response.result;
  };
  const read = async (requestId: string): Promise<ICollaborationRequestRecord> => {
    const result = await call({ kind: 'request-read', taskId: input.taskId, requestId });
    if (result.kind !== 'request') throw new Error('Expected request');
    return result.request;
  };
  const send = async (phase: 'review' | 'feedback', specification: IRequestSpecification) => {
    if (!(await input.confirmRequest(phase, specification))) return null;
    const id = input.requestIds[phase];
    await call({
      kind: 'message-publish',
      id,
      taskId: input.taskId,
      streamId: input.streamId,
      messageKind: 'request',
      summary: phase === 'review' ? 'Review the selected work' : 'Assess the review findings',
      body: specification.arguments,
      references: specification.targetReferences,
      replyToMessageId: null,
      request: specification,
    });
    await call({
      kind: 'request-dispatch',
      id: input.dispatchIds[phase],
      taskId: input.taskId,
      requestId: id,
    });
    return read(id);
  };
  let review = await send('review', input.review);
  if (review === null) return { review: null, feedback: null };
  // These are bounded host reads, with no inference or replacement request on timeout.
  review = await waitUntil(
    async () => {
      const current = await read(input.requestIds.review);
      return ['resolved', 'canceled', 'interrupted', 'waiting-input'].includes(current.state)
        ? current
        : undefined;
    },
    { timeoutSeconds: 30, intervalSeconds: 0.1 },
  );
  if (review.state !== 'resolved' || review.outcome !== 'completed' || !review.lastReportId)
    return { review, feedback: null };
  const report = await call({
    kind: 'report-read',
    taskId: input.taskId,
    reportId: review.lastReportId,
  });
  if (report.kind !== 'report') throw new Error('Expected report reference');
  const feedback = await send('feedback', {
    ...input.feedback,
    targetReferences: [
      { kind: 'report', reportId: report.result.report.id, sha256: report.result.report.sha256 },
    ],
  });
  return { review, feedback };
};
