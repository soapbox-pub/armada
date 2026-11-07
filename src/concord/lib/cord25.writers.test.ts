/**
 * A Vector Community with a restricted Channel and one member let post there by an
 * overwrite: the writer key and certificate Vector delivered them on the access
 * plane (CORD-03 §1), collected the way `useWriterAccess` does, and a post built
 * at the writer address the way `useSendMessage` builds one.
 */
import { IDBFactory } from "fake-indexeddb";
import { decrypt as nip44Decrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, type EventTemplate, type NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { writerJudge } from "@/concord/lib/channelJudges";
import { openChatBatch } from "@/concord/lib/chat";
import { channelsView } from "@/concord/lib/community";
import { foldControlState, openControlWraps } from "@/concord/lib/control";
import { accessPlane, parseDelivery, type ParsedDelivery } from "@/concord/lib/delivery";
import { bytesToHex, controlGroupKey, hex32 } from "@/concord/lib/derive";
import { KIND_MESSAGE, KIND_REACTION, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import { buildRumor, channelBindingTags, openWrap, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";
import { adoptWriterDeliveries, canPostIn, postLock, sendTarget, usableWriter, writerKeysReady, writerNeeds } from "@/concord/lib/writerKeys";

import actors from "./fixtures/cord25/writers.actors.json";
import fixture from "./fixtures/cord25/writers.json";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

describe("posting as a writer in a restricted Channel (Vector fixture)", () => {
  const c = fixture.community;
  const community = {
    id: hex32(c.id),
    idHex: c.id,
    owner: c.owner,
    root: hex32(c.root),
    rootEpoch: BigInt(c.root_epoch),
    heldRoots: [{ epoch: BigInt(c.root_epoch), key: hex32(c.root) }],
    privateChannels: [],
    relays: [],
    name: "",
    ownerSalt: new Uint8Array(32),
  } as Community;
  const events = fixture.events as unknown as NostrEvent[];
  const read = controlGroupKey(hex32(c.root), hex32(c.id), BigInt(c.root_epoch));
  const editions = openControlWraps(events, [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]);
  const folded = foldControlState(editions, hex32(c.id), c.owner);
  const memberSk = hex32(actors.member_secret);
  const decrypt = async (deliverer: string, wrapped: string) => nip44Decrypt(wrapped, getConversationKey(memberSk, deliverer));
  const plane = accessPlane(community, hex32(actors.general));
  const deliveries = events
    .filter((e) => e.pubkey === plane.pk)
    .map((e) => parseDelivery(openWrap(e, plane)))
    .filter((d): d is ParsedDelivery => d !== undefined);
  const general = channelsView(community, folded).find((ch) => ch.idHex === actors.general)!;

  it("can't post before collecting, and collects the key and certificate Vector delivered", async () => {
    await writerKeysReady();
    // Vector locks the composer as "your key is on its way" for a writer, "can't send" for anyone else.
    expect(postLock(folded, community.id, actors.general, actors.member)).toBe("key-pending");
    expect(postLock(folded, community.id, actors.general, "ab".repeat(32))).toBe("cant-send");
    expect(writerNeeds(folded, community.id, actors.general, actors.member)).toEqual(expect.objectContaining({ epoch: actors.writer_epoch, key: true, cert: true }));
    expect(canPostIn(folded, community.id, actors.general, actors.member)).toBe(false);
    expect(await adoptWriterDeliveries(deliveries, folded, community.id, actors.general, actors.member, decrypt)).toBe(true);
    const w = usableWriter(folded, community.id, actors.general, actors.member)!;
    expect(bytesToHex(w.secret)).toBe(actors.writer_secret);
    expect(w.cert).toBe(actors.writer_cert);
    expect(w.epoch).toBe(actors.writer_epoch);
    expect(canPostIn(folded, community.id, actors.general, actors.member)).toBe(true);
    expect(postLock(folded, community.id, actors.general, actors.member)).toBeUndefined();
    expect(writerNeeds(folded, community.id, actors.general, actors.member)).toBeUndefined();
  });

  it("refuses the delivery for anyone it doesn't certify", async () => {
    const stranger = "ab".repeat(32);
    expect(await adoptWriterDeliveries(deliveries, folded, community.id, actors.general, stranger, decrypt)).toBe(false);
    expect(canPostIn(folded, community.id, actors.general, stranger)).toBe(false);
  });

  it("sends at the writer address with the epoch and certificate Vector's own post carries", async () => {
    const target = sendTarget(general.current.group, KIND_MESSAGE, folded, community.id, actors.general, actors.member)!;
    expect(target.group.pk).not.toBe(general.current.group.pk);
    const atWriter = await openChatBatch(events.filter((e) => e.pubkey === target.group.pk), general, { remember: false });
    const vectorPost = atWriter.find((m) => m.author === actors.member)!;
    expect(vectorPost.content).toBe("a writer's post");
    const tagOf = (tags: string[][], name: string) => tags.find((t) => t[0] === name)?.[1];
    expect(tagOf(target.tags, "wepoch")).toBe(tagOf(vectorPost.tags, "wepoch"));
    expect(tagOf(target.tags, "wcert")).toBe(tagOf(vectorPost.tags, "wcert"));

    const signer = { pubkey: actors.member, signEvent: async (t: EventTemplate) => finalizeEvent(t, memberSk) };
    const rumor = buildRumor({ kind: KIND_MESSAGE, content: "from Armada", tags: [...channelBindingTags(general.idHex, general.current.epoch), ...target.tags], pubkey: actors.member });
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, target.group, signer), target.group);
    const [mine] = await openChatBatch([wrap], general, { remember: false });
    expect(mine.content).toBe("from Armada");
    const judge = writerJudge(folded, actors.general, community.id, actors.owner)!;
    expect(judge.stands(mine)).toBe(true);
    expect(judge.stands(vectorPost)).toBe(true);
  });

  it("keeps a reaction at the read address (Vector `rides_writer_address`)", () => {
    expect(sendTarget(general.current.group, KIND_REACTION, folded, community.id, actors.general, actors.member)).toEqual({ group: general.current.group, tags: [] });
  });
});
