import type { DatabaseSync } from 'node:sqlite';
import { hashValue } from 'jg-crypto';
import { z } from 'zod';

import {
  CollaborationOperationSchema,
  CollaborationResponseSchema,
  type ICollaborationOperation,
  type ICollaborationRequest,
  type ICollaborationResponse,
  type ICollaborationResult,
} from '../../contracts/collaboration/index.js';
import { collaborationConflict, collaborationForbidden } from '../../collaboration/grants/index.js';
import type {
  IAgentIdentityQuery,
  IAgentIdentity,
  INativeToolBinding,
  IAgentSpawnRead,
  IAgentSpawnRecord,
} from '../../collaboration/identity/index.js';

import { taskAccess, requireHost } from './authority.js';
import { createTask, mutateTask } from './tasks.js';
import { mutateStream } from './streams.js';
import { acknowledgeMessage, fanoutBatch, publishMessage } from './messages.js';
import { mutateRequest } from './requests.js';
import { listTasks, queryCollaboration } from './queries.js';
import { assertCollaborationBudget } from './utilities.js';
import { readAgentIdentity, readNativeAgent } from './identity.js';
import { readAgentSpawn } from './spawn.js';
import { mutateCheckpoint, readInvocation } from './invocation.js';
import { collectDispatch } from './outcomes.js';
import { readReport } from './reports.js';
import { scanDispatch, readDispatchJob } from './dispatch.js';
import type { IDispatchScan } from '../../collaboration/dispatch/index.js';
import type { IDispatchBlocked } from '../../contracts/collaboration/index.js';

/** Owns short collaboration transactions and exact metadata-operation replay in the SQLite worker. */
export class CollaborationModel {
  private readonly __database: DatabaseSync;
  private readonly __runtimeEpoch: string;

  constructor(database: DatabaseSync, runtimeEpoch: string) {
    this.__database = database;
    this.__runtimeEpoch = runtimeEpoch;
  }

  /**
   * Reconstructs current session identity and bounded task discovery without trusting caller labels.
   * @returns Native-bound identity and current task permissions.
   * @throws
   * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
   * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   */
  public identity(query: IAgentIdentityQuery): IAgentIdentity {
    return this.__transaction(
      () => readAgentIdentity(this.__database, query, this.__runtimeEpoch),
      true,
    );
  }

  /**
   * Reads the exact caller-owned native spawn relationship without replaying creation.
   * @returns The retained relationship or null when no action used that identity.
   * @throws
   * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
   * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
   */
  public spawn(query: IAgentSpawnRead): IAgentSpawnRecord | null {
    return this.__transaction(
      () => readAgentSpawn(this.__database, query, this.__runtimeEpoch),
      true,
    );
  }

  /** Reads a bounded durable recovery page without loading native results. */
  public dispatchPage(query: IDispatchScan) {
    return this.__transaction(() => scanDispatch(this.__database, query), true);
  }

  /** Resolves one dispatch intent against current membership, policy and native ownership. */
  public dispatchJob(taskId: string, requestId: string) {
    return this.__transaction(
      () => readDispatchJob(this.__database, taskId, requestId, this.__runtimeEpoch),
      true,
    );
  }

  /** Stores a visible blocked reason only while the selected pending intent still matches. */
  public blockDispatch(
    requestId: string,
    selectedActionId: string,
    reason: IDispatchBlocked | null,
  ): void {
    this.__transaction(() =>
      this.__database
        .prepare(
          'UPDATE hq_request SET dispatch_blocked_reason = ? WHERE id = ? AND (pending_action_id = ? OR current_action_id = ?) AND dispatch_blocked_reason IS NOT ?',
        )
        .run(reason, requestId, selectedActionId, selectedActionId, reason),
    );
  }

  /** Collects saved terminal evidence without asking an agent to publish or classify its report. */
  public collectDispatch(taskId: string, requestId: string, actionId: string) {
    return this.__transaction(() =>
      collectDispatch(this.__database, taskId, requestId, actionId, this.__runtimeEpoch),
    );
  }

