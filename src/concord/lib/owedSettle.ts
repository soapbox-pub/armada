/**
 * A key and writer settle owed until a whole read lands (CORD-03 §5, Vector
 * `owe_settle` / `run_owed_settle`). The Control fold a Roster change started from
 * is kept, the earliest one, across failed reads and restarts, and cleared only
 * once a pass settles against a whole read. A change made while a pass runs is
 * owed on its own after it.
 */

import type { FoldedControl } from "@/concord/lib/control";
import { deleteFolded, readFolded, writeFolded } from "@/lib/foldedCache";

export interface SettleRun {
  /** Whether this pass settles a change. */
  settle: boolean;
  /** The fold to settle from; absent settles everything. */
  from?: FoldedControl;
}

/** What is kept for a settle owed of everything, which covers any fold one could start from. */
const EVERYTHING = { everything: true } as const;
type Owed = FoldedControl | typeof EVERYTHING;
const isEverything = (o: Owed | undefined): o is typeof EVERYTHING => (o as { everything?: unknown } | undefined)?.everything === true;

export function settleBook(communityIdHex: string) {
  const key = `c2settle:${communityIdHex}`;
  let running = false;
  let read: Owed | undefined;
  let pending: FoldedControl | undefined;
  let pendingAll = false;

  const persist = async (before: FoldedControl) => {
    if ((await readFolded<Owed>(key)) === undefined) await writeFolded(key, before);
  };
  const persistAll = () => writeFolded(key, EVERYTHING);

  return {
    /** Owe a settle from `before`, or of everything when there is none. */
    async owe(before: FoldedControl | undefined): Promise<void> {
      if (running) {
        if (before) pending ??= before;
        else pendingAll = true;
        return;
      }
      if (before) await persist(before);
      else await persistAll();
    },
    async begin(): Promise<SettleRun> {
      running = true;
      read = await readFolded<Owed>(key);
      return { settle: read !== undefined, ...(read && !isEverything(read) ? { from: read } : {}) };
    },
    /** Close a pass; true when a change made during it still owes one. */
    async end(settled: boolean): Promise<boolean> {
      running = false;
      if (settled && read !== undefined) await deleteFolded(key);
      read = undefined;
      const again = pending !== undefined || pendingAll;
      if (pendingAll) await persistAll();
      else if (pending) await persist(pending);
      pending = undefined;
      pendingAll = false;
      return again;
    },
  };
}
