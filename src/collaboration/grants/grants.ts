import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { Exception } from 'jg-exception';

import type {
  IAgentPermissions,
  ICollaborationPlan,
  IPathScope,
  IRequestSpecification,
  ISkillGrant,
} from '../../contracts/collaboration/index.js';

/**
 * Rejects an attempt to exceed the authenticated host or task scope.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const collaborationForbidden = (): never => {
  throw new Exception('The HQ collaboration operation is not authorized', {
    code: 'JG_AGENT_HQ_COLLABORATION_FORBIDDEN',
    data: { kind: 'access-denied' },
  });
};

/**
 * Rejects a changed, conflicting or already consumed collaboration operation.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_CONFLICT: The HQ collaboration operation conflicts with its recorded state
 */
export const collaborationConflict = (): never => {
  throw new Exception('The HQ collaboration operation conflicts with its recorded state', {
    code: 'JG_AGENT_HQ_COLLABORATION_CONFLICT',
    data: { kind: 'state-conflict' },
  });
};

const containsPath = (root: string, candidate: string): boolean => {
  const child = relative(root, candidate);
  return !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
};

/**
 * Validates logical root-relative grant paths; actual filesystem use rechecks symlinks separately.
 * @returns The normalized relative path, with an empty path selecting the workspace.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const validateScopePath = (path: string): string => {
  if (path === '') return '';
  if (
    isAbsolute(path) ||
    /[\u0000-\u001f\u007f\\]/.test(path) ||
    /^[a-z]:/i.test(path) ||
    path.split('/').some((part) => part === '..' || part === '.' || part === '')
  )
    collaborationForbidden();
  if (normalize(path) !== path) collaborationForbidden();
  return path;
};

/**
 * Enforces a host-issued subset without treating role labels or provider names as authority.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const assertPermissionsSubset = (
  selected: IAgentPermissions,
  allowed: IAgentPermissions,
): void => {
  if (
    selected.providers.some((provider) => !allowed.providers.includes(provider)) ||
    selected.workspaceRoots.some((root) => !allowed.workspaceRoots.includes(root)) ||
    selected.effects.some((effect) => !allowed.effects.includes(effect)) ||
    (selected.canSpawn && !allowed.canSpawn) ||
    (selected.canManagePeerSubscriptions && !allowed.canManagePeerSubscriptions) ||
    (selected.canExecuteRequests && !allowed.canExecuteRequests)
  )
    collaborationForbidden();
};

/**
 * Validates logical workspace/path containment without reading referenced bodies.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const assertScopesAllowed = (scopes: IPathScope[], allowed: IPathScope[]): void => {
  for (const scope of scopes) {
    const candidates = allowed.filter((entry) => entry.workspaceRoot === scope.workspaceRoot);
    if (candidates.length === 0) collaborationForbidden();
    for (const path of scope.pathPrefixes) {
      validateScopePath(path);
      if (
        !candidates.some((entry) =>
          entry.pathPrefixes.some((prefix) =>
            containsPath(
              resolve(scope.workspaceRoot, validateScopePath(prefix)),
              resolve(scope.workspaceRoot, path),
            ),
          ),
        )
      )
        collaborationForbidden();
    }
  }
};

const isPlanWithinGrant = (
  plan: ICollaborationPlan | null,
  allowed: ICollaborationPlan | null,
): boolean => {
  if (allowed === null) return true;
  if (
    plan === null ||
    plan.planId !== allowed.planId ||
    plan.directory !== allowed.directory ||
    plan.revision.planDigest !== allowed.revision.planDigest ||
    plan.revision.breakdownDigest !== allowed.revision.breakdownDigest
  )
    return false;
  return (
    allowed.milestoneIds.length === 0 ||
    (plan.milestoneIds.length > 0 &&
      plan.milestoneIds.every((id) => allowed.milestoneIds.includes(id)))
  );
};

/**
 * Keeps child effects, paths and plan selection within the active parent invocation.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const assertDelegationScope = (
  child: IRequestSpecification,
  parent: IRequestSpecification,
): void => {
  if (
    child.effects.some((effect) => !parent.effects.includes(effect)) ||
    !isPlanWithinGrant(child.plan, parent.plan)
  )
    collaborationForbidden();
  assertScopesAllowed(child.scopes, parent.scopes);
};

/**
 * Checks a requested invocation against the recipient's current task permissions and skill grant.
 * This grants admission only; plan approvals and native permissions are checked at execution.
 * @throws
 * - JG_AGENT_HQ_COLLABORATION_FORBIDDEN: The HQ collaboration operation is not authorized
 */
export const assertRequestAuthority = (
  request: IRequestSpecification,
  taskId: string,
  agentId: string,
  permissions: IAgentPermissions,
  grant: ISkillGrant | null,
): void => {
  if (
    !permissions.canExecuteRequests ||
    request.effects.some((effect) => !permissions.effects.includes(effect))
  )
    collaborationForbidden();
  assertScopesAllowed(
    request.scopes,
    permissions.workspaceRoots.map((workspaceRoot) => ({ workspaceRoot, pathPrefixes: [''] })),
  );
  if (request.skill === null) return;
  if (grant === null) return collaborationForbidden();
  if (
    grant.taskId !== taskId ||
    grant.id !== request.grantId ||
    grant.revision !== request.grantRevision ||
    grant.revokedAt !== null ||
    (grant.eligibleAgentIds !== null && !grant.eligibleAgentIds.includes(agentId)) ||
    !grant.skills.some(
      (skill) => skill.name === request.skill!.name && skill.mode === request.skill!.mode,
    ) ||
    request.effects.some((effect) => !grant.effects.includes(effect)) ||
    !isPlanWithinGrant(request.plan, grant.plan)
  )
    collaborationForbidden();
  assertScopesAllowed(request.scopes, grant.scopes);
  if (
    request.skill.name === 'jg-execute' &&
    request.skill.mode === 'auto' &&
    (!request.effects.includes('commit') || !request.effects.includes('push'))
  )
    collaborationForbidden();
};
