/**
 * The access-plane delivery Vector made to a member it let into a Private
 * Channel by a Role (CORD-03 §5), collected the way `useChannelAccess` does.
 */
import { decrypt as nip44Decrypt, getConversationKey } from "nostr-tools/nip44";
import type { NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { foldControlState, openControlWraps } from "@/concord/lib/control";
import { accessPlane, deliveryTrusted, parseDelivery } from "@/concord/lib/delivery";
import { bytesToHex, controlGroupKey, hex32 } from "@/concord/lib/derive";
import { base64ToBytes, decodeWrappedKey, myLocator } from "@/concord/lib/rekey";
import { openWrap } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";

import actors from "./fixtures/cord25/members.actors.json";
import members from "./fixtures/cord25/members.json";

describe("access-plane delivery (Vector fixture)", () => {
  const c = members.community;
  const community = {
    id: hex32(c.id),
    idHex: c.id,
    owner: c.owner,
    root: hex32(c.root),
    rootEpoch: BigInt(c.root_epoch),
  } as Community;
  const events = members.events as unknown as NostrEvent[];
  const read = controlGroupKey(hex32(c.root), hex32(c.id), BigInt(c.root_epoch));
  const editions = openControlWraps(events, [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]);
  const folded = foldControlState(editions, hex32(c.id), c.owner);

  it("opens the lounge key Vector delivered, from a deliverer the fold trusts", () => {
    const plane = accessPlane(community, hex32(actors.lounge));
    const deliveries = events
      .filter((e) => e.pubkey === plane.pk)
      .map((e) => parseDelivery(openWrap(e, plane)))
      .filter((d) => d?.form === "access");
    expect(deliveries.length).toBeGreaterThan(0);
    const d = deliveries[0]!;
    expect(deliveryTrusted(folded.roster, folded.ownerHex, folded.banned, actors.lounge, actors.member, d.deliverer)).toBe(true);
    const blob = d.blobs.find((b) => b.locator === myLocator(d.deliverer, actors.member, actors.lounge, d.newEpoch))!;
    const plain = nip44Decrypt(blob.wrapped, getConversationKey(hex32(actors.member_secret), d.deliverer));
    const key = decodeWrappedKey(base64ToBytes(plain), hex32(actors.lounge), d.newEpoch);
    const vector = members.vector.channels.find((ch) => ch.id === actors.lounge)!;
    expect(bytesToHex(key)).toBe(vector.key);
    expect(Number(d.newEpoch)).toBe(vector.epoch);
  });

  it("doesn't trust a delivery to someone the fold doesn't let in", () => {
    expect(deliveryTrusted(folded.roster, folded.ownerHex, folded.banned, actors.lounge, "ab".repeat(32), actors.owner)).toBe(false);
  });
});
