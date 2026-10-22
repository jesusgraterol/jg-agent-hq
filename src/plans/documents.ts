import { hashValue as fingerprintSource } from 'jg-crypto';
import { Exception } from 'jg-exception';
import {
  fingerprintPlan,
  parseMilestones,
  parsePlan,
  preparePlanDocumentWrite,
  preparePlanUpdate,
  type ISourceSpan,
} from 'jg-plans';
import { z } from 'zod';

import { PlanMetadataSchema, type IPlanMetadata, type IPlanStatus } from '../contracts/index.js';

const administrativeKeys = ['created_at', 'updated_at', 'revision', 'status'];
const bindingSchema = z.object({
  plan_id: z.string().refine((value) => value.trim().length > 0),
  plan_revision: z.number().int().positive(),
  plan_content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const metadataSchema = z.record(z.string(), z.json());

const invalid = (cause?: unknown): never => {
  throw new Exception('The HQ plan is invalid', {
    code: 'JG_AGENT_HQ_PLAN_INVALID',
    data: { kind: 'invalid-request' },
    cause,
  });
};

/** Metadata must be available as plain JSON; absence alone supplies an empty mapping. */
const metadataOf = (
  document: ReturnType<typeof parsePlan> | ReturnType<typeof parseMilestones>,
) => {
  if (!document.frontmatter) return {};
  if (!document.frontmatter.closed || fingerprintPlan(document.source).sha256 === null)
    return invalid();
  const parsed = metadataSchema.safeParse(document.rawMetadata);
  if (!parsed.success) return invalid(parsed.error);
  return parsed.data;
};

/**
 * The default HQ profile keeps unknown contract fields, including the plan identity.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const observePlanContract = (
  source: string,
  custom?: { body: string; metadata: IPlanMetadata },
): { body: string; metadata: IPlanMetadata } => {
  const document = parsePlan(source);
  const raw = metadataOf(document);
  if (!document.body || ('id' in raw && !z.string().trim().min(1).safeParse(raw.id).success))
    return invalid();
  if (custom) {
    const parsed = PlanMetadataSchema.safeParse(custom.metadata);
    if (!parsed.success || custom.body !== document.body) return invalid(parsed.error);
    return { body: document.body, metadata: parsed.data };
  }
  const extensions = Object.fromEntries(
    Object.entries(raw).filter(
      ([key]) =>
        ![...administrativeKeys, 'scope', 'repositories', 'errorReservations'].includes(key),
    ),
  );
  const parsed = PlanMetadataSchema.safeParse({
    scope: 'scope' in raw ? raw.scope : 'local',
    repositories: 'repositories' in raw ? raw.repositories : [],
    errorReservations: 'errorReservations' in raw ? raw.errorReservations : [],
    extensions,
  });
  if (!parsed.success) return invalid(parsed.error);
  return { body: document.body, metadata: parsed.data };
};

/** Removes only the three well-formed binding fields; other milestone metadata is contractual. */
const sequenceMetadata = (document: ReturnType<typeof parseMilestones>) => {
  const raw = metadataOf(document);
  if (!('jg_skills' in raw)) return { metadata: raw, binding: null };
  const parsed = bindingSchema.safeParse(raw.jg_skills);
  if (!parsed.success) return invalid(parsed.error);
  const fields = metadataSchema.parse(raw.jg_skills);
  const extra = Object.fromEntries(
    Object.entries(fields).filter(([key]) => !Object.hasOwn(parsed.data, key)),
  );
  const metadata = Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'jg_skills'));
  if (Object.keys(extra).length) metadata.jg_skills = extra;
  return { metadata, binding: parsed.data };
};

/**
 * A skills binding is an observation to check, never HQ execution approval.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const observeSkillsBinding = (
  plan: string,
  sequence: ReturnType<typeof observeSequence> | null,
): IPlanStatus['skillsBinding'] => {
  if (sequence === null) return 'absent';
  const { binding } = sequence;
  if (!binding) return 'absent';
  const document = parsePlan(plan);
  const raw = metadataOf(document);
  const fingerprint = fingerprintPlan(plan, { excludeMetadataKeys: administrativeKeys });
  if (
    binding.plan_id !== raw.id ||
    binding.plan_revision !== raw.revision ||
    binding.plan_content_sha256 !== fingerprint.sha256 ||
    fingerprint.sha256 === null
  )
    return 'stale';
  return 'current';
};

/** Copies observed regions while omitting only explicit engine-provided spans. */
const retainRegions = (
  source: string,
  regions: ISourceSpan[],
  omissions: ISourceSpan[],
): string => {
  const removed = [...omissions].sort((a, b) => a.start - b.start);
  let result = '';
  let index = 0;
  for (const region of regions) {
    let offset = region.start;
    while (index < removed.length && removed[index]!.end <= offset) index++;
    while (index < removed.length && removed[index]!.start < region.end) {
      const omission = removed[index++]!;
      result += source.slice(offset, Math.max(offset, omission.start));
      offset = Math.max(offset, Math.min(region.end, omission.end));
    }
    result += source.slice(offset, region.end);
  }
  return result;
};

