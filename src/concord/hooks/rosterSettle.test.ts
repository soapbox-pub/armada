import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ folds: [] as unknown[], order: [] as string[] }));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  foldStoredControl: async () => {
    h.order.push("fold");
    return h.folds.shift();
  },
}));
vi.mock("@/hooks/useToast", () => ({ toast: () => undefined }));

import { emptySettleReport, registerRosterSettler, withKeySettle } from "@/concord/lib/keySettle";
import type { Community } from "@/concord/lib/types";

import { settledScope } from "./rosterSettle";

const community = { idHex: "c".repeat(64) } as Community;

describe("settledScope", () => {
  it("settles the write from the stored fold before it to the one after, inside the key settle", async () => {
    h.folds = ["before", "after"];
    h.order = [];
    const seen: unknown[] = [];
    const off = registerRosterSettler(community.idHex, async (before, after) => {
      seen.push(before, after);
      h.order.push("settle");
      return emptySettleReport();
    });
    // A duty's rotation asking for the lock meanwhile waits for the settle.
    const write = settledScope(community, async () => void h.order.push("write"));
    const duty = withKeySettle(community.idHex, async () => void h.order.push("duty"));
    const { report } = await write;
    await duty;
    off();
    expect(seen).toEqual(["before", "after"]);
    expect(h.order).toEqual(["fold", "write", "fold", "settle", "duty"]);
    expect(report).toEqual(emptySettleReport());
  });

  it("still writes with no settler mounted, and leaves the settle to the access duty", async () => {
    h.order = [];
    const { result, report } = await settledScope(community, async () => 7);
    expect(result).toBe(7);
    expect(report).toBeUndefined();
    expect(h.order).toEqual([]);
  });
});