  /**
   * Applies one authorized metadata command, committing its result and delivery intent atomically.
   * @returns The selected record or original committed operation receipt.
   * @throws
   * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
   * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
   * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
   * - JG_AGENT_HQ_REQUEST_INVALID: The HQ request is invalid
   */
  public handle(
    request: ICollaborationRequest,
    binding?: INativeToolBinding,
  ): ICollaborationResponse {
    return this.__transaction(
      () => {
        const { actor, command } = request;
        if (binding !== undefined) {
          const native = readNativeAgent(this.__database, binding, this.__runtimeEpoch);
          if (actor.kind !== 'agent' || actor.agentId !== native.agentId)
            return collaborationForbidden();
        }
        if (command.kind === 'tasks-list') return listTasks(this.__database, actor, command);
        const taskId = command.kind === 'task-create' ? command.id : command.taskId;
        const context =
          command.kind === 'task-create' ? null : taskAccess(this.__database, actor, taskId);
        if (actor.kind === 'agent' && context !== null && command.kind !== 'status') {
          const invocation = readInvocation(this.__database, context);
          if (invocation !== null && !invocation.request.specification.effects.includes('read'))
            return collaborationForbidden();
          // Parent-linked publication is introduced together with its complete wait protocol.
          if (invocation !== null && command.kind === 'message-publish' && command.request !== null)
            return collaborationForbidden();
          if (
            invocation !== null &&
            [
              'request-claim',
              'request-resolve',
              'request-input',
              'request-reassign',
              'request-cancel',
            ].includes(command.kind)
          )
            return collaborationForbidden();
        }
        if (command.kind === 'operation-read')
          return {
            kind: 'operation',
            operation: this.__readOperation(taskId, command.operationId),
          };
        if (!('id' in command)) {
          if (context === null) return collaborationForbidden();
          const result =
            command.kind === 'invocation-read'
              ? {
                  kind: 'invocation' as const,
                  invocation: readInvocation(this.__database, context),
                }
              : command.kind === 'report-read'
                ? readReport(this.__database, context, command)
                : queryCollaboration(this.__database, context, command);
          assertCollaborationBudget(result);
          return result;
        }
        const digest = hashValue(JSON.stringify(request));
        const previous = this.__readOperationById(command.id);
        if (previous !== null) {
          taskAccess(this.__database, actor, taskId);
          if (previous.taskId !== taskId || previous.digest !== digest)
            return collaborationConflict();
          return { kind: 'operation', operation: previous };
        }
        let result: ICollaborationResult;
        if (command.kind === 'task-create') result = createTask(this.__database, actor, command);
        else {
          if (context === null) return collaborationForbidden();
          switch (command.kind) {
            case 'task-policy-set':
            case 'task-plan-set':
            case 'task-state-set':
            case 'agent-add':
            case 'agent-policy-set':
            case 'agent-state-set':
            case 'agent-revoke':
            case 'grant-issue':
            case 'grant-revoke':
              result = mutateTask(this.__database, context, command);
              break;
            case 'stream-create':
            case 'stream-archive':
            case 'subscription-set':
            case 'subscription-advance':
              result = mutateStream(this.__database, context, command);
              break;
            case 'message-publish':
              result = publishMessage(this.__database, context, command);
              break;
            case 'message-ack':
              result = acknowledgeMessage(this.__database, context, command.messageId);
              break;
            case 'request-claim':
            case 'request-resolve':
            case 'request-cancel':
            case 'request-reassign':
              result = mutateRequest(this.__database, context, command);
              break;
            case 'request-dispatch':
            case 'request-input':
            case 'request-resume':
            case 'request-authorize':
              result = mutateCheckpoint(this.__database, context, command);
              break;
            case 'request-collect':
              requireHost(context);
              result = {
                kind: 'collection',
                collection: collectDispatch(
                  this.__database,
                  taskId,
                  command.requestId,
                  command.actionId,
                  this.__runtimeEpoch,
                ),
              };
              break;
            case 'fanout-recover':
              requireHost(context);
              result = { kind: 'fanout', taskId, scheduled: true };
              break;
          }
        }
        const operation: ICollaborationOperation = {
          id: command.id,
          taskId,
          actor,
          commandKind: command.kind,
          digest,
          result,
          createdAt: Date.now(),
        };
        const response = CollaborationResponseSchema.parse({ kind: 'operation', operation });
        assertCollaborationBudget(response);
        this.__database
          .prepare(
            'INSERT INTO hq_collaboration_operation (id, task_id, actor, command_kind, digest, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            operation.id,
            taskId,
            JSON.stringify(actor),
            command.kind,
            digest,
            JSON.stringify(result),
            operation.createdAt,
          );
        return response;
      },
      !('id' in request.command),
    );
  }

  /**
   * Advances at most one subscriber batch without native calls or an in-memory queue.
   * @returns Whether a durable batch was processed.
   */
  public recoverFanout(): boolean {
    // Idle startup must not contend with a host writer or delay maintenance admission.
    if (
      !this.__database.prepare('SELECT 1 FROM hq_message WHERE fanout_complete = 0 LIMIT 1').get()
    )
      return false;
    return this.__transaction(() => fanoutBatch(this.__database));
  }

  private __readOperation(taskId: string, id: string): ICollaborationOperation | null {
    const operation = this.__readOperationById(id);
    if (operation !== null && operation.taskId !== taskId) return collaborationForbidden();
    return operation;
  }

  private __readOperationById(id: string): ICollaborationOperation | null {
    const row = this.__database
      .prepare(
        'SELECT id, task_id, actor, command_kind, digest, result, created_at FROM hq_collaboration_operation WHERE id = ?',
      )
      .get(id);
    if (!row) return null;
    return CollaborationOperationSchema.parse({
      id: row.id,
      taskId: row.task_id,
      actor: JSON.parse(z.string().parse(row.actor)),
      commandKind: row.command_kind,
      digest: row.digest,
      result: JSON.parse(z.string().parse(row.result)),
      createdAt: row.created_at,
    });
  }

  private __transaction<T>(operation: () => T, isReadOnly = false): T {
    this.__database.exec(isReadOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.__database.exec('COMMIT');
      return result;
    } catch (error) {
      this.__database.exec('ROLLBACK');
      throw error;
    }
  }
}
