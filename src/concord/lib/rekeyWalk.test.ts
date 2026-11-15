import { describe, expect, it } from "vitest";

import type { FoldedControl } from "@/concord/lib/control";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import { EVERYONE_DEFAULT, Permissions } from "@/concord/lib/roles";
import { heldCommunity, hexKey, TestCommunity } from "@/test/concordEditions";

import { walkTargets } from "./rekeyWalk";

const ROLE = "cc".repeat(32);

function fold(owner: string, me: string, channels: Array<{ id: string; sealedAt?: bigint; letIn?: boolean; deleted?: boolean }>, banned: string[] = []): FoldedControl {
  return {
    ownerHex: owner,
    rankedRoster: true,
    banned: new Set(banned),
    roster: {
      everyone: EVERYONE_DEFAULT,
      roles: [{ roleId: ROLE, name: "r", position: 1, rank: "a", permissions: 0n, scope: { kind: "server" }, color: 0 }],
      grants: [{ member: me, roleIds: [ROLE] }],
      overwrites: channels.filter((c) => c.letIn !== false).map((c) => ({ scope: c.id, target: { kind: "role" as const, id: ROLE }, allow: Permissions.VIEW_CHANNEL, deny: 0n })),
    },
    channels: new Map(channels.map((c) => [c.id, { channelIdHex: c.id, isPrivate: true, deleted: !!c.deleted, metadata: { name: "", private: true }, ...(c.sealedAt !== undefined ? { sealed: { epoch: c.sealedAt, sealed: "x" } } : {}) }])),
  } as unknown as FoldedControl;
}

describe("walkTargets (Vector `follow_rekeys`)", () => {
  const c = new TestCommunity();
  const me = hexKey();

  it("walks a held Channel from the epoch after its key", () => {
    const id = random32();
    const [t] = walkTargets(heldCommunity(c, [{ id, key: random32(), epoch: 4n, name: "" }]), fold(c.owner, me, []), me, undefined);
    expect(t).toMatchObject({ idHex: bytesToHex(id), epoch: 4n, from: 5n });
  });

  it("walks a keyless Channel I may read from its sealed head's epoch", () => {
    const id = bytesToHex(random32());
    const [t] = walkTargets(heldCommunity(c), fold(c.owner, me, [{ id, sealedAt: 47n }]), me, undefined);
    expect(t).toMatchObject({ idHex: id, from: 47n, epoch: 46n });
    expect(t.key).toBeUndefined();
  });

  it("never walks below a cut", () => {
    const id = bytesToHex(random32());
    expect(walkTargets(heldCommunity(c), fold(c.owner, me, [{ id, sealedAt: 3n }]), me, [{ id, epoch: 9 }])[0].from).toBe(9n);
  });

  it("skips a Channel I may not read, a deleted or unsealed one, and everything once banned", () => {
    const [a, b, d] = [random32(), random32(), random32()].map(bytesToHex);
    const f = fold(c.owner, me, [{ id: a, sealedAt: 2n, letIn: false }, { id: b, sealedAt: 2n, deleted: true }, { id: d }]);
    expect(walkTargets(heldCommunity(c), f, me, undefined)).toEqual([]);
    expect(walkTargets(heldCommunity(c), fold(c.owner, me, [{ id: a, sealedAt: 2n }], [me]), me, undefined)).toEqual([]);
  });
});
