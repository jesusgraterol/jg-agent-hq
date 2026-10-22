import { randomUUID } from 'node:crypto';
import { Exception } from 'jg-exception';

import type {
  IPlanCompletion,
  IPlanSnapshotMilestone,
  IPlanDraftMilestone,
  IPlanProposal,
  IPlanCorrespondence,
  IPlanCorrespondenceRecord,
  IPlanOperatorAction,
  IPlanRevision,
} from '../contracts/index.js';

import {
  getMilestoneContractDigest,
  hashPlanContent,
  isSamePlanRevision,
  parsePlanMilestones,
} from './utilities.js';
import { prepareReconciliationIds, prepareSequenceMarkers } from './documents.js';
import type { IPlanArtifacts } from './types.js';

const conflict = (): never => {
  throw new Exception('The HQ action conflicts with its recorded state', {
    code: 'JG_AGENT_HQ_ACTION_CONFLICT',
    data: {
      kind: 'state-conflict',
    },
  });
};
const contractKey = (entry: { id: string; contractDigest: string }) =>
  JSON.stringify([entry.id, entry.contractDigest]);
const matchKey = (entry: { title: string; contract: string; sharedDigest: string }) =>
  JSON.stringify([entry.title, entry.sharedDigest, entry.contract]);

/**
 * Builds one memoized verification lookup, preserving original checks rather than asserting new ones.
 * @returns A predicate for an exact contract or its operator-confirmed equivalent correspondence.
 */
export const createCompletionLookup = (
  completions: IPlanCompletion[],
  records: IPlanCorrespondenceRecord[],
) => {
  const invalidated = new Set(records.flatMap((record) => record.invalidatedReceiptIds));
  const reopened = new Map<string, { id: string; index: number }>();
  records.forEach((record, index) => {
    if (record.relation === 'reopened')
      for (const target of record.targets) reopened.set(target.id, { id: record.action.id, index });
  });
  const direct = new Set(
    completions
      .filter(
        (receipt) =>
          !invalidated.has(receipt.id) &&
          receipt.reopenActionId === (reopened.get(receipt.milestoneId ?? '')?.id ?? null),
      )
      .map((receipt) => JSON.stringify([receipt.milestoneId, receipt.contractDigest])),
  );
  const links = new Map<string, string[][]>();
  for (const [recordIndex, record] of records.entries()) {
    if (record.relation !== 'equivalent') continue;
    const sources = record.sources.filter((source) => source.status === 'done').map(contractKey);
    if (sources.length !== record.sources.length) continue;
    for (const target of record.targets) {
      if (target.status !== 'done' || recordIndex <= (reopened.get(target.id)?.index ?? -1))
        continue;
      const key = contractKey(target);
      const groups = links.get(key) ?? [];
      groups.push(sources);
      links.set(key, groups);
    }
  }
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const verified = (key: string): boolean => {
    if (direct.has(key)) return true;
    if (memo.has(key)) return memo.get(key)!;
    if (visiting.has(key)) return false;
    visiting.add(key);
    const result = (links.get(key) ?? []).some((sources) => sources.every(verified));
    visiting.delete(key);
    memo.set(key, result);
    return result;
  };
  return (entry: { id: string | null; contractDigest: string | null }): boolean =>
    !!entry.id &&
    !!entry.contractDigest &&
    verified(JSON.stringify([entry.id, entry.contractDigest]));
};

/**
 * Creates stable prospective identities and exact matches without using ordinal as identity.
 * @returns A single saved proposal containing every unmatched checkpoint entry.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 */
export const proposeReconciliation = (
  artifacts: IPlanArtifacts,
  action: IPlanOperatorAction,
): IPlanProposal => {
  const checkpoint = artifacts.coordination.revision?.checkpoint;
  if (!checkpoint) conflict();
  const sources = checkpoint!.entries;
  const oldByContract = new Map<string, IPlanSnapshotMilestone[]>();
  const newCounts = new Map<string, number>();
  for (const entry of sources) {
    const key = matchKey(entry);
    const list = oldByContract.get(key) ?? [];
    list.push(entry);
    oldByContract.set(key, list);
  }
  for (const entry of artifacts.parsed) {
    const key = matchKey(entry);
    newCounts.set(key, (newCounts.get(key) ?? 0) + 1);
  }
  const verified = createCompletionLookup(
    artifacts.coordination.completions,
    artifacts.coordination.correspondences,
  );
  const matched = new Set<string>();
  const exactMatches = artifacts.parsed.map((entry) => {
    const key = matchKey(entry);
    const candidates = oldByContract.get(key) ?? [];
    const candidate = candidates.length === 1 && newCounts.get(key) === 1 ? candidates[0]! : null;
    const exact =
      candidate && (candidate.status !== 'done' || verified(candidate)) ? candidate : null;
    if (entry.id && exact && entry.id !== exact.id) conflict();
    return exact;
  });
  const retained = new Map(
    artifacts.parsed.flatMap((entry, index) => {
      const exact = exactMatches[index];
      return exact ? [[entry.ordinal, exact.id] as const] : [];
    }),
  );
  const assigned =
    artifacts.milestones === null
      ? []
      : parsePlanMilestones(prepareReconciliationIds(artifacts.milestones, retained));
  const drafts: IPlanDraftMilestone[] = artifacts.parsed.map((entry, index) => {
    const exact = exactMatches[index];
    if (exact) matched.add(exact.id);
    const id = exact?.id ?? assigned[index]!.id!;
    return {
      id,
      ordinal: entry.ordinal,
      title: entry.title,
      status: exact?.status ?? entry.status,
      contract: entry.contract,
      sharedDigest: entry.sharedDigest,
      contractDigest: getMilestoneContractDigest({ ...entry, id }),
      matchedSourceId: exact?.id ?? null,
    };
  });
  return {
    id: action.id,
    revision: artifacts.revision,
    inspectionHash: artifacts.hashes.milestones,
    drafts,
    unmatchedSourceIds: sources
      .filter((source) => !matched.has(source.id))
      .map((source) => source.id),
    confirmation: null,
  };
};

