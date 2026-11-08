import { describe, expect, it } from "vitest";

import { sealChannelMetadata } from "@/concord/lib/channelSeal";
import { readChannelContent } from "@/concord/lib/control";
import { accessDeliveryAdmits, accessKeyRefuted, type AccessFold } from "@/concord/lib/delivery";
import { hex32 } from "@/concord/lib/derive";
import { EVERYONE_DEFAULT, Permissions, type Role } from "@/concord/lib/roles";

const OWNER = "aa".repeat(32);
const ADMIN = "bb".repeat(32);
const ME = "cc".repeat(32);
const PEER = "dd".repeat(32);
const STRANGER = "ef".repeat(32);
const CH = "ee".repeat(32);

const access: Role = { roleId: "access", name: "Readers", position: 9, permissions: 0n, scope: { kind: "server" }, color: 0 };
const staff: Role = { roleId: "staff", name: "Admin", position: 1, permissions: Permissions.MANAGE_CHANNELS, scope: { kind: "server" }, color: 0 };

const fold = (banned: string[] = []): AccessFold => ({
  ownerHex: OWNER,
  banned: new Set(banned),
  roster: {
    everyone: EVERYONE_DEFAULT,
    roles: [access, staff],
    overwrites: [{ scope: CH, target: { kind: "role", id: "access" }, allow: Permissions.VIEW_CHANNEL, deny: 0n }],
    grants: [
      { member: ME, roleIds: ["access"] },
      { member: PEER, roleIds: ["access"] },
      { member: ADMIN, roleIds: ["staff"] },
    ],
  },
});

const realKey = hex32("5".repeat(64));
const sealedAt = (epoch: bigint) => {
  const s = readChannelContent(sealChannelMetadata({ name: "general", private: true }, realKey, hex32(CH), epoch, undefined))!.sealed!;
  return { ...s, prevHex: undefined };
};

describe("accessDeliveryAdmits (CORD-03 §5)", () => {
  it("takes the sealed epoch from any trusted deliverer", () => {
    for (const from of [PEER, ADMIN, OWNER]) expect(accessDeliveryAdmits(fold(), sealedAt(3n), CH, ME, from, 3n)).toBe(true);
  });

  it("takes the epoch past the seal from the owner or a manager, and leaves a peer's for later", () => {
    expect(accessDeliveryAdmits(fold(), sealedAt(3n), CH, ME, OWNER, 4n)).toBe(true);
    expect(accessDeliveryAdmits(fold(), sealedAt(3n), CH, ME, ADMIN, 4n)).toBe(true);
    expect(accessDeliveryAdmits(fold(), sealedAt(3n), CH, ME, PEER, 4n)).toBe(false);
  });

  it("refuses an epoch outside the walk, an untrusted or banned deliverer, and a reader who can't view", () => {
    expect(accessDeliveryAdmits(fold(), sealedAt(3n), CH, ME, ADMIN, 2n)).toBe(false);
    expect(accessDeliveryAdmits(fold(), sealedAt(3n), CH, ME, ADMIN, 5n)).toBe(false);
    expect(accessDeliveryAdmits(fold(), sealedAt(3n), CH, ME, STRANGER, 3n)).toBe(false);
    expect(accessDeliveryAdmits(fold([PEER]), sealedAt(3n), CH, ME, PEER, 3n)).toBe(false);
    expect(accessDeliveryAdmits(fold(), sealedAt(3n), CH, STRANGER, ADMIN, 3n)).toBe(false);
  });

  it("walks from epoch 0 for an unsealed Channel, peers included", () => {
    expect(accessDeliveryAdmits(fold(), undefined, CH, ME, PEER, 0n)).toBe(true);
    expect(accessDeliveryAdmits(fold(), undefined, CH, ME, PEER, 1n)).toBe(true);
    expect(accessDeliveryAdmits(fold(), undefined, CH, ME, PEER, 2n)).toBe(false);
  });
});

describe("accessKeyRefuted", () => {
  it("refutes a key at the sealed epoch that doesn't open the seal, and nothing else", () => {
    expect(accessKeyRefuted(sealedAt(3n), CH, 3n, realKey)).toBe(false);
    expect(accessKeyRefuted(sealedAt(3n), CH, 3n, hex32("6".repeat(64)))).toBe(true);
    // Past the seal nothing can refute it; admission decides who is believed.
    expect(accessKeyRefuted(sealedAt(3n), CH, 4n, hex32("6".repeat(64)))).toBe(false);
    expect(accessKeyRefuted(undefined, CH, 0n, hex32("6".repeat(64)))).toBe(false);
  });
});
