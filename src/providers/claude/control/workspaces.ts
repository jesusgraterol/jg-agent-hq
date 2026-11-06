import { Exception, extractMessage, isException } from 'jg-exception';
import { isEqual } from 'jg-utilities';
import { z } from 'zod';

import type { IWorkspaceChange } from '../../../contracts/index.js';
import { HQ_ERRORS } from '../../../errors/index.js';
import { parseActionRequest } from '../../utilities.js';
import { ClaudeInitializeSchema } from '../types.js';

import { captureClaudeSkills } from './skills.js';
import type { IClaudeControlEvents, IClaudeSession, IClaudeWorkspaceProof } from './types.js';

const WorkspaceReplySchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    cwd: z.string(),
    changed: z.boolean(),
    transcript_relocated: z.boolean(),
  }),
  z.object({ status: z.literal('rejected'), reason: z.string(), message: z.string() }),
  z.object({ status: z.literal('needs_trust'), directory: z.string() }),
]);
const RejectionSchema = z.object({ nativeRejection: z.literal(true) });
const isRejected = (cause: unknown): boolean =>
  isException(cause) && RejectionSchema.safeParse(cause.data).success;

/**
 * Verifies native directory proof and refreshes context without inference or permission changes.
 * @returns The confirmed native transcript context.
 * @throws
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 */
const confirmWorkspace = async (
  session: IClaudeSession,
  response: unknown,
): Promise<IClaudeWorkspaceProof> => {
  const pending = session.workspaceChange;
  const connection = session.connection;
  if (!pending || !connection || session.isClosing) throw HQ_ERRORS.create('claudeFailed');
  const parsed = WorkspaceReplySchema.safeParse(response);
  if (!parsed.success) throw HQ_ERRORS.create('claudeFailed', { cause: parsed.error });
  const result = parsed.data;
  if (result.status !== 'ok') {
    if (result.status === 'needs_trust' && result.directory !== pending.change.workspaceRoot)
      throw HQ_ERRORS.create('claudeFailed');
    throw HQ_ERRORS.create('claudeFailed', {
      data: { kind: 'agent-unavailable', nativeRejection: true },
    });
  }
  if (
    result.cwd !== pending.change.workspaceRoot ||
    (pending.change.expectedWorkspaceRoot !== result.cwd &&
      (!result.changed || !result.transcript_relocated))
  )
    throw HQ_ERRORS.create('claudeFailed');
  let metadata: unknown;
  try {
    metadata = await connection.requestControl({ subtype: 'initialize' });
  } catch (cause) {
    throw new Exception(`The Claude integration failed: ${extractMessage(cause)}`, {
      code: 'JG_AGENT_HQ_CLAUDE_FAILED',
      data: { kind: 'agent-unavailable' },
      cause,
    });
  }
  const initialized = ClaudeInitializeSchema.safeParse(metadata);
  if (!initialized.success) throw HQ_ERRORS.create('claudeFailed', { cause: initialized.error });
  if (
    session.isClosing ||
    initialized.data.session_state !== 'idle' ||
    session.input ||
    session.nativeTurn ||
    session.requests.size ||
    !isEqual(
      initialized.data.current_permission_mode,
      connection.initialization.current_permission_mode,
    )
  )
    throw HQ_ERRORS.create('claudeFailed');
  session.skills = captureClaudeSkills(initialized.data.commands, Date.now());
  delete initialized.data.commands;
  Object.assign(connection.initialization, initialized.data);
  session.workspaceRoot = result.cwd;
  session.workspaceChange = undefined;
  return { workspaceRoot: result.cwd, historyWorkspaceRoot: result.cwd };
};

/** Publishes proof only after the original control's caller has already stopped waiting. */
const publishProof = (
  session: IClaudeSession,
  requestId: string,
  proof: IClaudeWorkspaceProof,
  events?: IClaudeControlEvents,
): void => {
  const intent = parseActionRequest(requestId);
  if (!intent || intent.phase !== 'workspace') return;
  events?.outcome(
    { kind: 'workspace-confirmed', ...intent, ...proof },
    {
      nativeId: session.id,
      workspaceRoot: proof.workspaceRoot,
      nativeState: 'idle',
      nativeLineage: { sessionId: session.id, parentThreadId: null, forkedFromId: null },
    },
  );
};

/**
 * Applies one exact native control before input, retaining uncertainty rather than replaying it.
 * @returns The verified destination and native transcript context.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 */
export const changeClaudeWorkspace = async (
  session: IClaudeSession,
  requestId: string,
  change: IWorkspaceChange,
  signal: AbortSignal | undefined,
  events?: IClaudeControlEvents,
): Promise<IClaudeWorkspaceProof> => {
  const intent = parseActionRequest(requestId);
  if (
    !intent ||
    intent.phase !== 'workspace' ||
    signal?.aborted ||
    session.workspaceChange ||
    session.workspaceRoot !== change.expectedWorkspaceRoot ||
    session.input ||
    session.nativeTurn ||
    session.requests.size ||
    session.backgroundTaskCount
  )
    throw HQ_ERRORS.create('actionConflict', {
      data: { kind: 'state-conflict', nativeRejection: true },
    });
  session.workspaceChange = { requestId, change };
  try {
    const result = await session.connection!.requestControl(
      { subtype: 'set_cwd', path: change.workspaceRoot },
      requestId,
    );
    const proof = await confirmWorkspace(session, result);
    if (signal?.aborted) publishProof(session, requestId, proof, events);
    return proof;
  } catch (cause) {
    if (isRejected(cause)) {
      session.workspaceChange = undefined;
      if (signal?.aborted)
        events?.outcome({ kind: 'failed', ...intent, failure: 'agent-unavailable' });
    }
    throw cause;
  }
};

/**
 * Reconciles one late control response without sending input or repeating directory control.
 * @returns Completion after publishing exact proof, refusal, or unavailable ownership.
 */
export const reconcileClaudeWorkspace = async (
  session: IClaudeSession,
  requestId: string,
  response: unknown,
  error: unknown,
  events?: IClaudeControlEvents,
): Promise<void> => {
  const intent = parseActionRequest(requestId);
  if (
    session.isClosing ||
    !intent ||
    intent.phase !== 'workspace' ||
    session.workspaceChange?.requestId !== requestId
  )
    return;
  try {
    if (error !== undefined)
      throw HQ_ERRORS.create('claudeFailed', { data: { nativeRejection: true } });
    const proof = await confirmWorkspace(session, response);
    publishProof(session, requestId, proof, events);
  } catch (cause) {
    if (isRejected(cause)) {
      session.workspaceChange = undefined;
      events?.outcome({ kind: 'failed', ...intent, failure: 'agent-unavailable' });
    } else events?.unavailable(session.id);
  }
};
