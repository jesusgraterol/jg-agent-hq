import { setImmediate } from 'node:timers/promises';

import type {
  IArtifactReference,
  ICollaborationRequest,
  IPathScope,
} from '../contracts/collaboration/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import type { IStore } from '../store/index.js';

import { validateScopePath } from './grants/index.js';
import type { ICollaboration, ICollaborationBackground } from './types.js';

/**
 * Shares trusted host collaboration with the worker and recovers bounded durable delivery intent.
 * @returns A metadata service; it never starts native inference.
 */
export const createCollaboration = (
  store: IStore,
  allowedRoots: string[],
  background: ICollaborationBackground,
): ICollaboration => {
  let isClosed = false;
  let loop: Promise<void> | undefined;
  let failure: 'JG_AGENT_HQ_STORE_FAILED' | null = null;

  const recover = (): void => {
    if (isClosed || loop) return;
    loop = (async () => {
      try {
        while (!isClosed && (await background(() => store.recoverCollaborationFanout())))
          await setImmediate();
      } catch {
        // Durable positions remain untouched on a failed transaction; status exposes retry need.
        failure = 'JG_AGENT_HQ_STORE_FAILED';
      } finally {
        loop = undefined;
      }
    })();
  };

  const handle: ICollaboration['handle'] = async (input, binding) => {
    const request = structuredClone(input);
    const { command } = request;
    const roots = new Map<string, Promise<string>>();
    const root = (path: string): Promise<string> => {
      let pending = roots.get(path);
      if (!pending) {
        pending = resolveWorkspaceTarget(path, allowedRoots);
        roots.set(path, pending);
      }
      return pending;
    };
    const scopes = async (selected: IPathScope[]): Promise<void> => {
      for (const scope of selected) {
        scope.workspaceRoot = await root(scope.workspaceRoot);
        scope.pathPrefixes.forEach(validateScopePath);
      }
    };
    const references = async (selected: IArtifactReference[]): Promise<void> => {
      for (const reference of selected)
        if (reference.kind === 'repository') {
          reference.workspaceRoot = await root(reference.workspaceRoot);
          validateScopePath(reference.path);
        }
    };
    if ('taskId' in command) {
      const current = await store.collaboration(
        {
          kind: 'collaboration',
          actor: request.actor,
          command: { kind: 'task-read', taskId: command.taskId },
        },
        binding,
      );
      if (current.kind === 'task') await root(current.task.workspaceRoot);
    }
    if ('workspaceRoot' in command) command.workspaceRoot = await root(command.workspaceRoot);
    if ('policy' in command)
      command.policy.workspaceRoots = await Promise.all(command.policy.workspaceRoots.map(root));
    if ('permissions' in command)
      command.permissions.workspaceRoots = await Promise.all(
        command.permissions.workspaceRoots.map(root),
      );
    if ('plan' in command && command.plan !== null)
      command.plan.directory = await root(command.plan.directory);
    if ('scopes' in command) await scopes(command.scopes);
    if ('references' in command) await references(command.references);
    if (command.kind === 'message-publish' && command.request !== null) {
      await scopes(command.request.scopes);
      await references(command.request.targetReferences);
      if (command.request.plan !== null)
        command.request.plan.directory = await root(command.request.plan.directory);
    }
    const response = await store.collaboration(request, binding);
    if (command.kind === 'fanout-recover') {
      failure = null;
      recover();
    }
    if (command.kind === 'message-publish' || command.kind === 'subscription-set') recover();
    if (response.kind === 'status') response.status.fanoutFailure = failure;
    return response;
  };
  recover();
  return {
    handle,
    close: async () => {
      isClosed = true;
      await loop;
    },
  };
};
