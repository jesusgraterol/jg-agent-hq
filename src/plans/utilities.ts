import { createHash } from 'node:crypto';
import { Exception } from 'jg-exception';
import { z } from 'zod';

import { PlanMetadataSchema, type IPlanRevision, type IPlanMilestone } from '../contracts/index.js';

import type { IParsedMilestone, IPlanContract } from './types.js';

/** Hashes exact bytes for inspection or a normalized execution-contract serialization. */
export const hashPlanContent = (content: string | Buffer): string =>
  createHash('sha256').update(content).digest('hex');

/** Keeps literal Markdown examples from becoming identity or structural markers. */
const fencedLines = (content: string): Set<number> => {
  const offsets = new Set<number>();
  let offset = 0;
  let fence: { character: string; length: number } | null = null;
  for (const line of content.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      offsets.add(offset);
      if (
        marker &&
        marker[1]![0] === fence.character &&
        marker[1]!.length >= fence.length &&
        !marker[2]!.trim()
      )
        fence = null;
    } else if (marker) {
      offsets.add(offset);
      fence = { character: marker[1]![0]!, length: marker[1]!.length };
    }
    offset += line.length + 1;
  }
  return offsets;
};

/** Visits only real derived tables, preserving prose and fenced examples. */
const transformOverviewTable = (content: string, transform: (table: string) => string): string => {
  const fenced = fencedLines(content);
  const headings = [...content.matchAll(/^## (.+)$/gm)].filter(
    (heading) => !fenced.has(heading.index),
  );
  const firstMilestone =
    headings.find((heading) => /^Milestone \d+: /.test(heading[1]!))?.index ?? content.length;
  let result = content;
  for (let index = headings.length - 1; index >= 0; index--) {
    const heading = headings[index]!;
    if (heading[1] !== 'Overview' || heading.index >= firstMilestone) continue;
    const end = headings[index + 1]?.index ?? content.length;
    const section = content
      .slice(heading.index, end)
      .replace(/^(?:\|[^\n]+\|[ \t]*\n)+/gm, (table, offset: number) => {
        if (fenced.has(heading.index + offset)) return table;
        const lines = table.trim().split('\n');
        const cells = (line: string) =>
          line
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim());
        if (
          JSON.stringify(cells(lines[0]!)) !== JSON.stringify(['Milestone', 'Name', 'Status']) ||
          cells(lines[1] ?? '').length !== 3 ||
          !cells(lines[1] ?? '').every((cell) => /^:?-{3,}:?$/.test(cell)) ||
          lines.slice(2).some((line) => {
            const row = cells(line);
            return (
              row.length !== 3 ||
              !/^\d+$/.test(row[0]!) ||
              !['pending', 'in progress', 'done'].includes(row[2]!)
            );
          })
        )
          return table;
        return transform(table);
      });
    result = result.slice(0, heading.index) + section + result.slice(end);
  }
  return result;
};

