import { Exception } from 'jg-exception';

import { HqResponseSchema, type IHqResponse, type IHqRequest } from '../contracts/index.js';
import { retainNativeLineage } from '../providers/index.js';
import type { createProviderRegistry } from '../providers/registry/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import type { IStore } from '../store/index.js';

import type { IHistoryRequest } from './types.js';
import {
  evidencePosition,
  verifyEvidencePage,
  evidenceCursor,
  evidenceHash,
  utf8Chunk,
  nativeProvenance,
  EVIDENCE_SOURCE_PAGE_SIZE,
} from './evidence/index.js';

/**
 * Authorizes native history before loading content and records only its discovery projection.
 * @returns One provider-paged read result, never a complete transcript scan.
 * @throws
 * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
 * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
 * - JG_AGENT_HQ_CODEX_FAILED: The Codex integration failed
 * - JG_AGENT_HQ_CLAUDE_FAILED: The Claude integration failed
 * - JG_AGENT_HQ_CLAUDE_HISTORY_UNAVAILABLE: The Claude history is unavailable
 * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
 * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
 * - JG_AGENT_HQ_TRANSPORT_FAILED: The HQ transport failed
 * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
 */
export const readNativeHistory = async (
  command: IHistoryRequest | Extract<IHqRequest, { kind: 'sessions' }>,
  registry: ReturnType<typeof createProviderRegistry>,
  projection: IStore,
  allowedRoots: string[],
): Promise<IHqResponse> => {
  const workspaceRoot = await resolveWorkspaceTarget(command.workspaceRoot, allowedRoots);
  if (command.kind === 'sessions') {
    const selected = { ...command, workspaceRoot };
    const position = evidencePosition(selected);
    const page = await readNativeHistory(
      {
        kind: 'threads',
        provider: command.provider,
        workspaceRoot,
        limit: EVIDENCE_SOURCE_PAGE_SIZE,
        search: command.search,
        cursor: position.sourceCursor,
      },
      registry,
      projection,
      allowedRoots,
    );
    if (page.kind !== 'threads')
      throw new Exception('The HQ provider integration failed', {
        code: 'JG_AGENT_HQ_PROVIDER_FAILED',
        data: { kind: 'agent-unavailable' },
      });
    const digest = verifyEvidencePage(position, page.result.data);
    const result: Extract<IHqResponse, { kind: 'sessions' }> = {
      kind: 'sessions',
      result: { data: [], nextCursor: null, source: 'native' },
    };
    let index = position.index;
    for (
      ;
      index < page.result.data.length && result.result.data.length < command.limit;
      index += 1
    ) {
      const thread = page.result.data[index]!;
      const name = thread.name === null ? null : utf8Chunk(Buffer.from(thread.name), 0, 1024);
      const item = { ...thread, name, isNameTruncated: name !== thread.name };
      const candidate = {
        ...result.result,
        data: [...result.result.data, item],
        nextCursor: evidenceCursor(selected, { ...position, digest, index: index + 1, offset: 0 }),
      };
      if (Buffer.byteLength(JSON.stringify(candidate)) > 45_056) {
        if (result.result.data.length === 0)
          throw new Exception('The HQ provider integration failed', {
            code: 'JG_AGENT_HQ_PROVIDER_FAILED',
            data: { kind: 'agent-unavailable' },
          });
        break;
      }
      result.result.data.push(item);
    }
    result.result.nextCursor = evidenceCursor(
      selected,
      index < page.result.data.length
        ? { ...position, digest, index, offset: 0 }
        : page.result.nextCursor === null
          ? null
          : { sourceCursor: page.result.nextCursor, digest: null, index: 0, offset: 0 },
    );
    return HqResponseSchema.parse(result);
  }
  const adapter = await registry.get(command.provider);
  const response = await adapter.readHistory({ ...command, workspaceRoot });
  const threads =
    response.kind === 'threads'
      ? response.result.data
      : response.kind === 'thread'
        ? [response.result]
        : [];
  const resolvedRoots = new Map<string, string>();
  for (const thread of threads) {
    let actualRoot = resolvedRoots.get(thread.workspaceRoot);
    if (!actualRoot) {
      actualRoot = await resolveWorkspaceTarget(thread.workspaceRoot, allowedRoots);
      resolvedRoots.set(thread.workspaceRoot, actualRoot);
    }
    if (actualRoot !== workspaceRoot)
      throw new Exception('The HQ target is outside the allowed workspaces', {
        code: 'JG_AGENT_HQ_TARGET_FORBIDDEN',
        data: { kind: 'access-denied' },
      });
    thread.workspaceRoot = actualRoot;
  }
  if (threads.length) {
    const managed = new Map(
      (
        await projection.getNativeThreads(
          command.provider,
          threads.map((thread) => thread.nativeId),
        )
      ).map((thread) => [thread.nativeId, thread]),
    );
    const states = new Map(
      (
        await projection.getSessionStates(
          command.provider,
          threads.map((thread) => thread.nativeId),
        )
      ).map((session) => [session.nativeId, session.state]),
    );
    for (const thread of threads) {
      const control = managed.get(thread.nativeId);
      if (control) {
        thread.ownership = control.ownership;
        thread.managedId = control.id;
        thread.name = control.name;
        thread.nativeLineage = retainNativeLineage(control.nativeLineage, thread.nativeLineage);
      }
      thread.state = states.get(thread.nativeId) ?? thread.state;
    }
    await projection.remember(
      threads,
      response.kind === 'threads' ? response.result.nextCursor : null,
    );
  }
  const items =
    response.kind === 'session-evidence' || response.kind === 'items' ? response.result.data : [];
  if (items.length && 'nativeId' in command) {
    // provider assertions alone never establish an operator or an HQ action link
    for (const item of items) {
      const observed = item.provenance;
      item.provenance = nativeProvenance(item.kind, observed.nativeInputId);
      if (observed.origin === 'system' && observed.source === 'native-kind')
        item.provenance = { ...item.provenance, origin: 'system', source: 'native-kind' };
    }
    const origins = await projection.getEvidenceOrigins({
      provider: command.provider,
      nativeId: command.nativeId,
      items: items.map((item) => ({
        nativeInputId:
          item.kind === 'user-message' && (!('isTruncated' in item) || !item.isTruncated)
            ? item.provenance.nativeInputId
            : null,
        turnId: 'reference' in item ? item.reference.turnId : item.turnId,
        sha256: 'reference' in item ? item.reference.sha256 : evidenceHash(item.text),
      })),
    });
    for (const [index, origin] of origins.entries())
      if (origin && items[index]) items[index].provenance = origin;
  }
  if (response.kind === 'session-evidence' && Buffer.byteLength(JSON.stringify(response)) > 65_280)
    throw new Exception('The HQ provider integration failed', {
      code: 'JG_AGENT_HQ_PROVIDER_FAILED',
      data: { kind: 'agent-unavailable' },
    });
  return HqResponseSchema.parse(response);
};
