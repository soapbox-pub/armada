/**
 * The writer duty for Locked Channels (CORD-03 §1 at concord#27, Vector v0.5.2 `duty_for`):
 * locking or unlocking a restricted Channel takes a fresh epoch, and a Locked run's minter
 * seals it as it begins.
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import { foldControlState } from "@/concord/lib/control";
import { bytesToHex, random32, writersLocator } from "@/concord/lib/derive";
import { Permissions } from "@/concord/lib/roles";
import { overwriteLocator, overwriteToJSON } from "@/concord/lib/roster";
import { planWriterDuty, type WriterDutyInput } from "@/concord/lib/writerDuty";
import { rankedCommunity } from "@/test/concordEditions";

const T0 = 1_700_000_000_000;

function setup(locked: boolean, everyoneDenies: bigint) {
  const { c, base } = rankedCommunity(0n);
  const id = random32();
  const ch = bytesToHex(id);
  const o = { scope: ch, target: { kind: "everyone" as const }, allow: 0n, deny: everyoneDenies };
  const writer = bytesToHex(schnorr.getPublicKey(random32()));
  const certifier = bytesToHex(schnorr.getPublicKey(random32()));
  const entry = { at: T0, epoch: 1, writer, root: 0, by: c.owner, certifier, ...(locked ? { locked: true } : {}) };
  const folded = foldControlState([
    ...base,
    c.edition({ vsk: "2", eid: id, author: c.owner, content: { name: "rules", private: false } }),
    c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: c.owner, content: overwriteToJSON(o) }),
    c.edition({ vsk: "18", eid: writersLocator(c.id, hexToBytes(ch)), author: c.owner, createdAt: T0 / 1000, content: { channel: ch, ledger: [entry] } }),
  ], c.id, c.owner);
  const input = (o: Partial<WriterDutyInput> = {}): WriterDutyInput => ({
    control: folded,
    communityId: c.id,
    rootEpoch: 0,
    channelIdHex: ch,
    me: c.owner,
    members: new Set([c.owner]),
    candidates: [c.owner],
    deliveries: [],
    holdsLive: true,
    holdsCertifier: true,
    postableSince: Number.MAX_SAFE_INTEGER,
    walked: true,
    nowMs: T0 + 1000,
    due: () => true,
    sentWriter: new Set(),
    sentCertifier: new Set(),
    ...o,
  });
  return { c, ch, folded, input };
}

const NOTHING = Permissions.SEND_MESSAGES | Permissions.ADD_REACTIONS | Permissions.CONNECT;

describe("the writer duty for a Locked Channel", () => {
  it("mints a fresh epoch when the Roster locks a restricted Channel, or unlocks a Locked one", () => {
    expect(planWriterDuty(setup(false, NOTHING).input())).toMatchObject({ kind: "backstop", act: { kind: "mint", cut: [] }, lanes: [{ kind: "move" }] });
    expect(planWriterDuty(setup(true, Permissions.SEND_MESSAGES).input())).toMatchObject({ kind: "backstop", lanes: [{ kind: "move" }] });
    expect(planWriterDuty(setup(false, Permissions.SEND_MESSAGES).input()).kind).not.toBe("backstop");
  });

  it("has the run's minter seal it at once, another manager only an hour in", () => {
    const { input, c } = setup(true, NOTHING);
    expect(planWriterDuty(input())).toEqual({ kind: "seal", mine: true });
    const other = "ab".repeat(32);
    const asOther = { me: other, members: new Set([c.owner, other]), candidates: [c.owner, other] };
    // Not a manager: nothing to do.
    expect(planWriterDuty(input(asOther)).kind).not.toBe("seal");
    expect(planWriterDuty(input({ due: (l) => l.kind !== "seal" })).kind).not.toBe("seal");
  });
});
