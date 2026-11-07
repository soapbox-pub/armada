/**
 * A two-account Vector Community: the access-plane delivery Vector made to a
 * member it let into a Private Channel by a Role (CORD-03 §5), collected the way
 * `useChannelAccess` does, and the Guestbook's Timeouts and Nicknames (CORD-04 §8, §10).
 */
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import type { NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { openChatBatch } from "@/concord/lib/chat";
import { judgeCatchUp } from "@/concord/lib/catchUpAdoption";
import { isEntitled } from "@/concord/lib/channelAccess";
import { channelsView } from "@/concord/lib/community";
import { bundleToEntry } from "@/concord/hooks/useCommunityActions";
import { catchUpChannelIds, heldMembershipOf, parseDirectInviteRumor, unwrapDirectInvite } from "@/concord/lib/directInvite";
import { foldControlState, openControlWraps } from "@/concord/lib/control";
import { ledgerRestricted, postStands } from "@/concord/lib/writers";
import { accessPlane, deliveryTrusted, parseDelivery } from "@/concord/lib/delivery";
import { bytesToHex, controlGroupKey, guestbookGroupKey, hex32 } from "@/concord/lib/derive";
import { foldNicknames, foldTimeouts, openGuestbookWraps, timeoutRunning } from "@/concord/lib/guestbook";
import { canActOnMember, mayName, Permissions } from "@/concord/lib/roles";
import { base64ToBytes, decodeWrappedKey, myLocator } from "@/concord/lib/rekey";
import { openWrap } from "@/concord/lib/stream";
import type { InviteBundle } from "@/concord/lib/invite";
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

  it("entitles whoever Vector's fold lets View the Channel, as Vector's `is_entitled` does on ranked roles", () => {
    expect(isEntitled(folded.roster, folded.ownerHex, actors.member, actors.lounge)).toBe(true);
    expect(isEntitled(folded.roster, folded.ownerHex, "ab".repeat(32), actors.lounge)).toBe(false);
  });

  it("adopts the lounge key the owner vends to the member, without a click", () => {
    const lounge = members.vector.channels.find((ch) => ch.id === actors.lounge)!;
    const base = { root_epoch: c.root_epoch, community_root: c.root, control_pk: c.control_pk! };
    const held = heldMembershipOf({ current: { ...base, channels: [] } });
    const bundle = { ...base, channels: [{ id: lounge.id, key: lounge.key!, epoch: lounge.epoch, name: lounge.name }] };
    expect(judgeCatchUp(folded, actors.member, actors.owner, bundle, held)).toBe("adopt");
  });

  it("doesn't trust a delivery to someone the fold doesn't let in", () => {
    expect(deliveryTrusted(folded.roster, folded.ownerHex, folded.banned, actors.lounge, "ab".repeat(32), actors.owner)).toBe(false);
  });

  it("folds the owner's Timeout of the member and the Nicknames that count", () => {
    const gb = openGuestbookWraps(events, [guestbookGroupKey(hex32(c.root), hex32(c.id), BigInt(c.root_epoch))]);
    const now = Math.max(...gb.map((e) => e.ms)) + 1000;
    const timeouts = foldTimeouts(gb, {
      nowMs: now,
      ownerHex: folded.ownerHex,
      mayTimeout: (actor, target) => canActOnMember(folded.roster, actor, folded.ownerHex, target, Permissions.MODERATE_MEMBERS),
    });
    const t = timeouts.get(actors.member);
    expect(t?.by).toBe(actors.owner);
    expect(timeoutRunning(t, now)).toBe(true);
    expect(t!.until - t!.fromSecs).toBeLessThanOrEqual(3600);
    const nicknames = foldNicknames(gb, {
      nowMs: now,
      timeouts,
      mayName: (actor, target) => mayName(folded.roster, actor, folded.ownerHex, target),
    });
    expect(nicknames.get(actors.owner)).toBe("The Boss");
    // The member's own Nickname names nobody while their Timeout runs.
    expect(nicknames.has(actors.member)).toBe(false);
    expect(foldNicknames(gb, { nowMs: now, mayName: () => true }).get(actors.member)).toBe("Newbie");
  });

  it("reads the owner's post at the announcements writer address, certified, and refuses a forged one", async () => {
    expect(ledgerRestricted(folded.writers?.get(actors.announcements))).toBe(true);
    const held = { ...community, heldRoots: [{ epoch: BigInt(c.root_epoch), key: hex32(c.root) }], privateChannels: [], relays: [], name: "", ownerSalt: new Uint8Array(32) } as Community;
    const announcements = channelsView(held, folded).find((ch) => ch.idHex === actors.announcements)!;
    const writerStream = announcements.streams.find((st) => st.writer);
    expect(writerStream?.writer?.certifier).toBeDefined();
    const wraps = events.filter((e) => e.pubkey === writerStream!.group.pk);
    expect(wraps.length).toBeGreaterThan(0);
    const opened = await openChatBatch(wraps, announcements, { remember: false });
    const post = opened.find((m) => m.kind === 9)!;
    expect(post.content).toBe("welcome, read the rules");
    const ledger = folded.writers!.get(actors.announcements)!;
    expect(postStands(ledger, community.id, post)).toBe(true);
    // The member's own certificate would be another digest: borrowing the owner's fails.
    expect(postStands(ledger, community.id, { ...post, author: actors.member })).toBe(false);
  });
});

describe("the Direct Invites Vector sends (CORD-05 §6)", () => {
  const c = members.community;
  const sk = hex32(actors.member_secret);
  const signer = {
    nip44: {
      encrypt: async (pk: string, text: string) => nip44Encrypt(text, getConversationKey(sk, pk)),
      decrypt: async (pk: string, text: string) => nip44Decrypt(text, getConversationKey(sk, pk)),
    },
  };
  const read = controlGroupKey(hex32(c.root), hex32(c.id), BigInt(c.root_epoch));
  const events = members.events as unknown as NostrEvent[];
  const folded = foldControlState(
    openControlWraps(events, [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]),
    hex32(c.id),
    c.owner,
  );
  const bundles = async () => {
    const out: Array<{ bundle: InviteBundle; sender: string; at: number }> = [];
    for (const e of events.filter((e) => e.tags.some((t) => t[0] === "k" && t[1] === "3313"))) {
      const u = await unwrapDirectInvite(e, signer);
      const b = u && parseDirectInviteRumor(u.rumor.kind, u.rumor.content);
      if (b) out.push({ bundle: b, sender: u!.sender, at: u!.rumor.created_at });
    }
    return out.sort((a, b) => a.at - b.at);
  };

  it("joins on Vector's invite holding no Public Channel as a Private key", async () => {
    const [join] = await bundles();
    expect(join.bundle.channels.some((ch) => ch.key === c.root), "Vector lists Public Channels under the root").toBe(true);
    expect(bundleToEntry(join.bundle).current.channels).toEqual([]);
  });

  it("adopts the lounge key from Vector's grant vend, which also lists the Public Channels", async () => {
    const [join, vend] = await bundles();
    const held = heldMembershipOf(bundleToEntry(join.bundle));
    expect(catchUpChannelIds(held, vend.bundle)).toEqual([actors.lounge]);
    expect(judgeCatchUp(folded, actors.member, vend.sender, vend.bundle, held)).toBe("adopt");
  });
});
