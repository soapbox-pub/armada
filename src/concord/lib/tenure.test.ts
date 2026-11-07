/** What a Tenure seals, and in what order (CORD-04 §9, Vector `seal_standing`, `seal_order`). */
import { describe, expect, it } from "vitest";

import { foldControlState } from "@/concord/lib/control";
import { bytesToHex, random32 } from "@/concord/lib/derive";
import { overwriteLocator, overwriteToJSON, parseTenure, tenureToJSON } from "@/concord/lib/roster";
import { Permissions } from "@/concord/lib/roles";
import { planTenure } from "@/concord/lib/tenure";
import { hexKey, rankedCommunity } from "@/test/concordEditions";

/** The owner, an admin, and a moderator the admin granted, who decided a few things. */
function moderated() {
  const k = rankedCommunity(Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS | Permissions.SEND_MESSAGES);
  const { c, admin, grant } = k;
  const mod = hexKey();
  const modRole = hexKey();
  const role = c.role(modRole, "m", Permissions.MANAGE_CHANNELS | Permissions.MANAGE_ROLES | Permissions.SEND_MESSAGES);
  const modGrant = c.grant(mod, [modRole], { author: admin, cite: grant });
  const made = c.edition({ vsk: "2", eid: random32(), author: mod, cite: modGrant, content: { name: "theirs", private: false } });
  const gone = random32();
  const created = c.edition({ vsk: "2", eid: gone, author: c.owner, content: { name: "doomed", private: false } });
  const deletion = c.edition({ vsk: "2", eid: gone, author: mod, cite: modGrant, prev: created, content: { name: "doomed", private: false, deleted: true } });
  const o = { scope: bytesToHex(made.entityId), target: { kind: "everyone" as const }, allow: 0n, deny: Permissions.SEND_MESSAGES };
  const overwrite = c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: mod, cite: modGrant, content: overwriteToJSON(o) });
  return { ...k, mod, editions: [...k.base, role, modGrant, made, created, deletion, overwrite], made, deletion, overwrite };
}

const sealedHeads = (plan: ReturnType<typeof planTenure>) => {
  if (plan.kind !== "write") throw new Error(plan.kind);
  return parseTenure(plan.rumor.content)!.sealed.at(-1)!.heads;
};

describe("a Tenure's heads (Vector `seal_order`)", () => {
  it("lists the member's Channel and Category deletions first, then their authority heads, then the rest", () => {
    const { c, mod, editions, made, deletion, overwrite } = moderated();
    const folded = foldControlState(editions, c.id, c.owner);
    const heads = sealedHeads(planTenure(folded, c.id, c.owner, mod, true));
    expect(heads.map((h) => ({ [bytesToHex(deletion.selfHash)]: "del", [bytesToHex(overwrite.selfHash)]: "ow", [bytesToHex(made.selfHash)]: "made" })[h] ?? h)).toEqual(["del", "ow", "made"]);
  });

  it("leaves out a Tenure of theirs that seals an edition nobody has seen", () => {
    const { c, mod, editions } = moderated();
    const other = hexKey();
    const unseen = c.edition({ vsk: "16", eid: c.tenureEid(other, mod), author: mod, content: tenureToJSON(other, [{ rank: "z", permissions: 1n, heads: [hexKey()] }]) });
    const folded = foldControlState([...editions, unseen], c.id, c.owner);
    const served = new Set([...editions].map((e) => bytesToHex(e.selfHash)));
    const heads = sealedHeads(planTenure(folded, c.id, c.owner, mod, true, undefined, served));
    expect(heads).not.toContain(bytesToHex(unseen.selfHash));
  });
});

describe("whose standing a Tenure keeps (Vector `seal_standing`)", () => {
  it("owes nothing for a member who decided nothing, whatever they hold", () => {
    const { c, admin, base } = rankedCommunity(Permissions.MANAGE_ROLES);
    const [member, banRole] = [hexKey(), hexKey()];
    const role = c.role(banRole, "m", Permissions.BAN);
    const folded = foldControlState([...base, role, c.grant(member, [banRole], { author: c.owner })], c.id, c.owner);
    expect(planTenure(folded, c.id, admin, member, false).kind).toBe("none");
  });

  it("refuses to keep the decisions of a member holding a bit the sealer lacks", () => {
    const { c, admin, base } = rankedCommunity(Permissions.MANAGE_ROLES);
    const [member, banRole] = [hexKey(), hexKey()];
    const role = c.role(banRole, "m", Permissions.BAN | Permissions.MANAGE_CHANNELS);
    const memberGrant = c.grant(member, [banRole], { author: c.owner });
    const made = c.edition({ vsk: "2", eid: random32(), author: member, cite: memberGrant, content: { name: "theirs", private: false } });
    const folded = foldControlState([...base, role, memberGrant, made], c.id, c.owner);
    expect(planTenure(folded, c.id, admin, member, false)).toMatchObject({ kind: "refuse", reason: "unsealable" });
  });
});
