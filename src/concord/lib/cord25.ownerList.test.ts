/**
 * The owner's other device: a Community Vector switched to ranked roles, its
 * Channels made private and a private voice Channel added, rebuilt from nothing
 * but the Community List Vector published for the owner (CORD-02 §8), as a fresh
 * Armada install does, then folded and rendered.
 */
import type { NostrEvent } from "@nostrify/nostrify";
import { hexToBytes } from "@noble/hashes/utils.js";
import { decrypt as nip44Decrypt, getConversationKey } from "nostr-tools/nip44";
import { getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { channelsView, visibleChannels } from "@/concord/lib/community";
import { liveEntries, rehydrateCommunity } from "@/concord/lib/communityList";
import { controlGroups, foldControlState, openControlWraps } from "@/concord/lib/control";
import { bytesToHex } from "@/concord/lib/derive";
import { defragment, parseFragList } from "@/concord/lib/listFrag";

import extra from "./fixtures/cord25/owner_list.extra.json";
import fixture from "./fixtures/cord25/owner_list.json";

const f = fixture as unknown as {
  community: { id: string; owner: string };
  events: NostrEvent[];
  vector: { channels: Array<{ id: string; name: string; private: boolean; key: string | null; epoch: number; extra: Record<string, unknown> }> };
};
const sk = hexToBytes((extra as { owner_sk: string }).owner_sk);
const me = getPublicKey(sk);

function ownersList() {
  const ck = getConversationKey(sk, me);
  const frags = f.events.filter((e) => e.kind === 33302 && e.pubkey === me).map((e) => parseFragList(nip44Decrypt(e.content, ck)));
  return defragment(frags);
}

describe("the owner's device rebuilt from Vector's Community List (CORD-02 §8)", () => {
  it("holds every Private Channel key Vector's owner holds, at its epoch", () => {
    const entry = liveEntries(ownersList()).find((e) => e.community_id === f.community.id);
    expect(entry, "the Community is on the owner's List").toBeDefined();
    const community = rehydrateCommunity(entry!)!;
    const held = new Map(community.privateChannels.map((k) => [bytesToHex(k.id), k]));
    for (const ch of f.vector.channels.filter((c) => c.private)) {
      expect(held.get(ch.id), `key for ${ch.name}`).toBeDefined();
      expect(bytesToHex(held.get(ch.id)!.key), `key for ${ch.name}`).toBe(ch.key);
      expect(held.get(ch.id)!.epoch, `epoch for ${ch.name}`).toBe(BigInt(ch.epoch));
    }
  });

  it("shows the owner every Channel Vector holds, the private voice one included", () => {
    const entry = liveEntries(ownersList()).find((e) => e.community_id === f.community.id)!;
    const community = rehydrateCommunity(entry)!;
    const folded = foldControlState(openControlWraps(f.events, controlGroups(community)), community.id, community.owner);
    expect(folded.rankedRoster).toBe(true);
    const shown = visibleChannels(channelsView(community, folded), folded, me);
    expect(shown.map((c) => [c.name, c.view, c.isPrivate]).sort()).toEqual(
      f.vector.channels.map((c) => [c.name, (c.extra.view as string | undefined) ?? "chat", c.private]).sort(),
    );
  });
});
