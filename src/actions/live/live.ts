import type { IHistoryItem } from '../../contracts/index.js';

type ILiveEntry = { item: IHistoryItem; isComplete: boolean; bytes: number };
type ILiveThread = { items: Map<string, ILiveEntry>; hasGap: boolean; revision: number };
// serialized accounting includes escaping/identifiers and leaves space inside the 8 MiB IPC frame
const MAX_LIVE_BYTES = 4 * 1024 * 1024;

/** Keeps a bounded presentation window until matching native history has been flushed. */
export class LiveItems {
  private readonly __threads = new Map<string, ILiveThread>();
  private __bytes = 0;
  private __revision = 0;

  /** Starts a known presentation window without discarding retained awaiting-flush items. */
  public open(nativeId: string): void {
    if (this.__threads.has(nativeId)) return;
    if (this.__threads.size >= 32) this.__remove(this.__threads.keys().next().value!);
    this.__threads.set(nativeId, { items: new Map(), hasGap: false, revision: ++this.__revision });
  }

  /** Replaces one native item without persisting token or tool-output bodies. */
  public put(nativeId: string, item: IHistoryItem, isComplete: boolean): void {
    let thread = this.__threads.get(nativeId);
    if (!thread) {
      if (this.__threads.size >= 32) this.__remove(this.__threads.keys().next().value!);
      thread = { items: new Map(), hasGap: true, revision: ++this.__revision };
      this.__threads.set(nativeId, thread);
    }
    thread.revision = ++this.__revision;
    const key = JSON.stringify([item.turnId, item.nativeId]);
    const previous = thread.items.get(key);
    if (previous) this.__bytes -= previous.bytes;
    const bytes = Buffer.byteLength(JSON.stringify({ ...item, state: 'awaiting-flush' }));
    thread.items.set(key, { item, isComplete, bytes });
    this.__bytes += bytes;
    while (thread.items.size > 128) this.__drop(thread, thread.items.keys().next().value!);
    while (this.__bytes > MAX_LIVE_BYTES) {
      const candidate = [...this.__threads.values()].find((entry) => entry.items.size);
      if (!candidate) break;
      this.__drop(candidate, candidate.items.keys().next().value!);
    }
  }

  /** Clears a reverted presentation and requires a fresh native history read. */
  public reset(nativeId: string): void {
    this.__remove(nativeId);
    this.open(nativeId);
    this.markGap(nativeId);
  }

  /** Marks missing native stream evidence without discarding the surviving presentation. */
  public markGap(nativeId: string): void {
    const thread = this.__threads.get(nativeId);
    if (thread) {
      thread.hasGap = true;
      thread.revision = ++this.__revision;
    }
  }

  /** Replaces an ephemeral stream identity when the native persisted identity arrives. */
  public replace(nativeId: string, turnId: string, itemId: string): void {
    const thread = this.__threads.get(nativeId);
    const key = JSON.stringify([turnId, itemId]);
    const entry = thread?.items.get(key);
    if (!thread || !entry) return;
    this.__bytes -= entry.bytes;
    thread.items.delete(key);
    thread.revision = ++this.__revision;
  }

  /** Appends bounded text; a truncated prefix is never presented as the complete item. */
  public append(nativeId: string, turnId: string, itemId: string, delta: string): void {
    const thread = this.__threads.get(nativeId);
    const entry = thread?.items.get(JSON.stringify([turnId, itemId]));
    if (!entry || entry.isComplete) {
      if (thread) {
        thread.hasGap = true;
        thread.revision = ++this.__revision;
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
    };
  }

  /** Drops completed items only after their normalized persisted content matches exactly. */
  public reconcile(nativeId: string, persisted: IHistoryItem[]): void {
    const thread = this.__threads.get(nativeId);
    if (!thread) return;
    for (const item of persisted) {
      const key = JSON.stringify([item.turnId, item.nativeId]);
      const entry = thread.items.get(key);
      if (entry?.isComplete && JSON.stringify(entry.item) === JSON.stringify(item)) {
        this.__bytes -= entry.bytes;
        thread.items.delete(key);
        thread.revision = ++this.__revision;
      }
    }
  }

  /** Keeps interrupted partial items available while their final native history is pending. */
  public completeTurn(nativeId: string, turnId: string): void {
    const thread = this.__threads.get(nativeId);
    if (thread) thread.revision = ++this.__revision;
    if (thread)
      for (const entry of thread.items.values())
        if (entry.item.turnId === turnId) entry.isComplete = true;
  }

  /** Releases one cached window when the bounded window collection must evict it. */
  private __remove(nativeId: string): void {
    const thread = this.__threads.get(nativeId);
    if (thread) for (const entry of thread.items.values()) this.__bytes -= entry.bytes;
    this.__threads.delete(nativeId);
    this.__revision += 1;
  }

  /** Releases every retained body when the owning runtime has stopped. */
  public clear(): void {
    this.__threads.clear();
    this.__revision += 1;
    this.__bytes = 0;
  }

  private __drop(thread: ILiveThread, key: string): void {
    const entry = thread.items.get(key);
    if (!entry) return;
    this.__bytes -= entry.bytes;
    thread.items.delete(key);
    thread.revision = ++this.__revision;
    thread.hasGap = true;
  }
}
