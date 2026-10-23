import { fileURLToPath } from 'node:url';
import { hashValue } from 'jg-crypto';
import { Exception } from 'jg-exception';
import { abortable, createDeadline } from 'jg-utilities';

import {
  AgentToolCallSchema,
  type IAgentToolCall,
  type IAgentToolResult,
} from '../contracts/agent-tools/index.js';
import { CollaborationRequestSchema } from '../contracts/collaboration/index.js';
import {
  createAgentCredentials,
  type INativeToolBinding,
} from '../collaboration/identity/index.js';
import { collaborationForbidden, collaborationConflict } from '../collaboration/grants/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import { suggestThreadName } from '../sessions/names/index.js';

import {
  AGENT_BRIDGE_FILE_ENV,
  MAX_AGENT_TOOL_CALLS,
  COLLABORATION_TOOL_COMMANDS,
} from './constants.js';
import { agentToolDefinitions, agentToolError, agentToolResult } from './utilities.js';
import type { IAgentTools, IAgentToolsOptions, IAgentToolDefinition } from './types.js';

/**
 * Exposes closed agent operations behind server-derived session identity and current task authority.
 * @returns Provider callbacks, private stdio admission and confirmed lifetime cleanup.
 */
export const createAgentTools = (options: IAgentToolsOptions): IAgentTools => {
  const credentials = createAgentCredentials(options.stateRoot, options.runtimeEpoch);
  const owned = new Set<Promise<IAgentToolResult>>();
  const lifetime = new AbortController();
  let definitions: IAgentToolDefinition[] | undefined;
  let closing: Promise<void> | undefined;

  const perform = async (
    binding: INativeToolBinding,
    call: IAgentToolCall,
    signal: AbortSignal,
  ): Promise<IAgentToolResult> => {
    await options.actions.flushEvents(binding.provider);
    const taskId = call.arguments.taskId;
    const identity = await options.store.agentIdentity({
      binding,
      ...(call.name === 'hq_identity' ? call.arguments : { taskId, limit: 1 }),
    });
    await resolveWorkspaceTarget(identity.workspaceRoot, options.allowedRoots);
    signal.throwIfAborted();
    if (call.name === 'hq_identity') {
      const pending =
        identity.selectedTask === null
          ? null
          : await options.collaboration.handle(
              {
                kind: 'collaboration',
                actor: { kind: 'agent', agentId: identity.agentId },
                command: { kind: 'status', taskId: identity.selectedTask.id },
              },
              binding,
            );
      return agentToolResult({
        identity,
        pending: pending?.kind === 'status' ? pending.status : null,
      });
    }
    if (!identity.selectedTask || !identity.membership || !identity.permissions)
      return collaborationForbidden();
    if (call.name === 'hq_sessions_list' || call.name === 'hq_session_evidence_read') {
      const workspaceRoot = await resolveWorkspaceTarget(
        call.arguments.workspaceRoot,
        options.allowedRoots,
      );
      if (
        !identity.permissions.effects.includes('read') ||
        !identity.permissions.providers.includes(call.arguments.provider) ||
        !identity.permissions.workspaceRoots.includes(workspaceRoot)
      )
        return collaborationForbidden();
      signal.throwIfAborted();
      if (call.name === 'hq_sessions_list') {
        const { taskId: _taskId, ...query } = call.arguments;
        return agentToolResult(await options.read({ ...query, workspaceRoot, kind: 'sessions' }));
      }
      const { taskId: _taskId, ...query } = call.arguments;
      return agentToolResult(
        await options.read({ ...query, workspaceRoot, kind: 'session-evidence' }),
      );
    }
    if (call.name === 'hq_agent_spawn') {
      const args = call.arguments;
      const workspaceRoot = await resolveWorkspaceTarget(args.workspaceRoot, options.allowedRoots);
      const commandDigest = hashValue(JSON.stringify({ ...args, workspaceRoot }));
      const query = { binding, taskId: args.taskId, actionId: args.id, commandDigest };
      const existing = await options.store.getAgentSpawn(query);
      if (existing) {
        const receipt = await options.store.getAction(args.id);
        if (!receipt) return collaborationConflict();
        return agentToolResult(
          { taskId: args.taskId, agentId: existing.childAgentId, receipt },
          receipt.delivery === 'failed',
        );
      }
      if (
        identity.selectedTask.state !== 'active' ||
        identity.membership.state !== 'active' ||
        !identity.permissions.canSpawn ||
        !identity.permissions.providers.includes(args.provider) ||
        !identity.permissions.workspaceRoots.includes(workspaceRoot)
      )
        return collaborationForbidden();
      signal.throwIfAborted();
      const receipt = await options.actions.submit(
        {
          id: args.id,
          runtimeEpoch: options.runtimeEpoch,
          command: {
            kind: 'thread-create',
            provider: args.provider,
            workspaceRoot,
            name: suggestThreadName(`${args.provider} ${args.purpose}`),
          },
        },
        { binding, taskId: args.taskId, purpose: args.purpose, commandDigest },
      );
      return agentToolResult(
        { taskId: args.taskId, agentId: receipt.threadId, receipt },
        receipt.delivery === 'failed',
      );
    }
    const request = CollaborationRequestSchema.safeParse({
      kind: 'collaboration',
      actor: { kind: 'agent', agentId: identity.agentId },
      command: { ...call.arguments, kind: COLLABORATION_TOOL_COMMANDS[call.name] },
    });
    if (!request.success)
      throw new Exception('The HQ request is invalid', {
        code: 'JG_AGENT_HQ_REQUEST_INVALID',
        data: { kind: 'invalid-request' },
        cause: request.error,
      });
    signal.throwIfAborted();
    return agentToolResult(await options.collaboration.handle(request.data, binding));
  };

  const call = async (
    binding: INativeToolBinding,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<IAgentToolResult> => {
    let deadline: ReturnType<typeof createDeadline> | undefined;
    try {
      if (closing || owned.size >= MAX_AGENT_TOOL_CALLS) return collaborationConflict();
      const parsed = AgentToolCallSchema.safeParse(input);
      if (!parsed.success)
        throw new Exception('The HQ request is invalid', {
          code: 'JG_AGENT_HQ_REQUEST_INVALID',
          data: { kind: 'invalid-request' },
          cause: parsed.error,
        });
      deadline = createDeadline({
        timeoutSeconds: 30,
        signal: AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]),
      });
      deadline.throwIfStopped();
      const operationSignal = deadline.signal;
      const operation = options.run(() => perform(binding, parsed.data, operationSignal));
      owned.add(operation);
      void operation.finally(() => owned.delete(operation)).catch(() => undefined);
      return await abortable(operation, { signal: deadline.signal });
    } catch (error) {
      return agentToolError(error);
    } finally {
      deadline?.dispose();
    }
  };

  return {
    forProvider: (provider) => ({
      definitions: () => structuredClone((definitions ??= agentToolDefinitions())),
      call: (nativeId, turnId, name, argumentsValue, signal) =>
        call(
          { provider, nativeId, runtimeEpoch: options.runtimeEpoch, ...(turnId ? { turnId } : {}) },
          { name, arguments: argumentsValue },
          signal,
        ),
      mcp: async (nativeId) => {
        const lease = await credentials.issue({
          provider,
          nativeId,
          runtimeEpoch: options.runtimeEpoch,
        });
        return {
          serverName: `jg_agent_hq_${options.runtimeEpoch.replaceAll('-', '').slice(0, 8)}`,
          configuration: {
            command: process.execPath,
            args: [fileURLToPath(new URL('../cli/cli.js', import.meta.url)), 'agent-bridge'],
            env: { [AGENT_BRIDGE_FILE_ENV]: lease.filePath },
          },
          release: lease.release,
        };
      },
    }),
    handleBridge: async (request, signal) => {
      try {
        return await call(credentials.resolve(request.credential), request.call, signal);
      } catch (error) {
        return agentToolError(error);
      }
    },
    close: () =>
      (closing ??= (async () => {
        lifetime.abort();
        await Promise.allSettled([...owned]);
        await credentials.close();
      })()),
  };
};
