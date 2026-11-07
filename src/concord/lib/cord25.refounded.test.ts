/**
 * A Community Vector refounded (CORD-06 §3, as making it Private does), then gave
 * a voice Channel and a text Channel: a device of the owner's that still holds
 * epoch 0 must adopt the new root from Vector's rotation and then fold the
 * Channels Vector made after it.
 */
import type { NostrEvent } from "@nostrify/nostrify";
import { hexToBytes } from "@noble/hashes/utils.js";
import { decrypt as nip44Decrypt, getConversationKey } from "nostr-tools/nip44";
import { describe, expect, it } from "vitest";

import { channelsView } from "@/concord/lib/community";
import { foldControlState, openControlWraps } from "@/concord/lib/control";
import { baseRekeyGroupKey, bytesToHex, controlGroupKey, hex32, type StreamKeyView } from "@/concord/lib/derive";
import { base64ToBytes, checkContinuity, decodeWrappedBaseKey, findBlob, groupRotations, myLocator, parseRekey, type ParsedRekey } from "@/concord/lib/rekey";
import { openWrap } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";

import extra from "./fixtures/cord25/refounded.extra.json";
import fixture from "./fixtures/cord25/refounded.json";

const f = fixture as unknown as {
  community: { id: string; owner: string; root: string; root_epoch: number; control_pk: string | null };
  events: NostrEvent[];
  vector: { channels: Array<{ id: string; name: string; private: boolean; extra: Record<string, unknown> }> };
};
const x = extra as { owner_sk: string; epoch0: { root: string; root_epoch: number; control_pk: string | null } };

const cid = hex32(f.community.id);

function view(root: string, epoch: number, controlPk: string | null): StreamKeyView {
  const read = controlGroupKey(hex32(root), cid, BigInt(epoch));
  return controlPk ? { pk: controlPk, get convKey() { return read.convKey; }, restricted: true } : read;
}

function held(root: string, epoch: number, controlPk: string | null): Community {
  return {
    id: cid,
    idHex: f.community.id,
    owner: f.community.owner,
    ownerSalt: new Uint8Array(32),
    root: hex32(root),
    rootEpoch: BigInt(epoch),
    ...(controlPk ? { controlPk } : {}),
    heldRoots: [{ epoch: BigInt(epoch), key: hex32(root), ...(controlPk ? { controlPk } : {}) }],
    privateChannels: [],
    relays: [],
    name: "",
  };
}

describe("a Community Vector refounded (CORD-06 §3)", () => {
  it("is past epoch 0", () => {
    expect(f.community.root_epoch).toBe(1);
    expect(x.epoch0.root_epoch).toBe(0);
  });

  it("the owner's other device adopts Vector's new root from the rotation", () => {
    const sk = hexToBytes(x.owner_sk);
    const folded0 = foldControlState(openControlWraps(f.events, [view(x.epoch0.root, 0, x.epoch0.control_pk)]), cid, f.community.owner);
    const address = baseRekeyGroupKey(hex32(x.epoch0.root), cid, 1n);
    const parsed: ParsedRekey[] = [];
    for (const w of f.events.filter((e) => e.pubkey === address.pk)) {
      try {
        parsed.push(parseRekey(openWrap(w, address)));
      } catch {
        // not a rekey
      }
    }
    const sets = groupRotations(parsed).filter((s) => s.scopeIdHex === "0".repeat(64) && s.rotator === folded0.ownerHex && checkContinuity(s, 0n, hex32(x.epoch0.root)).ok);
    expect(sets.length).toBe(1);
    const set = sets[0];
    expect(set.complete).toBe(true);
    const blob = findBlob(set, myLocator(set.rotator, f.community.owner, set.scopeIdHex, 1n));
    expect(blob, "a blob for the owner").toBeDefined();
    const plain = nip44Decrypt(blob!.wrapped, getConversationKey(sk, set.rotator));
    const wrapped = decodeWrappedBaseKey(base64ToBytes(plain), cid, 1n);
    expect(bytesToHex(wrapped.newRoot)).toBe(f.community.root);
    expect(wrapped.controlPk ?? null).toBe(f.community.control_pk);
  });

  it("then folds every Channel Vector holds, the voice one and the one made after included", () => {
    // As the device folds it: anchored on the epoch's snapshot, floored by what it folded at epoch 0.
    const folded0 = foldControlState(openControlWraps(f.events, [view(x.epoch0.root, 0, x.epoch0.control_pk)]), cid, f.community.owner);
    const editions = openControlWraps(f.events, [view(f.community.root, 1, f.community.control_pk)]);
    const snapshot = new Set(editions.map((e) => bytesToHex(e.rumorId)));
    const folded = foldControlState(editions, cid, f.community.owner, new Map(folded0.heads), snapshot);
    const shown = channelsView(held(f.community.root, 1, f.community.control_pk), folded);
    for (const ch of f.vector.channels) {
      const mine = shown.find((c) => c.idHex === ch.id);
      expect(mine?.name, ch.name).toBe(ch.name);
      expect(mine?.view, ch.name).toBe(ch.extra.view ?? "chat");
    }
  });
});
