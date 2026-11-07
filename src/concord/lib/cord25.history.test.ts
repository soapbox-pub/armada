/**
 * Read Message History against Vector (CORD-03 §5): a Private Channel with an earlier
 * epoch, and two members let in after its rotation, one denied history there. Vector's
 * access duty delivered the reader the key and the earlier epoch read-only, and let
 * the other in by a fresh epoch. Armada takes what it was handed and reads the past.
 */
import { IDBFactory } from "fake-indexeddb";
import { decrypt as nip44Decrypt, encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import type { NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { openChatBatch } from "@/concord/lib/chat";
import { channelsView } from "@/concord/lib/community";
import { openChannelSeal, resealedChannelContent } from "@/concord/lib/channelSeal";
import { foldControlState, openControlWraps, readChannelContent } from "@/concord/lib/control";
import { accessPlane, buildAccessDeliveries, buildHistoryDeliveries, deliveryTrusted, parseDelivery } from "@/concord/lib/delivery";
import { accessCandidates, mintingRotations, planChannelDuty, rotationRecipients } from "@/concord/lib/accessDuty";
import { bytesToHex, channelGroupKey, channelRekeyGroupKey, controlGroupKey, hex32 } from "@/concord/lib/derive";
import { adoptHistoryDeliveries, decodeHistoryPlaintext, heldHistoryViews, historyLocator, historyViewsReady, parseHistoryDelivery } from "@/concord/lib/history";
import { KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { base64ToBytes, decodeWrappedKey, findBlob, groupRotations, myLocator, parseRekey } from "@/concord/lib/rekey";
import { channelPermissions, Permissions } from "@/concord/lib/roles";
import { openWrap } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";

import actors from "./fixtures/cord25/history.actors.json";
import fixture from "./fixtures/cord25/history.json";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const c = fixture.community;
const base = {
  id: hex32(c.id),
  idHex: c.id,
  owner: c.owner,
  root: hex32(c.root),
  rootEpoch: BigInt(c.root_epoch),
  heldRoots: [{ epoch: BigInt(c.root_epoch), key: hex32(c.root) }],
  relays: [],
  name: "",
  ownerSalt: new Uint8Array(32),
};
const events = fixture.events as unknown as NostrEvent[];
const read = controlGroupKey(hex32(c.root), hex32(c.id), BigInt(c.root_epoch));
const folded = foldControlState(openControlWraps(events, [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]), hex32(c.id), c.owner);
const plane = accessPlane({ ...base, privateChannels: [] } as Community, hex32(actors.channel));
const opened = events.filter((e) => e.pubkey === plane.pk).map((e) => openWrap(e, plane));
const decryptAs = (secretHex: string) => async (pk: string, wrapped: string) => nip44Decrypt(wrapped, getConversationKey(hex32(secretHex), pk));

describe("Read Message History (Vector fixture)", () => {
  it("hands the reader the key on the access plane, and the earlier epoch only as history", async () => {
    const key = opened.map(parseDelivery).find((d) => d?.form === "access" && d.blobs.some((b) => b.locator === myLocator(d.deliverer, actors.reader, actors.channel, d.newEpoch)))!;
    expect(Number(key.newEpoch)).toBe(actors.epoch_before_duty);
    expect(deliveryTrusted(folded.roster, folded.ownerHex, folded.banned, actors.channel, actors.reader, key.deliverer)).toBe(true);
    const history = opened.flatMap((o) => parseHistoryDelivery(o, actors.channel) ?? []);
    expect(history.map((d) => Number(d.epoch))).toEqual([actors.first_epoch]);
    expect(history[0].blobs.some((b) => b.locator === historyLocator(history[0].deliverer, actors.reader, actors.channel, history[0].epoch))).toBe(true);
    expect(history[0].blobs.some((b) => b.locator === historyLocator(history[0].deliverer, actors.denied, actors.channel, history[0].epoch))).toBe(false);
  });

  it("reads the earlier epoch's message through the view it adopted, never its secret", async () => {
    await historyViewsReady();
    const key = opened.map(parseDelivery).find((d) => d?.form === "access" && d.blobs.some((b) => b.locator === myLocator(d.deliverer, actors.reader, actors.channel, d.newEpoch)))!;
    const blob = key.blobs.find((b) => b.locator === myLocator(key.deliverer, actors.reader, actors.channel, key.newEpoch))!;
    const chKey = decodeWrappedKey(base64ToBytes(await decryptAs(actors.reader_secret)(key.deliverer, blob.wrapped)), hex32(actors.channel), key.newEpoch);
    const community = { ...base, privateChannels: [{ id: hex32(actors.channel), key: chKey, epoch: key.newEpoch, name: "" }] } as Community;

    const before = channelsView(community, folded).find((ch) => ch.idHex === actors.channel)!;
    const at = (ch: typeof before) => events.filter((e) => ch.streams.some((s) => s.group.pk === e.pubkey));
    expect((await openChatBatch(at(before), before, { remember: false })).map((m) => m.content).filter((t) => t)).toEqual(["later"]);

    const taken = await adoptHistoryDeliveries(opened.flatMap((o) => parseHistoryDelivery(o, actors.channel) ?? []), {
      communityIdHex: c.id,
      channelIdHex: actors.channel,
      me: actors.reader,
      currentEpoch: key.newEpoch,
      heldEpochs: new Set(),
      trusted: (pk) => pk === folded.ownerHex || (channelPermissions(folded.roster, folded.ownerHex, pk, actors.channel, true) & Permissions.VIEW_CHANNEL) !== 0n,
      decrypt: decryptAs(actors.reader_secret),
    });
    expect(taken).toBe(1);
    expect(heldHistoryViews(c.id, actors.channel).map((v) => Number(v.epoch))).toEqual([actors.first_epoch]);
    const after = channelsView(community, folded).find((ch) => ch.idHex === actors.channel)!;
    const texts = (await openChatBatch(at(after), after, { remember: false })).map((m) => m.content).filter((t) => t);
    expect(texts.sort()).toEqual(["early", "later"]);
    // Read-only: the history stream signs nothing.
    expect(after.streams.find((s) => s.epoch === BigInt(actors.first_epoch))?.group).not.toHaveProperty("sk");
  });

  it("takes no history the member is denied, even when someone sends it (Vector `collect_history`)", async () => {
    const owed = (channelPermissions(folded.roster, folded.ownerHex, actors.denied, actors.channel, true) & Permissions.READ_MESSAGE_HISTORY) !== 0n;
    expect(owed).toBe(false);
    expect(bytesToHex(hex32(actors.denied))).toBe(actors.denied);
  });
});

const ch = hex32(actors.channel);

describe("the access duty a key holder runs (Vector `access_duty`)", () => {
  const root = hex32(c.root);
  const rotationsAt = (evs: NostrEvent[], epoch: bigint) => {
    const address = channelRekeyGroupKey(root, ch, epoch);
    const parsed = evs.filter((e) => e.pubkey === address.pk).flatMap((e) => {
      try {
        return [parseRekey(openWrap(e, address))];
      } catch {
        return [];
      }
    });
    return mintingRotations(groupRotations(parsed), actors.channel, epoch);
  };
  const planAt = (evs: NostrEvent[], epoch: bigint) => {
    const control = foldControlState(openControlWraps(evs, [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]), hex32(c.id), c.owner);
    const deliveries = evs.filter((e) => e.pubkey === plane.pk).flatMap((e) => parseDelivery(openWrap(e, plane)) ?? []);
    const candidates = accessCandidates(control, new Map());
    return {
      control,
      candidates,
      duty: planChannelDuty({ control, me: actors.owner, channelIdHex: actors.channel, epoch, candidates, deliveries, minted: rotationsAt(evs, epoch), prior: rotationsAt(evs, epoch - 1n) }),
    };
  };
  const before = events.filter((e) => actors.events_before_duty.includes(e.id));

  it("delivers to the reader and lets the one denied history in by a fresh epoch, as Vector did", () => {
    const { duty } = planAt(before, BigInt(actors.epoch_before_duty));
    expect(duty?.deliver).toEqual([actors.reader]);
    expect(duty?.fresh).toEqual([actors.denied]);
    expect(duty?.cut).toEqual([]);
  });

  it("hands the fresh epoch to the same members Vector's rotation did", () => {
    const { control, candidates } = planAt(before, BigInt(actors.epoch_before_duty));
    const vector = rotationsAt(events, BigInt(actors.epoch_after_duty));
    expect(vector).toHaveLength(1);
    const epoch = BigInt(actors.epoch_after_duty);
    const got = vector[0].blobs.map((b) => b.locator).sort();
    const ours = rotationRecipients(control, actors.owner, actors.channel, candidates, []).map((pk) => myLocator(actors.owner, pk, actors.channel, epoch)).sort();
    expect(ours).toEqual(got);
  });

  it("leaves nothing to do once Vector's duty ran", () => {
    expect(planAt(events, BigInt(actors.epoch_after_duty)).duty).toBeUndefined();
  });
});

describe("the deliveries Armada sends (Vector `build_access_rumor`, `deliver_history`)", () => {
  const ownerSk = hex32(actors.owner_secret);
  const encrypt = async (pk: string, plain: string) => nip44Encrypt(plain, getConversationKey(ownerSk, pk));
  const keys = actors.owner_keys_before_duty.map((k) => ({ epoch: BigInt(k.epoch), key: hex32(k.key) }));
  const current = keys.find((k) => k.epoch === BigInt(actors.epoch_before_duty))!;
  const vectorRumor = (form: string) => opened.find((o) => o.tags.some((t) => t[0] === "delivery" && t[1] === form))!;

  it("carries the key the way Vector's delivery does, and opens to it", async () => {
    const [rumor] = await buildAccessDeliveries(actors.owner, encrypt, { scopeIdHex: actors.channel, epoch: current.epoch, key: current.key, recipients: [actors.reader], atSecs: 1 });
    expect(rumor.tags.map((t) => t[0])).toEqual(vectorRumor("access").tags.map((t) => t[0]));
    const d = parseDelivery({ ...rumor, author: actors.owner, rumorId: rumor.id, ms: 1000, createdAt: 1, sealKind: KIND_SEAL_ENCRYPTED } as never)!;
    const blob = d.blobs.find((b) => b.locator === myLocator(actors.owner, actors.reader, actors.channel, current.epoch))!;
    const key = decodeWrappedKey(base64ToBytes(await decryptAs(actors.reader_secret)(actors.owner, blob.wrapped)), ch, current.epoch);
    expect(bytesToHex(key)).toBe(bytesToHex(current.key));
  });

  it("hands each past epoch read-only, as the view Vector handed", async () => {
    const views = keys.filter((k) => k.epoch < current.epoch).map((k) => {
      const g = channelGroupKey(k.key, ch, k.epoch);
      return { epoch: k.epoch, view: { address: g.pk, convKey: bytesToHex(g.convKey) } };
    });
    const rumors = await buildHistoryDeliveries(actors.owner, encrypt, { channelIdHex: actors.channel, views, recipients: [actors.reader], atSecs: 1 });
    expect(rumors).toHaveLength(1);
    expect(rumors[0].tags.map((t) => t[0])).toEqual(vectorRumor("history").tags.map((t) => t[0]));
    const mine = parseHistoryDelivery({ ...rumors[0], author: actors.owner, rumorId: rumors[0].id, ms: 1000, createdAt: 1 } as never, actors.channel)!;
    const theirs = parseHistoryDelivery(vectorRumor("history"), actors.channel)!;
    const open = async (d: typeof mine) => decodeHistoryPlaintext(await decryptAs(actors.reader_secret)(d.deliverer, d.blobs.find((b) => b.locator === historyLocator(d.deliverer, actors.reader, actors.channel, d.epoch))!.wrapped), ch, d.epoch);
    expect(await open(mine)).toEqual(await open(theirs));
  });
});

describe("sealing a Private Channel's details again after a rotation (Vector `reseal_channel`)", () => {
  const ownerSk = hex32(actors.owner_secret);
  const after = BigInt(actors.epoch_after_duty);
  const foldOf = (evs: NostrEvent[]) => foldControlState(openControlWraps(evs, [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]), hex32(c.id), c.owner);
  const keys = actors.owner_keys_before_duty.map((k) => ({ epoch: BigInt(k.epoch), key: hex32(k.key) }));
  async function ownerKeyAfter() {
    const address = channelRekeyGroupKey(root, ch, after);
    const sets = groupRotations(events.filter((e) => e.pubkey === address.pk).map((e) => parseRekey(openWrap(e, address))));
    const blob = findBlob(sets[0], myLocator(sets[0].rotator, actors.owner, actors.channel, after))!;
    return decodeWrappedKey(base64ToBytes(nip44Decrypt(blob.wrapped, getConversationKey(ownerSk, sets[0].rotator))), ch, after);
  }
  const root = hex32(c.root);

  it("owes nothing once Vector's rotator sealed them under the new epoch", async () => {
    const f = foldOf(events);
    const def = f.channels.get(actors.channel)!;
    expect(def.sealed?.epoch).toBe(after);
    const held = { id: ch, key: await ownerKeyAfter(), epoch: after, name: "", priors: keys.map((k) => ({ ...k })) };
    expect(resealedChannelContent(def, held, bytesToHex(f.heads.get(actors.channel)!.hash))).toBeUndefined();
  });

  it("seals the details it reads at the old epoch under the new key, naming the head", async () => {
    const f = foldOf(events.filter((e) => actors.events_before_duty.includes(e.id)));
    const def = f.channels.get(actors.channel)!;
    expect(def.sealed!.epoch).toBeLessThan(after);
    const key = await ownerKeyAfter();
    const held = { id: ch, key, epoch: after, name: "", priors: keys.map((k) => ({ ...k })) };
    const headHex = bytesToHex(f.heads.get(actors.channel)!.hash);
    const content = resealedChannelContent(def, held, headHex)!;
    const resealed = readChannelContent(content)!.sealed!;
    expect(resealed.epoch).toBe(after);
    expect(openChannelSeal({ ...resealed, prevHex: headHex }, { id: ch, key, epoch: after, name: "" })?.metadata.name).toBe("inner");
  });
});

describe("reading the rotations that minted an epoch (Vector `fetch_rekey_chunks`)", () => {
  it("pages past a flood of junk at the rekey address to the rotation beneath it", async () => {
    const { readMintingRotations } = await import("@/concord/hooks/useAccessDuty");
    const root = hex32(c.root);
    const epoch = BigInt(actors.epoch_after_duty);
    const address = channelRekeyGroupKey(root, ch, epoch);
    const real = events.filter((e) => e.pubkey === address.pk);
    expect(real.length).toBeGreaterThan(0);
    const newest = Math.max(...real.map((e) => e.created_at));
    const junk = Array.from({ length: 600 }, (_, i) => ({ ...real[0], id: i.toString(16).padStart(64, "0"), content: "junk", created_at: newest + 1 + i }));
    const all = [...real, ...junk];
    type F = { authors?: string[]; until?: number; limit?: number };
    const nostr = {
      relay: () => ({
        query: async ([f]: F[]) =>
          all
            .filter((e) => (!f.authors || f.authors.includes(e.pubkey)) && (f.until === undefined || e.created_at <= f.until))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, f.limit ?? Infinity),
      }),
    };
    const community = { ...base, relays: ["wss://r.test"], privateChannels: [] } as unknown as Community;
    const got = await readMintingRotations(nostr as never, community, ch, epoch, new AbortController().signal);
    expect(got.length).toBe(mintingRotations(groupRotations(real.map((e) => parseRekey(openWrap(e, address)))), actors.channel, epoch).length);
    expect(got.length).toBeGreaterThan(0);
  });
});

describe("what re-arms the access duty (Vector `authority_changed`)", () => {
  it("moves with the Roster and the Banlist, not with a Channel rename", async () => {
    const { authoritySig } = await import("@/concord/hooks/useAccessDuty");
    const sig = authoritySig(folded);
    const renamed = { ...folded, metadata: { ...folded.metadata!, name: "renamed" }, heads: new Map(folded.heads) };
    renamed.heads.set("ab".repeat(32), { version: 9n, hash: new Uint8Array(32) });
    expect(authoritySig(renamed)).toBe(sig);
    expect(authoritySig({ ...folded, banned: new Set([...folded.banned, "cd".repeat(32)]) })).not.toBe(sig);
  });
});

describe("the reseal backstop's junk seal (CORD-03 §2, Vector `needs_reseal`)", () => {
  it("seals again a head this device holds the key of its epoch for but can't open, from the name it held", () => {
    const held = { id: hex32(actors.channel), key: new Uint8Array(32).fill(5), epoch: 3n, name: "staff" };
    const def = { isPrivate: true, metadata: { name: "", private: true }, sealed: { epoch: 3n, sealed: "junk" } };
    const content = resealedChannelContent(def, held, "ab".repeat(32))!;
    expect(content).toBeDefined();
    const read = readChannelContent(content)!;
    expect(openChannelSeal({ ...read.sealed!, prevHex: "ab".repeat(32) }, held)?.metadata.name).toBe("staff");
  });

  it("seals again junk at an earlier epoch this device holds a key for, and waits on one it holds none for", () => {
    const old = { key: new Uint8Array(32).fill(4), epoch: 2n };
    const held = { id: hex32(actors.channel), key: new Uint8Array(32).fill(5), epoch: 3n, name: "staff", priors: [old] };
    const def = { isPrivate: true, metadata: { name: "", private: true }, sealed: { epoch: 2n, sealed: "junk" } };
    const content = resealedChannelContent(def, held, "ab".repeat(32))!;
    expect(content).toBeDefined();
    expect(openChannelSeal({ ...readChannelContent(content)!.sealed!, prevHex: "ab".repeat(32) }, held)?.metadata.name).toBe("staff");
    expect(resealedChannelContent({ ...def, sealed: { epoch: 1n, sealed: "junk" } }, held, "ab".repeat(32))).toBeUndefined();
  });
});
