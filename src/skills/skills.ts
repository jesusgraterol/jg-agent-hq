import { createHash } from 'node:crypto';
import { Exception } from 'jg-exception';
import { z } from 'zod';

import {
  SkillSchema,
  type IMessageInput,
  type INativeSkillInput,
  type ISkill,
  type ISkillPage,
  type ISkillPreview,
  type IProviderId,
} from '../contracts/index.js';
import type { IProviderSkills } from '../providers/index.js';
import type { createProviderRegistry, IBoundAgentProvider } from '../providers/registry/index.js';
import { resolveWorkspaceTarget } from '../runtime/state/index.js';
import { decodeHistoryCursor, encodeHistoryCursor } from '../sessions/index.js';
import type { IStore } from '../store/index.js';

const PositionSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  id: z.string().regex(/^[a-f0-9]{64}$/),
});
const digest = (input: object): string =>
  createHash('sha256').update(JSON.stringify(input)).digest('hex');

/** Produces an exact invocation from native metadata without loading the skill content. */
const toSkillPreview = (
  formatSkill: IBoundAgentProvider['formatSkill'],
  skill: ISkill | undefined,
  skillArguments: string,
): ISkillPreview => {
  if (!skill) return { state: 'missing', skill: null, text: null };
  if (!skill.isEnabled) return { state: 'disabled', skill, text: null };
  return {
    state: 'ready',
    skill,
    text: formatSkill(skill, skillArguments),
  };
};

/**
 * Reads bounded native inventories without interpreting skill files or installing workflows.
 * @returns Thread-scoped discovery, exact previews and explicit input preparation.
 */
