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

export function settleBook(communityIdHex: string) {
  const key = `c2settle:${communityIdHex}`;
  let running = false;
  let all = false;
  let read: FoldedControl | undefined;
  let runAll = false;
  let pending: FoldedControl | undefined;
  let pendingAll = false;

  const persist = async (before: FoldedControl) => {
    if ((await readFolded<FoldedControl>(key)) === undefined) await writeFolded(key, before);
  };

  return {
    /** Owe a settle from `before`, or of everything when there is none. */
    async owe(before: FoldedControl | undefined): Promise<void> {
      if (running) {
        if (before) pending ??= before;
        else pendingAll = true;
        return;
      }
      if (before) await persist(before);
      else all = true;
    },
    async begin(): Promise<SettleRun> {
      running = true;
      runAll = all;
      all = false;
      read = await readFolded<FoldedControl>(key);
      return { settle: runAll || read !== undefined, ...(runAll || !read ? {} : { from: read }) };
    },
    /** Close a pass; true when a change made during it still owes one. */
    async end(settled: boolean): Promise<boolean> {
      running = false;
      if (settled) {
        if (read) await deleteFolded(key);
      } else if (runAll) {
        all = true;
      }
      read = undefined;
      runAll = false;
      const again = pending !== undefined || pendingAll;
      if (pending) await persist(pending);
      if (pendingAll) all = true;
      pending = undefined;
      pendingAll = false;
      return again;
    },
  };
}