/**
 * Parses only the milestone framing. All requirement prose stays in the hashed contract.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const parsePlanMilestones = (content: string): IParsedMilestone[] => {
  const normalized = content.replace(/\r\n?/g, '\n');
  const fenced = fencedLines(normalized);
  const headings = [...normalized.matchAll(/^## Milestone (\d+): (.+)$/gm)].filter(
    (heading) => !fenced.has(heading.index),
  );
  if (!headings.length || headings.length > 1024)
    throw new Exception('The HQ plan is invalid', {
      code: 'JG_AGENT_HQ_PLAN_INVALID',
      data: { kind: 'invalid-request' },
    });
  const prelude = transformOverviewTable(normalized.slice(0, headings[0]!.index), () => '');
  const approval = [...normalized.matchAll(/^## Approval required[ \t]*$/gm)].find(
    (heading) => heading.index > headings.at(-1)!.index && !fenced.has(heading.index),
  );
  const sharedApproval = approval ? normalized.slice(approval.index) : '';
  const sharedDigest = hashPlanContent(JSON.stringify([prelude, sharedApproval]));
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  return headings.map((heading, index) => {
    const start = heading.index!;
    const following = headings[index + 1]?.index ?? normalized.length;
    // a final approval section belongs to the sequence, not to the final milestone
    const tail = normalized.slice(start, following);
    const block =
      approval && approval.index >= start && approval.index < following
        ? normalized.slice(start, approval.index)
        : tail;
    const status = /^\*\*Status:\*\* (pending|in progress|done)\n/m.exec(block);
    if (!status || !/^[ \t\n]*$/.test(block.slice(heading[0].length + 1, status.index)))
      throw new Exception('The HQ plan is invalid', {
        code: 'JG_AGENT_HQ_PLAN_INVALID',
        data: { kind: 'invalid-request' },
      });
    const markers = [...block.matchAll(/^[ \t]*\*\*Milestone ID:\*\*(.*)$/gm)].filter(
      (marker) => !fenced.has(start + marker.index),
    );
    let id: string | null = null;
    if (markers.length) {
      const marker = markers[0]!;
      const parsed = z.uuid().safeParse(marker[1]?.slice(1));
      if (
        markers.length !== 1 ||
        !marker[0].startsWith('**Milestone ID:** ') ||
        marker.index !== status.index + status[0].length ||
        !parsed.success
      )
        throw new Exception('The HQ plan is invalid', {
          code: 'JG_AGENT_HQ_PLAN_INVALID',
          data: { kind: 'invalid-request' },
        });
      id = parsed.data.toLowerCase();
      if (ids.has(id))
        throw new Exception('The HQ plan is invalid', {
          code: 'JG_AGENT_HQ_PLAN_INVALID',
          data: { kind: 'invalid-request' },
        });
      ids.add(id);
    }
    const ordinal = Number(heading[1]);
    if (!Number.isSafeInteger(ordinal) || ordinal <= 0 || ordinals.has(ordinal))
      throw new Exception('The HQ plan is invalid', {
        code: 'JG_AGENT_HQ_PLAN_INVALID',
        data: { kind: 'invalid-request' },
      });
    if (index > 0 && ordinal <= Number(headings[index - 1]![1]))
      throw new Exception('The HQ plan is invalid', {
        code: 'JG_AGENT_HQ_PLAN_INVALID',
        data: { kind: 'invalid-request' },
      });
    ordinals.add(ordinal);
    const title = heading[2]!;
    if (title.length > 4096)
      throw new Exception('The HQ plan is invalid', {
        code: 'JG_AGENT_HQ_PLAN_INVALID',
        data: { kind: 'invalid-request' },
      });
    // derived status and identity lines are excluded; every other byte is contractual
    const identityEnd = id
      ? markers[0]!.index + markers[0]![0].length
      : status.index + status[0].length;
    const contract = block.slice(id && block[identityEnd] === '\n' ? identityEnd + 1 : identityEnd);
    return {
      id,
      ordinal,
      title,
      status: status[1] as IParsedMilestone['status'],
      contract,
      contractDigest: id ? getMilestoneContractDigest({ id, title, sharedDigest, contract }) : null,
      sharedDigest,
      headingStart: start,
      statusEnd: start + status.index + status[0].length,
    };
  });
};

/**
 * Computes execution identity without administrative frontmatter, status lines or receipt files.
 * @throws
 * - JG_AGENT_HQ_PLAN_INVALID: The HQ plan is invalid
 */
export const computePlanRevision = (input: IPlanContract): IPlanRevision => {
  const parsed = PlanMetadataSchema.safeParse(input.metadata);
  if (
    !parsed.success ||
    new Set(input.metadata.repositories).size !== input.metadata.repositories.length
  )
    throw new Exception('The HQ plan is invalid', {
      code: 'JG_AGENT_HQ_PLAN_INVALID',
      data: { kind: 'invalid-request' },
      cause: parsed.error,
    });
  const metadata = {
    scope: parsed.data.scope,
    repositories: [...parsed.data.repositories].sort(),
    errorReservations: parsed.data.errorReservations
      .map((reservation) => ({
        repository: reservation.repository,
        namespace: reservation.namespace,
        start: reservation.start,
        end: reservation.end,
        registryPath: reservation.registryPath,
        purpose: reservation.purpose,
      }))
      .sort((left, right) => {
        const a = JSON.stringify(left),
          b = JSON.stringify(right);
        return a < b ? -1 : a > b ? 1 : 0;
      }),
  };
  const planDigest = hashPlanContent(
    JSON.stringify([input.body.replace(/\r\n?/g, '\n'), metadata]),
  );
  const milestones = input.milestones === null ? null : parsePlanMilestones(input.milestones);
  const breakdownDigest = milestones?.every((milestone) => milestone.id)
    ? hashPlanContent(
        JSON.stringify([
          planDigest,
          milestones.map((milestone) => [milestone.id, milestone.contractDigest]),
        ]),
      )
    : null;
  return { planDigest, breakdownDigest };
};

/** Compares the complete execution pair, never inspection hashes or mutable status. */
export const isSamePlanRevision = (left: IPlanRevision, right: IPlanRevision): boolean =>
  left.planDigest === right.planDigest && left.breakdownDigest === right.breakdownDigest;

/** Refreshes derived status cells without rewriting contract examples or adjacent prose. */
export const refreshPlanOverview = (content: string, milestones: IPlanMilestone[]): string => {
  const statuses = new Map(milestones.map((milestone) => [milestone.ordinal, milestone.status]));
  return transformOverviewTable(content, (table) =>
    table.replace(
      /^(\|\s*(\d+)\s*\|.*\|)\s*(?:pending|in progress|done)\s*\|$/gm,
      (line, prefix: string, ordinal: string) =>
        statuses.has(Number(ordinal)) ? `${prefix} ${statuses.get(Number(ordinal))} |` : line,
    ),
  );
};

/** Hashes a finalized milestone's complete requirement identity. */
export const getMilestoneContractDigest = (milestone: {
  id: string;
  title: string;
  sharedDigest: string;
  contract: string;
}): string =>
  hashPlanContent(
    JSON.stringify([milestone.id, milestone.title, milestone.sharedDigest, milestone.contract]),
  );