export const createSkills = (
  registry: ReturnType<typeof createProviderRegistry>,
  store: IStore,
  roots: string[],
) => {
  const pending = new Map<
    string,
    Promise<{
      provider: IProviderId;
      inventory: IProviderSkills;
      formatSkill: IBoundAgentProvider['formatSkill'];
    }>
  >();
  /**
   * Coalesces a native metadata read and enforces the catalog budget before paging.
   * @returns Current metadata, or null when the native inventory cannot be used.
   * @throws
   * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
   * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
   */
  const scan = async (threadId: string) => {
    const thread = await store.getThread(threadId);
    if (!thread) return null;
    await resolveWorkspaceTarget(thread.workspaceRoot, roots);
    if (
      thread.ownership !== 'managed' ||
      !thread.runtimeEpoch ||
      !thread.nativeId ||
      thread.state === 'inactive'
    )
      return null;
    let operation = pending.get(threadId);
    if (!operation) {
      if (pending.size >= 32) return null;
      operation = (async () => {
        const adapter = await registry.get(thread.provider);
        return {
          provider: thread.provider,
          inventory: await adapter.readSkills(thread.nativeId!, thread.workspaceRoot),
          formatSkill: adapter.formatSkill,
        };
      })();
      pending.set(threadId, operation);
    }
    try {
      const { provider, inventory, formatSkill } = await operation;
      const skills: ISkill[] = inventory.skills.map((skill) =>
        SkillSchema.parse({ ...skill, id: digest([provider, skill.name, skill.path]) }),
      );
      skills.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      if (
        skills.some((skill, index) => index > 0 && skill.id === skills[index - 1]!.id) ||
        Buffer.byteLength(JSON.stringify(skills)) > 1_048_576
      )
        return null;
      return {
        provider,
        formatSkill,
        invocationPrefix: inventory.invocationPrefix,
        skills,
        unavailableCount: inventory.unavailableCount,
        observedAt: inventory.observedAt,
      };
    } catch {
      return null;
    } finally {
      if (pending.get(threadId) === operation) pending.delete(threadId);
    }
  };
  return {
    /** Stops new reads joining an observation started before a native change. */
    invalidate(): void {
      pending.clear();
    },
    /** Resolves one unambiguous native name from a single bounded inventory read.
     * @returns An exact preview, or an explicit missing/disabled/unavailable state.
     * @throws
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     */
    async previewName(
      threadId: string,
      name: string,
      skillArguments: string,
    ): Promise<ISkillPreview> {
      const result = await scan(threadId);
      if (!result) return { state: 'unavailable', skill: null, text: null };
      const matches = result.skills.filter((skill) => skill.name === name);
      if (matches.length > 1 || (!matches.length && result.unavailableCount))
        return { state: 'unavailable', skill: null, text: null };
      return toSkillPreview(result.formatSkill, matches[0], skillArguments);
    },
    /**
     * Pages the native inventory with a content revision guard; an inventory change invalidates continuation.
     * @returns One bounded page, or explicit unavailable state without a successful empty fallback.
     * @throws
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_CURSOR_INVALID: The HQ cursor does not match this request
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     */
    async list(command: {
      threadId: string;
      limit: number;
      cursor?: string;
      search?: string;
    }): Promise<ISkillPage> {
      const { cursor, ...filters } = command;
      const decoded = decodeHistoryCursor(cursor, filters);
      let position: z.infer<typeof PositionSchema> | null = null;
      if (decoded) {
        try {
          position = PositionSchema.parse(JSON.parse(decoded));
        } catch (cause) {
          throw new Exception('The HQ cursor does not match this request', {
            code: 'JG_AGENT_HQ_CURSOR_INVALID',
            data: { kind: 'invalid-request' },
            cause,
          });
        }
      }
      const result = await scan(command.threadId);
      if (!result)
        return {
          state: 'unavailable',
          invocationPrefix: null,
          observedAt: null,
          data: [],
          unavailableCount: 0,
          nextCursor: null,
        };
      const revision = digest([result.skills, result.unavailableCount]);
      if (position && position.digest !== revision)
        throw new Exception('The HQ cursor does not match this request', {
          code: 'JG_AGENT_HQ_CURSOR_INVALID',
          data: {
            kind: 'invalid-request',
          },
        });
      const query = command.search?.toLowerCase();
      const data = result.skills
        .filter(
          (skill) =>
            (!position || skill.id > position.id) &&
            (!query || `${skill.name}\n${skill.description}`.toLowerCase().includes(query)),
        )
        .slice(0, command.limit + 1);
      const hasMore = data.length > command.limit;
      if (hasMore) data.pop();
      const last = data.at(-1);
      return {
        state: result.unavailableCount ? 'partial' : 'available',
        invocationPrefix: result.invocationPrefix,
        observedAt: result.observedAt,
        data,
        unavailableCount: result.unavailableCount,
        nextCursor: encodeHistoryCursor(
          hasMore && last ? JSON.stringify({ digest: revision, id: last.id }) : null,
          filters,
        ),
      };
    },
    /**
     * Resolves an exact current selection and shows the native invocation without sending input.
     * @returns Ready, missing, disabled or unavailable state; never an inferred workflow.
     * @throws
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     */
    async preview(
      threadId: string,
      skillId: string,
      skillArguments: string,
    ): Promise<ISkillPreview> {
      const result = await scan(threadId);
      if (!result) return { state: 'unavailable', skill: null, text: null };
      const skill = result.skills.find((skill) => skill.id === skillId);
      return toSkillPreview(result.formatSkill, skill, skillArguments);
    },
    /**
     * Prepares one explicitly selected input while leaving skill contents and permissions native.
     * @returns Exact text and optional native skill selection for the existing action dispatcher.
     * @throws
     * - JG_AGENT_HQ_SKILL_UNAVAILABLE: The HQ skill is unavailable
     * - JG_AGENT_HQ_TARGET_FORBIDDEN: The HQ target is outside the allowed workspaces
     * - JG_AGENT_HQ_PROVIDER_FAILED: The HQ provider integration failed
     * - JG_AGENT_HQ_CAPABILITY_UNAVAILABLE: The HQ capability is unavailable
     * - JG_AGENT_HQ_STORE_FAILED: The HQ store failed
     */
    async prepare(
      threadId: string,
      input: IMessageInput | { kind: 'skill-name'; name: string; arguments: string },
    ): Promise<{ text: string; skill: INativeSkillInput | null }> {
      if (input.kind === 'text') return { text: input.text, skill: null };
      const preview =
        input.kind === 'skill-name'
          ? await this.previewName(threadId, input.name, input.arguments)
          : await this.preview(threadId, input.skillId, input.arguments);
      if (preview.state !== 'ready' || !preview.skill || !preview.text)
        throw new Exception('The HQ skill is unavailable', {
          code: 'JG_AGENT_HQ_SKILL_UNAVAILABLE',
          data: { kind: 'state-conflict' },
        });
      return { text: preview.text, skill: { name: preview.skill.name, path: preview.skill.path } };
    },
  };
};