/**
 * Validates one complete explicit mapping, including omitted and split/merged correspondence.
 * @returns Assigned drafts and retained evidence relationships, without granting approval.
 * @throws
 * - JG_AGENT_HQ_ACTION_CONFLICT: The HQ action conflicts with its recorded state
 */
export const confirmReconciliation = (
  artifacts: IPlanArtifacts,
  proposal: IPlanProposal,
  action: IPlanOperatorAction,
  decisions: IPlanCorrespondence[],
): { drafts: IPlanDraftMilestone[]; records: IPlanCorrespondenceRecord[] } => {
  const checkpoint = artifacts.coordination.revision?.checkpoint;
  if (
    !checkpoint ||
    proposal.inspectionHash !== artifacts.hashes.milestones ||
    !isSamePlanRevision(proposal.revision, artifacts.revision)
  )
    conflict();
  const sources = new Map(checkpoint!.entries.map((entry) => [entry.id, entry]));
  const drafts = structuredClone(proposal.drafts);
  const targets = new Map(drafts.map((draft) => [draft.id, draft]));
  const unmatched = new Set(proposal.unmatchedSourceIds);
  const seenSources = new Set<string>();
  const seenTargets = new Set<string>();
  const verified = createCompletionLookup(
    artifacts.coordination.completions,
    artifacts.coordination.correspondences,
  );
  const records: IPlanCorrespondenceRecord[] = [];
  for (const decision of decisions) {
    if (
      decision.sourceIds.some((id) => !unmatched.has(id) || seenSources.has(id)) ||
      decision.targetIds.some(
        (id) => !targets.has(id) || targets.get(id)!.matchedSourceId || seenTargets.has(id),
      )
    )
      conflict();
    const previous = decision.sourceIds.map((id) => sources.get(id)!);
    const next = decision.targetIds.map((id) => targets.get(id)!);
    if (
      decision.relation === 'omitted'
        ? next.length !== 0 || decision.retainedPairs.length !== 0
        : next.length === 0
    )
      conflict();
    if (decision.relation === 'requirements-changed' && decision.retainedPairs.length) conflict();
    if (
      decision.relation === 'equivalent' &&
      previous.some((source) => source.status === 'done' && !verified(source))
    )
      conflict();
    if (
      previous.length === 1 &&
      next.length === 1 &&
      decision.relation === 'equivalent' &&
      (decision.retainedPairs.length !== 1 ||
        decision.retainedPairs[0]!.sourceId !== previous[0]!.id ||
        decision.retainedPairs[0]!.targetId !== next[0]!.id)
    )
      conflict();
    const retainedSources = new Set<string>();
    const retainedTargets = new Set<string>();
    for (const pair of decision.retainedPairs) {
      if (
        !decision.sourceIds.includes(pair.sourceId) ||
        !decision.targetIds.includes(pair.targetId) ||
        retainedSources.has(pair.sourceId) ||
        retainedTargets.has(pair.targetId)
      )
        conflict();
      retainedSources.add(pair.sourceId);
      retainedTargets.add(pair.targetId);
    }
    const allDone = previous.every((source) => source.status === 'done');
    const allPending = previous.every((source) => source.status === 'pending');
    for (const target of next) {
      const retained = decision.retainedPairs.find((pair) => pair.targetId === target.id);
      target.id = retained?.sourceId ?? target.id;
      target.status =
        decision.relation === 'equivalent'
          ? allDone
            ? 'done'
            : allPending
              ? 'pending'
              : 'in progress'
          : 'pending';
      target.contractDigest = getMilestoneContractDigest(target);
    }
    const invalidatedReceiptIds =
      decision.relation === 'reopened'
        ? artifacts.coordination.completions
            .filter(
              (receipt) =>
                receipt.milestoneId !== null && decision.sourceIds.includes(receipt.milestoneId),
            )
            .map((receipt) => receipt.id)
        : [];
    records.push({
      id: randomUUID(),
      action,
      revision: artifacts.revision,
      sources: previous,
      targets: next.map((target) => ({
        id: target.id,
        contractDigest: target.contractDigest,
        status: target.status,
      })),
      relation: decision.relation,
      invalidatedReceiptIds,
      recordedAt: Date.now(),
    });
    for (const id of decision.sourceIds) seenSources.add(id);
    for (const id of decision.targetIds) seenTargets.add(id);
  }
  if (
    seenSources.size !== unmatched.size ||
    new Set(drafts.map((draft) => draft.id)).size !== drafts.length
  )
    conflict();
  return { drafts, records };
};

/**
 * Prepares selected identity/progress through the document engine; requirement prose is unchanged.
 * @returns The canonical sequence for explicit presentation and approval.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const renderReconciledSequence = (
  content: string,
  drafts: IPlanDraftMilestone[],
): string => {
  const parsed = parsePlanMilestones(content);
  if (
    parsed.length !== drafts.length ||
    parsed.some((entry, index) => entry.ordinal !== drafts[index]!.ordinal)
  )
    throw new Exception('The HQ plan is invalid', {
      code: 'JG_AGENT_HQ_PLAN_INVALID',
      data: { kind: 'invalid-request' },
    });
  return prepareSequenceMarkers(content, drafts);
};