/**
 * HQ validates framing policy over the shared engine's observations, without another grammar.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const observeSequence = (source: string) => {
  const document = parseMilestones(source);
  const { metadata, binding } = sequenceMetadata(document);
  if (!document.milestones.length || document.milestones.length > 1024) return invalid();
  const ids = new Set<string>();
  let previous = 0;
  const entries = document.milestones.map((entry) => {
    const status = entry.statusMarkers[0];
    const identity = entry.idMarkers[0];
    const parsedStatus = z.enum(['pending', 'in progress', 'done']).safeParse(entry.status);
    const canonicalLine = (marker: typeof status, label: string) =>
      marker &&
      source.slice(marker.lineStart, marker.lineEnd).replace(/\r?\n$/, '') ===
        `**${label}:** ${marker.value}`;
    if (
      !entry.ordinal ||
      entry.ordinal <= previous ||
      entry.title.length > 4096 ||
      !entry.title ||
      !parsedStatus.success ||
      entry.statusMarkers.length !== 1 ||
      !canonicalLine(status, 'Status') ||
      source.slice(entry.headingEnd, status!.lineStart).trim() ||
      entry.idMarkers.length > 1 ||
      (identity &&
        (!canonicalLine(identity, 'Milestone ID') ||
          identity.lineStart !== status!.lineEnd ||
          !z.uuid().safeParse(identity.value).success))
    )
      return invalid();
    const id = identity?.value.toLowerCase() ?? null;
    if (id && ids.has(id)) return invalid();
    if (id) ids.add(id);
    previous = entry.ordinal;
    return {
      id,
      ordinal: entry.ordinal,
      title: entry.title,
      status: parsedStatus.data,
      contract: retainRegions(
        source,
        [{ start: entry.headingEnd, end: entry.end }],
        [status!, ...(identity ? [identity] : [])].map((marker) => ({
          start: marker.lineStart,
          end: marker.lineEnd,
        })),
      ),
    };
  });
  const starts = new Set(document.milestones.map((entry) => entry.location.offset));
  const shared = retainRegions(
    source,
    [
      document.preamble,
      ...document.sections
        .filter((section) => !starts.has(section.heading.start))
        .map((section) => ({ start: section.heading.start, end: section.body.end })),
    ],
    [
      ...(document.frontmatter ? [{ start: 0, end: document.frontmatter.end }] : []),
      ...document.overviewTables,
    ],
  );
  return { entries, shared, metadata, binding };
};

/**
 * Missing identities are assigned once by the engine, then persisted by HQ's journal.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const prepareSequenceIds = (source: string, expectedSha256: string): string => {
  try {
    return preparePlanDocumentWrite(source, {
      document: 'milestones',
      expectedSha256,
      source,
      assignMissingIds: true,
    }).source;
  } catch (cause) {
    return invalid(cause);
  }
};

/**
 * New requirements receive engine identities; exact verified correspondence retains its identity.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const prepareReconciliationIds = (source: string, retained: Map<number, string>): string => {
  const document = parseMilestones(source);
  const omissions = document.milestones.flatMap((entry) =>
    retained.has(entry.ordinal!)
      ? []
      : entry.idMarkers.map((marker) => ({ start: marker.lineStart, end: marker.lineEnd })),
  );
  let candidate = retainRegions(source, [{ start: 0, end: source.length }], omissions);
  try {
    if (retained.size)
      candidate = preparePlanUpdate(candidate, {
        document: 'milestones',
        changes: [...retained].map(([ordinal, id]) => ({ select: { ordinal }, set: { id } })),
      }).source;
    return preparePlanDocumentWrite(source, {
      document: 'milestones',
      expectedSha256: fingerprintSource(source),
      source: candidate,
      assignMissingIds: true,
    }).source;
  } catch (cause) {
    return invalid(cause);
  }
};

/**
 * Prepares only explicitly selected identity/progress markers, preserving all surrounding bytes.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const prepareSequenceMarkers = (
  source: string,
  drafts: { ordinal: number; id: string; status: 'pending' | 'in progress' | 'done' }[],
): string => {
  try {
    return preparePlanUpdate(source, {
      document: 'milestones',
      expectedSha256: fingerprintSource(source),
      changes: drafts.map(({ ordinal, id, status }) => ({
        select: { ordinal },
        set: { id, status },
      })),
    }).source;
  } catch (cause) {
    return invalid(cause);
  }
};
