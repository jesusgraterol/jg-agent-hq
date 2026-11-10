import type { IHistoryItem } from '../../contracts/index.js';

/*
 * An unfinished entry's turn ended before its provider finished it, as when an interrupt or a
 * Codex steer cuts a message the provider never saves.
 */
type ILiveEntry = { item: IHistoryItem; isComplete: boolean; isUnfinished: boolean; bytes: number };
type ILiveThread = {
  items: Map<string, ILiveEntry>;
  hasGap: boolean;
  revision: number;
  backgroundCommands: number;
};
// serialized accounting includes escaping/identifiers and leaves space inside the IPC frame
const MAX_LIVE_BYTES = 4 * 1024 * 1024;

/**
 * Keeps a bounded presentation window until matching native history has been flushed. Every
 * change takes a new revision and is reported.
 */
export class LiveItems {
  private readonly __threads = new Map<string, ILiveThread>();
  private readonly __onChange: () => void;
  private __bytes = 0;
  private __revision = 0;

  /** Reports each change, such as to wake the long-polls on live windows. */
  public constructor(onChange: () => void = () => undefined) {
    this.__onChange = onChange;
  }

  /** Starts a known presentation window without discarding retained awaiting-flush items. */
  public open(nativeId: string): void {
    if (this.__threads.has(nativeId)) return;
    if (this.__threads.size >= 32) this.__remove(this.__threads.keys().next().value!);
    this.__threads.set(nativeId, {
      items: new Map(),
      hasGap: false,
      revision: this.__change(),
      backgroundCommands: 0,
    });
  }

  /** Replaces one native item without persisting token or tool-output bodies. */
  public put(nativeId: string, item: IHistoryItem, isComplete: boolean): void {
    let thread = this.__threads.get(nativeId);
    if (!thread) {
      if (this.__threads.size >= 32) this.__remove(this.__threads.keys().next().value!);
      thread = {
        items: new Map(),
        hasGap: true,
        revision: this.__change(),
        backgroundCommands: 0,
      };
      this.__threads.set(nativeId, thread);
    }
    thread.revision = this.__change();
    const key = JSON.stringify([item.turnId, item.nativeId]);
    const previous = thread.items.get(key);
    if (previous) this.__bytes -= previous.bytes;
    const bytes = Buffer.byteLength(JSON.stringify({ ...item, state: 'awaiting-flush' }));
    thread.items.set(key, { item, isComplete, isUnfinished: false, bytes });
    this.__bytes += bytes;
    while (thread.items.size > 128) this.__drop(thread, thread.items.keys().next().value!);
    while (this.__bytes > MAX_LIVE_BYTES) {
      const candidate = [...this.__threads.values()].find((entry) => entry.items.size);
      if (!candidate) break;
      this.__drop(candidate, candidate.items.keys().next().value!);
    }
  }

  /** Records how many commands a session runs in the background, a change of its window. */
  public setBackgroundCommands(nativeId: string, count: number): void {
    this.open(nativeId);
    const thread = this.__threads.get(nativeId)!;
    if (thread.backgroundCommands === count) return;
    thread.backgroundCommands = count;
    thread.revision = this.__change();
  }

  /**
   * Reads how many commands a session runs in the background, as its provider last reported.
   * @param nativeId The session's key.
   * @returns The count, or 0 for a session without a window.
   */
  backgroundCommandsOf(nativeId: string): number {
    return this.__threads.get(nativeId)?.backgroundCommands ?? 0;
  }

  /**
   * Lists the sessions that run commands in the background.
   * @returns Their keys.
   */
  backgroundKeys(): string[] {
    return [...this.__threads].flatMap(([key, thread]) =>
      thread.backgroundCommands > 0 ? [key] : [],
    );
  }

  /** Marks missing native stream evidence without discarding the surviving presentation. */
  public markGap(nativeId: string): void {
    const thread = this.__threads.get(nativeId);
    if (thread) {
      thread.hasGap = true;
      thread.revision = this.__change();
    }
  }

  /** Publishes a new revision when ledger evidence can change retained items' provenance. */
  public invalidateProvenance(nativeId: string): void {
    const thread = this.__threads.get(nativeId);
    if (
      thread &&
      [...thread.items.values()].some(
        ({ item }) => item.kind === 'user-message' && item.provenance.nativeInputId !== null,
      )
    )
      thread.revision = this.__change();
  }

  /** Replaces an ephemeral stream identity when the native persisted identity arrives. */
  public replace(nativeId: string, turnId: string, itemId: string): void {
    const thread = this.__threads.get(nativeId);
    const key = JSON.stringify([turnId, itemId]);
    const entry = thread?.items.get(key);
    if (!thread || !entry) return;
    this.__bytes -= entry.bytes;
    thread.items.delete(key);
    thread.revision = this.__change();
  }

  /** Appends bounded text; a truncated prefix is never presented as the complete item. */
  public append(nativeId: string, turnId: string, itemId: string, delta: string): void {
    const thread = this.__threads.get(nativeId);
    const entry = thread?.items.get(JSON.stringify([turnId, itemId]));
    if (!entry || entry.isComplete) {
      if (thread) {
        thread.hasGap = true;
        thread.revision = this.__change();
      }
      return;
    }
    if (entry.item.isTruncated) return;
    const text = entry.item.text + delta;
    let end = Math.min(text.length, 65_536);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
    this.put(
      nativeId,
      {
        ...entry.item,
        text: text.slice(0, end),
        isTruncated: entry.item.isTruncated || end < text.length,
      },
      false,
    );
  }

