import { deleteFolded, listFoldedKeys, readFolded, writeFolded } from "@/lib/foldedCache";

/**
 * Bounds a family of per-conversation snapshots (a channel's timeline, a DM thread):
 * each is tens of KB, and one per conversation ever opened grew without end. The
 * index lists the most recently persisted first; past `cap`, the oldest are deleted.
 */
export class SnapshotLru {
  private order: string[] | undefined;
  private loading: Promise<string[]> | undefined;
  private chain: Promise<void> = Promise.resolve();

  /** `indexKey` must not start with `prefix`, the snapshots' own key prefix. */
  constructor(private readonly prefix: string, private readonly indexKey: string, private readonly cap: number) {}

  /** Record `key` as just persisted, deleting whatever falls past the cap. */
  touch(key: string): Promise<void> {
    this.chain = this.chain.then(async () => {
      const order = await this.load();
      if (order[0] === key && order.length <= this.cap) return;
      const next = [key, ...order.filter((k) => k !== key)];
      const evicted = next.splice(this.cap);
      this.order = next;
      await Promise.all(evicted.map((k) => deleteFolded(k)));
      await writeFolded(this.indexKey, next);
    }).catch(() => undefined);
    return this.chain;
  }

  /** Forget the in-memory index (logout); the next touch reads the stored one. */
  reset(): void {
    this.order = undefined;
    this.loading = undefined;
    this.chain = Promise.resolve();
  }

  private load(): Promise<string[]> {
    if (this.order) return Promise.resolve(this.order);
    this.loading ??= readFolded<string[]>(this.indexKey).then(async (stored) => {
      // No index yet: adopt the snapshots written before there was one, oldest to go first.
      this.order = Array.isArray(stored)
        ? stored.filter((k): k is string => typeof k === "string")
        : await listFoldedKeys(this.prefix).catch(() => []);
      return this.order;
    });
    return this.loading;
  }
}