  /** Returns a copy of the bounded window and explicit incompleteness evidence. */
  public read(
    nativeId: string,
    afterRevision?: number,
  ): {
    revision: number;
    unchanged: boolean;
    data: (IHistoryItem & { state: 'active' | 'awaiting-flush' })[];
    hasGap: boolean;
    backgroundCommands: number;
  } {
    const thread = this.__threads.get(nativeId);
    const revision = thread?.revision ?? this.__revision;
    return {
      revision,
      unchanged: afterRevision === revision,
      data:
        thread && afterRevision !== revision
          ? [...thread.items.values()].map((entry) => ({
              ...entry.item,
              state: entry.isComplete ? 'awaiting-flush' : 'active',
            }))
          : [],
      hasGap: thread?.hasGap ?? true,
      backgroundCommands: thread?.backgroundCommands ?? 0,
    };
  }

  /**
   * Drops completed items once persisted history holds them: with exactly matching normalized
   * content, or, for an item with an outcome, the same final outcome, since a provider can shorten
   * long output when it saves it, as Codex does. An item its turn ended before the provider
   * finished goes once persisted history holds that turn, which then shows what was saved of it.
   * A message saved under another record than the live input it came from, as Claude Code saves a
   * message sent while a turn ran, matches that input by the native input it names.
   */
  public reconcile(nativeId: string, persisted: IHistoryItem[]): void {
    const thread = this.__threads.get(nativeId);
    if (!thread) return;
    const turns = new Set(persisted.map((item) => item.turnId));
    for (const [key, entry] of thread.items)
      if (entry.isUnfinished && turns.has(entry.item.turnId)) {
        this.__bytes -= entry.bytes;
        thread.items.delete(key);
        thread.revision = this.__change();
      }
    for (const item of persisted) {
      const { nativeInputId } = item.provenance;
      const liveIds =
        item.kind === 'user-message' && nativeInputId !== null && nativeInputId !== item.nativeId
          ? [item.nativeId, nativeInputId]
          : [item.nativeId];
      for (const liveId of liveIds) {
        const key = JSON.stringify([item.turnId, liveId]);
        const entry = thread.items.get(key);
        if (
          entry?.isComplete &&
          (liveId === item.nativeId ||
            (item.provenance.nativeInputSha256 !== null &&
              entry.item.provenance.nativeInputId === nativeInputId &&
              entry.item.provenance.nativeInputSha256 === item.provenance.nativeInputSha256)) &&
          entry.item.nativeType === item.nativeType &&
          entry.item.kind === item.kind &&
          JSON.stringify(entry.item.asyncInput) === JSON.stringify(item.asyncInput) &&
          ((entry.item.text === item.text && entry.item.isTruncated === item.isTruncated) ||
            (item.outcome !== null && entry.item.outcome === item.outcome))
        ) {
          this.__bytes -= entry.bytes;
          thread.items.delete(key);
          thread.revision = this.__change();
        }
      }
    }
  }

  /**
   * Says whether a turn's window still holds a finished item no native history page has held.
   * @param nativeId The session's key.
   * @param turnId The native turn.
   * @returns Whether such an item remains.
   */
  public awaitsFlush(nativeId: string, turnId: string): boolean {
    const thread = this.__threads.get(nativeId);
    if (!thread) return false;
    for (const entry of thread.items.values())
      if (entry.isComplete && entry.item.turnId === turnId) return true;
    return false;
  }

  /** Keeps a turn's partial items available until native history holds the turn. */
  public completeTurn(nativeId: string, turnId: string): void {
    const thread = this.__threads.get(nativeId);
    if (!thread) return;
    thread.revision = this.__change();
    for (const entry of thread.items.values())
      if (entry.item.turnId === turnId && !entry.isComplete) {
        entry.isComplete = true;
        entry.isUnfinished = true;
      }
  }

  /** Releases one cached window when the bounded window collection must evict it. */
  private __remove(nativeId: string): void {
    const thread = this.__threads.get(nativeId);
    if (thread) for (const entry of thread.items.values()) this.__bytes -= entry.bytes;
    this.__threads.delete(nativeId);
    // a window without an entry reads the runtime's latest revision, which this changes
    this.__change();
  }

  /** Releases every retained body when the owning runtime has stopped. */
  public clear(): void {
    this.__threads.clear();
    this.__change();
    this.__bytes = 0;
  }

  /** Drops a window's oldest item when a bound requires it, which leaves a gap. */
  private __drop(thread: ILiveThread, key: string): void {
    const entry = thread.items.get(key);
    if (!entry) return;
    this.__bytes -= entry.bytes;
    thread.items.delete(key);
    thread.revision = this.__change();
    thread.hasGap = true;
  }

  /** Takes the next revision and reports the change. */
  private __change(): number {
    this.__revision += 1;
    this.__onChange();
    return this.__revision;
  }
}
