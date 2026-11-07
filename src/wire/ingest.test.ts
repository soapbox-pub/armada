/**
 * The wire's single ingestion point: every transport (web sockets, the APK
 * service's live feed and drain) funnels through `ingestWireEvents`, which
 * routes into IndexedDB (plaintext → armada-events; decryptable Concord wraps →
 * rumor store; unknown wraps → parked) and announces changed scopes on the
 * bus. These tests pin that routing.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { _resetChatMemoForTests } from "@/concord/lib/chat";
import { unseenPlaneWraps } from "@/concord/lib/planeSync";
import { _resetVerifyCacheForTests } from "@/lib/verifyCache";
import { bytesToHex, channelGroupKey, controlGroupKey, guestbookGroupKey, voiceGroupKey, voiceMediaKey } from "@/concord/lib/derive";
import { KIND_CONTROL, KIND_KICK, KIND_MESSAGE, KIND_SEAL_ENCRYPTED, KIND_SEAL_PLAINTEXT } from "@/concord/lib/kinds";
import { peekPendingWraps, queryPlane, queryChannelRumors } from "@/concord/lib/rumorStore";
import { drainLiveDmWraps, resetLiveDmWraps } from "@/lib/nip17/dm17Store";
import { drainLiveInviteWraps, resetLiveInviteWraps } from "@/concord/lib/inviteInbox";
import { buildRumor, channelBindingTags, sealRumor, wrapSeal } from "@/concord/lib/stream";
import type { Channel } from "@/concord/lib/types";

import { onWireScopes, resetWireBus } from "./bus";
import { ingestWireEvents, type WireEventStore } from "./ingest";
import { registerNotifySink, type NotifyCandidate } from "./notify";
import type { WireSpec } from "./spec";

afterEach(() => {
  resetWireBus();
  resetLiveDmWraps();
  resetLiveInviteWraps();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const root = new Uint8Array(32).fill(9);
let nextChannelByte = 120;
function makeChannel(): { channel: Channel; idHex: string } {
  const channelId = new Uint8Array(32).fill(nextChannelByte++);
  const idHex = bytesToHex(channelId);
  const group = channelGroupKey(root, channelId, 0);
  const stream = { epoch: 0n, group };
  const voice = { room: voiceGroupKey(root, channelId, 0), mediaKey: voiceMediaKey(root, channelId, 0) };
  return {
    channel: {
      id: channelId,
      idHex,
      name: "general",
      isPrivate: false,
      voice,
      streams: [stream],
      current: stream,
    },
    idHex,
  };
}

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

async function wrapChat(channel: Channel, s: ReturnType<typeof signer>, content: string, tags: string[][] = []): Promise<NostrEvent> {
  const rumor = buildRumor({
    kind: KIND_MESSAGE,
    content,
    tags: [...channelBindingTags(channel.idHex, 0n), ...tags],
    pubkey: s.pubkey,
    ms: Date.now(),
  });
  const seal = await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, s);
  return await wrapSeal(seal, channel.current.group) as NostrEvent;
}

class FakeStore implements WireEventStore {
  events: NostrEvent[] = [];
  /** The relay each write was attributed to — what the real store routes on. */
  relays: Array<string | undefined> = [];
  async event(ev: NostrEvent, opts?: { relay?: string }): Promise<void> {
    if (this.events.some((e) => e.id === ev.id)) return;
    this.events.push(ev);
    this.relays.push(opts?.relay);
  }
}

function makeSinks(spec: Partial<WireSpec>, store = new FakeStore()) {
  const full: WireSpec = {
    subs: [],
    concordByPk: new Map(),
    concordCommunityByChannel: new Map(),
    concordBannedByCommunity: new Map(),
    concordRoleMentionsByCommunity: new Map(),
    concordSilenceByChannel: new Map(),
    concordNicknamesByCommunity: new Map(),
    concordCtlByPk: new Map(),
    concordGbByPk: new Map(),
    gitByRepository: new Map(),
    gitRootById: new Map(),
    gitRootAuthorById: new Map(),
    sig: "",
    ...spec,
  };
  return { store, sinks: { eventStore: Promise.resolve(store), getSpec: () => full } };
}

function plainEvent(kind: number, tags: string[][] = []): NostrEvent {
  return {
    id: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0"),
    kind,
    pubkey: "a".repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    content: "x",
    tags,
    sig: "",
  };
}

async function collectScopes(run: () => Promise<void>): Promise<Set<string>> {
  const seen = new Set<string>();
  const off = onWireScopes((scopes) => {
    for (const s of scopes) seen.add(s);
  });
  await run();
  // The bus coalesces on a 50ms window.
  await new Promise((r) => setTimeout(r, 120));
  off();
  return seen;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("ingestWireEvents", () => {
  it("routes NIP-29 events to the store and announces the group scope", async () => {
    const { store, sinks } = makeSinks({});
    const ev = plainEvent(9, [["h", "g1"]]);

    const scopes = await collectScopes(() =>
      ingestWireEvents(sinks, [ev], { relay: "wss://r.example" }),
    );

    expect(store.events).toHaveLength(1);
    expect(scopes.has("nip29:g1")).toBe(true);
  });

  it("attributes each write to the relay the batch came from", async () => {
    // The store files NIP-29 data under its relay and DROPS it when the relay is
    // unknown, so every transport has to carry the relay this far or a message
    // received natively (or replayed from the service queue) is never stored.
    const { store, sinks } = makeSinks({});
    await ingestWireEvents(sinks, [plainEvent(9, [["h", "g1"]])], { relay: "wss://r.example" });
    expect(store.relays).toEqual(["wss://r.example"]);
  });

  it("routes kind-4 DMs to the inbox and affected-thread scopes", async () => {
    const self = "e".repeat(64);
    const peer = "f".repeat(64);
    const { store, sinks } = makeSinks({});
    const withSelf = { ...sinks, getSelfPubkey: () => self };
    const dm = plainEvent(4, [["p", self]]);
    dm.pubkey = peer;
    const scopes = await collectScopes(() =>
      ingestWireEvents(withSelf, [dm]),
    );
    expect(store.events).toHaveLength(1);
    expect(scopes.has("dm")).toBe(true);
    expect(scopes.has(`dm-thread:${peer}`)).toBe(true);
  });

  it("stores attached issue roots and emits only their repository scope", async () => {
    const address = `30617:${"b".repeat(64)}:armada`;
    const { store, sinks } = makeSinks({ gitByRepository: new Map([[address, []]]) });
    const issue = plainEvent(1621, [["a", address], ["subject", "Bug"]]);
    const unrelated = plainEvent(1621, [["a", `30617:${"c".repeat(64)}:other`]]);
    const scopes = await collectScopes(() => ingestWireEvents(sinks, [issue, unrelated]));
    expect(store.events.map((event) => event.id)).toEqual([issue.id]);
    expect(scopes).toEqual(new Set([`git:${address}`, `gitroot:${address}`]));
  });

  it("stores only comments and statuses rooted in known tickets under the repository scope", async () => {
    const address = `30617:${"b".repeat(64)}:armada`;
    const root = "1".repeat(64);
    const { store, sinks } = makeSinks({ gitByRepository: new Map([[address, []]]), gitRootById: new Map([[root, address]]) });
    const comment = plainEvent(1111, [["E", root, "", "b".repeat(64)], ["K", "1621"], ["e", "2".repeat(64), "", "reply"]]);
    const status = plainEvent(1632, [["e", root, "", "root"]]);
    const unrelated = plainEvent(1111, [["E", "3".repeat(64), "", "b".repeat(64)], ["K", "1621"]]);
    const scopes = await collectScopes(() => ingestWireEvents(sinks, [comment, status, unrelated]));
    expect(store.events.map((event) => event.id)).toEqual([comment.id, status.id]);
    // Children never wake root discovery (`gitroot:`), which re-reads every relay.
    expect(scopes).toEqual(new Set([`git:${address}`]));
  });

  it("decrypts Concord wraps for held streams into the rumor store (never armada-events)", async () => {
    const { channel, idHex } = makeChannel();
    const communityIdHex = "c".repeat(64);
    const alice = signer();
    const wrap = await wrapChat(channel, alice, "sealed hello");
    const { store, sinks } = makeSinks({
      concordByPk: new Map([[wrap.pubkey, channel]]),
      concordCommunityByChannel: new Map([[idHex, communityIdHex]]),
    });

    const scopes = await collectScopes(() => ingestWireEvents(sinks, [wrap]));

    expect(store.events).toHaveLength(0); // wraps never land in armada-events
    expect(scopes.has(`c2:${idHex}`)).toBe(true);
    const rumors = await queryChannelRumors(communityIdHex, idHex, { limit: 10 });
    expect(rumors.some((r) => r.content === "sealed hello")).toBe(true);
  });

  it("does not re-decrypt a chat wrap it has already stored, even in a later session", async () => {
    // Rotated rounds replay recent wraps continuously, and chat.ts's decode memo
    // is session-scoped — so every reload re-paid two NIP-44 decrypts and a
    // Schnorr verify per replayed wrap (profiled: 1918ms on one reload).
    const { channel, idHex } = makeChannel();
    const communityIdHex = "d".repeat(64);
    const alice = signer();
    const wraps = await Promise.all([
      wrapChat(channel, alice, "replayed one"),
      wrapChat(channel, alice, "replayed two"),
    ]);
    const { sinks } = makeSinks({
      concordByPk: new Map(wraps.map((w) => [w.pubkey, channel])),
      concordCommunityByChannel: new Map([[idHex, communityIdHex]]),
    });

    let verifies = 0;
    const realVerify = schnorr.verify.bind(schnorr);
    const spy = vi.spyOn(schnorr, "verify").mockImplementation(((...args: Parameters<typeof schnorr.verify>) => {
      verifies++;
      return realVerify(...args);
    }) as typeof schnorr.verify);
    try {
      await collectScopes(() => ingestWireEvents(sinks, wraps));
      expect(verifies).toBe(2); // one seal verify per wrap
      const stored = await queryChannelRumors(communityIdHex, idHex, { limit: 10 });
      expect(stored.map((r) => r.content).sort()).toEqual(["replayed one", "replayed two"]);

      // Replayed after a RELOAD. Both session memos have to go: either would
      // absorb the replay alone. Without the fix this pass verifies 2 again.
      _resetChatMemoForTests();
      _resetVerifyCacheForTests();
      verifies = 0;
      await collectScopes(() => ingestWireEvents(sinks, wraps));
      expect(verifies).toBe(0);

      // Still exactly the two rumors — skipping the re-open lost nothing.
      const after = await queryChannelRumors(communityIdHex, idHex, { limit: 10 });
      expect(after).toHaveLength(stored.length);
    } finally {
      spy.mockRestore();
    }
  });

  it("retries a chat wrap that did NOT open (a key we may hold later), rather than memoising it", async () => {
    // A failed open is usually an epoch key we don't hold YET, not junk, so only
    // OPENED wraps enter the memo.
    const { channel, idHex } = makeChannel();
    const other = makeChannel();
    const alice = signer();
    // Sealed under another channel's key but addressed as this one: routed
    // here, fails to decrypt.
    const foreign = await wrapChat(other.channel, alice, "not readable yet");
    const spliced = { ...foreign, pubkey: channel.current.group.pk } as NostrEvent;
    const { sinks } = makeSinks({
      concordByPk: new Map([[spliced.pubkey, channel]]),
      concordCommunityByChannel: new Map([[idHex, "e".repeat(64)]]),
    });

    await collectScopes(() => ingestWireEvents(sinks, [spliced]));
    // Not memoised, so a later delivery is attempted again.
    await expect(unseenPlaneWraps([spliced])).resolves.toHaveLength(1);
  });

  it("decrypts Concord control wraps into the opened-event store and rings the c2ctl fold-wake", async () => {
    const communityId = new Uint8Array(32).fill(200);
    const idHex = bytesToHex(communityId);
    const control = controlGroupKey(root, communityId, 0);
    const owner = signer();
    const rumor = buildRumor({
      kind: KIND_CONTROL,
      content: "edition",
      tags: [],
      pubkey: owner.pubkey,
      ms: Date.now(),
    });
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_PLAINTEXT, control, owner), control) as NostrEvent;
    const { store, sinks } = makeSinks({
      concordCtlByPk: new Map([[wrap.pubkey, { idHex, groups: [control], refounded: false }]]),
    });

    const scopes = await collectScopes(() => ingestWireEvents(sinks, [wrap]));

    expect(store.events).toHaveLength(0); // wraps never land in armada-events
    expect(scopes.has(`c2ctl:${idHex}`)).toBe(true);
    const opened = await queryPlane(idHex, "control");
    expect(opened.some((o) => o.content === "edition")).toBe(true);
  });

  it("decrypts a Concord Kick into the opened-event store and rings the c2gb membership wake", async () => {
    // The live path for a kick. It rotates no key and publishes no control
    // edition, so it rings nothing on `c2ctl` and — before this subscription —
    // reached the kicked member only on the guestbook query's 60s tick.
    const communityId = new Uint8Array(32).fill(201);
    const idHex = bytesToHex(communityId);
    const guestbook = guestbookGroupKey(root, communityId, 0);
    const admin = signer();
    const target = signer();
    const rumor = buildRumor({
      kind: KIND_KICK,
      content: "",
      tags: [["p", target.pubkey]],
      pubkey: admin.pubkey,
      ms: Date.now(),
    });
    const wrap = await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, guestbook, admin), guestbook) as NostrEvent;
    const { store, sinks } = makeSinks({
      concordGbByPk: new Map([[wrap.pubkey, { idHex, groups: [guestbook] }]]),
    });

    const scopes = await collectScopes(() => ingestWireEvents(sinks, [wrap]));

    expect(store.events).toHaveLength(0); // wraps never land in armada-events
    expect(scopes.has(`c2gb:${idHex}`)).toBe(true);
    const opened = await queryPlane(idHex, "guestbook");
    expect(opened.some((o) => o.kind === KIND_KICK && o.tags.some((t) => t[1] === target.pubkey))).toBe(true);
  });

  it("parks Concord wraps for streams we hold no key for and rings the park doorbell", async () => {
    const { channel } = makeChannel();
    const alice = signer();
    const wrap = await wrapChat(channel, alice, "not ours yet");
    const { store, sinks } = makeSinks({}); // empty concordByPk — key unknown

    const scopes = await collectScopes(() => ingestWireEvents(sinks, [wrap]));

    expect(store.events).toHaveLength(0);
    // The park announces the wrap's STREAM ADDRESS, so a hook that holds the
    // key the wire's spec hasn't caught up to (post-rekey) can drain it.
    expect(scopes).toEqual(new Set([`c2park:${wrap.pubkey}`]));
    const parked = await peekPendingWraps([wrap.pubkey]);
    expect(parked.some((w) => w.id === wrap.id)).toBe(true);
  });

  it("buffers a live NIP-17 gift wrap addressed to the viewer and rings dm:wrap (not parked, not stored)", async () => {
    const self = "9".repeat(64);
    const { store, sinks } = makeSinks({});
    const withSelf = { ...sinks, getSelfPubkey: () => self };
    // A kind-1059 gift wrap #p-tagged to the viewer (the wire's DM filter),
    // whose author is an ephemeral key (as every NIP-17 wrap is).
    const wrap = plainEvent(1059, [["p", self]]);
    wrap.pubkey = "a".repeat(64);

    const scopes = await collectScopes(() => ingestWireEvents(withSelf, [wrap]));

    expect(scopes.has("dm:wrap"), "a live DM wrap must wake useDm17").toBe(true);
    // The raw wrap is buffered in hand so useDm17 decrypts it WITHOUT a re-fetch.
    const buffered = drainLiveDmWraps();
    expect(buffered.map((w) => w.id)).toEqual([wrap.id]);
    // It must NOT be parked as a dead Concord pending wrap, nor stored.
    expect(scopes.has(`c2park:${wrap.pubkey}`)).toBe(false);
    expect(store.events).toHaveLength(0);
    expect((await peekPendingWraps([wrap.pubkey]))).toHaveLength(0);
  });

  it("buffers a live direct-invite wrap (kind-1059 #k=3313) and rings c2inv:wrap (not dm:wrap, not parked, not stored)", async () => {
    const self = "9".repeat(64);
    const { store, sinks } = makeSinks({});
    const withSelf = { ...sinks, getSelfPubkey: () => self };
    // A direct-invite gift wrap: same envelope as a DM wrap (kind-1059,
    // #p-tagged to the viewer, ephemeral author) but carrying the outer
    // #k=3313 index hint that separates an invite from a message.
    const wrap = plainEvent(1059, [["p", self], ["k", "3313"]]);
    wrap.pubkey = "a".repeat(64);

    const scopes = await collectScopes(() => ingestWireEvents(withSelf, [wrap]));

    expect(scopes.has("c2inv:wrap"), "a live invite wrap must wake useDirectInvites").toBe(true);
    // It rides the invite buffer, NOT the DM one.
    expect(scopes.has("dm:wrap")).toBe(false);
    expect(drainLiveDmWraps()).toHaveLength(0);
    const buffered = drainLiveInviteWraps();
    expect(buffered.map((w) => w.id)).toEqual([wrap.id]);
    // Never parked as a dead Concord pending wrap, never stored.
    expect(scopes.has(`c2park:${wrap.pubkey}`)).toBe(false);
    expect(store.events).toHaveLength(0);
    expect((await peekPendingWraps([wrap.pubkey]))).toHaveLength(0);
  });

  it("ignores a REPLAYED invite wrap: no re-buffer, no c2inv:wrap re-ring", async () => {
    const self = "9".repeat(64);
    const { sinks } = makeSinks({});
    const withSelf = { ...sinks, getSelfPubkey: () => self };
    const wrap = plainEvent(1059, [["p", self], ["k", "3313"]]);
    wrap.pubkey = "a".repeat(64);

    const first = await collectScopes(() => ingestWireEvents(withSelf, [wrap]));
    expect(first.has("c2inv:wrap")).toBe(true);
    expect(drainLiveInviteWraps().map((w) => w.id)).toEqual([wrap.id]);

    const replay = await collectScopes(() => ingestWireEvents(withSelf, [wrap]));
    expect(replay.has("c2inv:wrap")).toBe(false);
    expect(drainLiveInviteWraps()).toHaveLength(0);
  });

  it("ignores a REPLAYED DM wrap: no re-buffer, no dm:wrap re-ring (the wrap filter's since rewind replays every round)", async () => {
    const self = "9".repeat(64);
    const { sinks } = makeSinks({});
    const withSelf = { ...sinks, getSelfPubkey: () => self };
    const wrap = plainEvent(1059, [["p", self]]);
    wrap.pubkey = "a".repeat(64);

    // First delivery: buffered + doorbell. Drained by the DM hook.
    const first = await collectScopes(() => ingestWireEvents(withSelf, [wrap]));
    expect(first.has("dm:wrap")).toBe(true);
    expect(drainLiveDmWraps().map((w) => w.id)).toEqual([wrap.id]);

    // A rotated round replays the same wrap: silence, nothing buffered.
    const replay = await collectScopes(() => ingestWireEvents(withSelf, [wrap]));
    expect(replay.has("dm:wrap")).toBe(false);
    expect(drainLiveDmWraps()).toHaveLength(0);
  });

  it("still parks a kind-1059 wrap NOT addressed to the viewer (a genuine unknown Concord stream)", async () => {
    const self = "9".repeat(64);
    const { sinks } = makeSinks({});
    const withSelf = { ...sinks, getSelfPubkey: () => self };
    const wrap = plainEvent(1059, [["p", "someone-else"]]);
    wrap.pubkey = "b".repeat(64);

    const scopes = await collectScopes(() => ingestWireEvents(withSelf, [wrap]));

    expect(scopes.has("dm:wrap")).toBe(false);
    expect(drainLiveDmWraps()).toHaveLength(0); // nothing buffered
    expect(scopes.has(`c2park:${wrap.pubkey}`)).toBe(true);
    expect((await peekPendingWraps([wrap.pubkey])).some((w) => w.id === wrap.id)).toBe(true);
  });

  it("skips malformed lines without dropping the rest of the batch", async () => {
    const { store, sinks } = makeSinks({});
    const good = plainEvent(9, [["h", "g1"]]);
    await ingestWireEvents(sinks, [
      { bogus: true } as unknown as NostrEvent,
      good,
    ]);
    expect(store.events.map((e) => e.id)).toEqual([good.id]);
  });
});

describe("ingestWireEvents — foreground notify candidates", () => {
  const SELF = "5".repeat(64);
  const PEER = "6".repeat(64);

  function withSink(spec: Partial<WireSpec>, self: string | undefined = SELF) {
    const captured: NotifyCandidate[] = [];
    const off = registerNotifySink((c) => captured.push(...c));
    const { sinks } = makeSinks(spec);
    const withSelf = { ...sinks, getSelfPubkey: () => self };
    return { captured, off, sinks: withSelf };
  }

  it("emits a NIP-29 candidate with mention flag from a p-tag", async () => {
    const { captured, off, sinks } = withSink({});
    const ev = plainEvent(9, [["h", "g1"], ["p", SELF]]);
    ev.pubkey = PEER;
    try {
      await ingestWireEvents(sinks, [ev], { relay: "wss://relay-a.example" });
    } finally {
      off();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      plane: "nip29",
      relayUrl: "wss://relay-a.example",
      groupId: "g1",
      mention: true,
      body: "x",
    });
  });

  it("keeps the same signed NIP-29 event distinct on two source relays", async () => {
    const { captured, off, sinks } = withSink({});
    const ev = plainEvent(9, [["h", "general"]]);
    ev.pubkey = PEER;
    try {
      await ingestWireEvents(sinks, [ev], { relay: "wss://relay-a.example" });
      await ingestWireEvents(sinks, [ev], { relay: "wss://relay-b.example" });
    } finally {
      off();
    }
    expect(captured.map(({ relayUrl, groupId, eventId }) => ({ relayUrl, groupId, eventId })))
      .toEqual([
        { relayUrl: "wss://relay-a.example", groupId: "general", eventId: ev.id },
        { relayUrl: "wss://relay-b.example", groupId: "general", eventId: ev.id },
      ]);
  });

  it("never emits a candidate for the user's own message", async () => {
    const { captured, off, sinks } = withSink({});
    const ev = plainEvent(9, [["h", "g1"]]);
    ev.pubkey = SELF;
    try {
      await ingestWireEvents(sinks, [ev]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(0);
  });

  it("emits a DM candidate (mention=true) with no body preview (ciphertext)", async () => {
    const { captured, off, sinks } = withSink({});
    const ev = plainEvent(4, [["p", SELF]]);
    ev.pubkey = PEER;
    try {
      await ingestWireEvents(sinks, [ev]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ plane: "dm", peer: PEER, mention: true });
    expect(captured[0].body).toBeUndefined();
  });

  it("emits a c2 candidate routed to the message, not just the channel", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const wrap = await wrapChat(channel, alice, "sealed hi");
    const { captured, off, sinks } = withSink({
      concordByPk: new Map([[wrap.pubkey, channel]]),
      concordCommunityByChannel: new Map([[idHex, "comm-hex"]]),
    });
    try {
      await ingestWireEvents(sinks, [wrap]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(1);
    const rumorId = captured[0].eventId;
    expect(rumorId).toBeTruthy();
    expect(captured[0]).toMatchObject({
      plane: "c2",
      channelIdHex: idHex,
      body: "sealed hi",
      // A tap lands on the message, which is what the `/m/` segment names.
      path: `/c/comm-hex/${idHex}/m/${rumorId}`,
    });
  });

  it("flags a Role mention the viewer holds as a mention (CORD-04 §8)", async () => {
    const { channel, idHex } = makeChannel();
    const communityIdHex = "c".repeat(64);
    const alice = signer();
    const [mods, quiet] = ["a".repeat(64), "b".repeat(64)];
    const wraps = [
      await wrapChat(channel, alice, "hey @Mods", [["role", mods]]),
      // A tag without its name in the text pings nobody, nor one for a Role that isn't mentionable.
      await wrapChat(channel, alice, "hey everyone", [["role", mods]]),
      await wrapChat(channel, alice, "hey @Quiet", [["role", quiet]]),
    ];
    const { captured, off, sinks } = withSink({
      concordByPk: new Map(wraps.map((w) => [w.pubkey, channel])),
      concordCommunityByChannel: new Map([[idHex, communityIdHex]]),
      concordRoleMentionsByCommunity: new Map([[communityIdHex, {
        held: [{ id: mods, name: "Mods", anyone: true }, { id: quiet, name: "Quiet", anyone: false }],
        authors: new Set<string>(),
      }]]),
    });
    try {
      await ingestWireEvents(sinks, wraps);
    } finally {
      off();
    }
    expect(captured.map((c) => [c.body, c.mention])).toEqual([["hey @Mods", true], ["hey everyone", false], ["hey @Quiet", false]]);
  });

  it("rings nobody for a post readers collapse: no SEND here, or inside a running Timeout (CORD-04 §8)", async () => {
    const { channel, idHex } = makeChannel();
    const [denied, timedOut, ok] = [signer(), signer(), signer()];
    const wraps = [await wrapChat(channel, denied, "no send"), await wrapChat(channel, timedOut, "in timeout"), await wrapChat(channel, ok, "fine")];
    const nowSecs = Math.floor(Date.now() / 1000);
    const { captured, off, sinks } = withSink({
      concordByPk: new Map(wraps.map((w) => [w.pubkey, channel])),
      concordCommunityByChannel: new Map([[idHex, "c".repeat(64)]]),
      concordSilenceByChannel: new Map([[idHex, {
        sendDenied: new Set([denied.pubkey]),
        timeouts: [{ pk: timedOut.pubkey, fromSecs: nowSecs - 60, until: nowSecs + 600 }],
      }]]),
    });
    try {
      await ingestWireEvents(sinks, wraps);
    } finally {
      off();
    }
    expect(captured.map((c) => c.body)).toEqual(["fine"]);
  });

  it("rings only the owner's and managers' posts at a restricted Channel's read address (CORD-03 §1 Held posts)", async () => {
    const { channel, idHex } = makeChannel();
    const [stranger, manager] = [signer(), signer()];
    const wraps = [await wrapChat(channel, stranger, "spam"), await wrapChat(channel, manager, "news")];
    const { captured, off, sinks } = withSink({
      concordByPk: new Map(wraps.map((w) => [w.pubkey, channel])),
      concordCommunityByChannel: new Map([[idHex, "c".repeat(64)]]),
      concordSilenceByChannel: new Map([[idHex, { postAuthors: new Set([manager.pubkey]) }]]),
    });
    try {
      await ingestWireEvents(sinks, wraps);
    } finally {
      off();
    }
    expect(captured.map((c) => c.body)).toEqual(["news"]);
  });

  it("rings for a reaction to my message only when a row could render it (Vector `is_renderable_reaction`)", async () => {
    const { channel, idHex } = makeChannel();
    const bob = signer();
    const react = async (content: string) => {
      const rumor = buildRumor({ kind: 7, content, tags: [...channelBindingTags(channel.idHex, 0n), ["e", "ab".repeat(32)], ["p", SELF]], pubkey: bob.pubkey, ms: Date.now() });
      return (await wrapSeal(await sealRumor(rumor, KIND_SEAL_ENCRYPTED, channel.current.group, bob), channel.current.group)) as NostrEvent;
    };
    const wraps = [await react(":catclap:https://i.nostr.build/lLMrw.gif"), await react("🔥")];
    const { captured, off, sinks } = withSink({
      concordByPk: new Map(wraps.map((w) => [w.pubkey, channel])),
      concordCommunityByChannel: new Map([[idHex, "c".repeat(64)]]),
    });
    try {
      await ingestWireEvents(sinks, wraps);
    } finally {
      off();
    }
    expect(captured.map((c) => c.reactionEmoji)).toEqual(["🔥"]);
  });

  it("names the sender by the Nickname they go by in the Community (CORD-04 §10)", async () => {
    const { channel, idHex } = makeChannel();
    const alice = signer();
    const wrap = await wrapChat(channel, alice, "hello");
    const communityIdHex = "c".repeat(64);
    const { captured, off, sinks } = withSink({
      concordByPk: new Map([[wrap.pubkey, channel]]),
      concordCommunityByChannel: new Map([[idHex, communityIdHex]]),
      concordNicknamesByCommunity: new Map([[communityIdHex, { [alice.pubkey]: "Captain" }]]),
    });
    try {
      await ingestWireEvents(sinks, [wrap]);
    } finally {
      off();
    }
    expect(captured[0]?.authorNickname).toBe("Captain");
  });

  it("suppresses a banned member's message but still notifies for everyone else", async () => {
    // Two members posting to the same channel; only one is banned. The ban is
    // per-author, so the other member's message must still raise a candidate.
    // (Both rumors are still stored — that path runs before the ban filter and
    // is covered by the store tests above.)
    const { channel, idHex } = makeChannel();
    const communityIdHex = "c".repeat(64);
    const banned = signer();
    const ok = signer();
    const bannedWrap = await wrapChat(channel, banned, "banned hello");
    const okWrap = await wrapChat(channel, ok, "welcome hello");
    const { captured, off, sinks } = withSink({
      concordByPk: new Map([[bannedWrap.pubkey, channel], [okWrap.pubkey, channel]]),
      concordCommunityByChannel: new Map([[idHex, communityIdHex]]),
      concordBannedByCommunity: new Map([[communityIdHex, new Set([banned.pubkey])]]),
    });
    try {
      await ingestWireEvents(sinks, [bannedWrap, okWrap]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ author: ok.pubkey, body: "welcome hello" });
  });

  it("routes every attached Git activity independently, honors intervals, and rejects spoofed statuses", async () => {
    const owner = "b".repeat(64);
    const address = `30617:${owner}:armada`;
    const root = "1".repeat(64);
    const active = { address: { kind: 30617 as const, owner, identifier: "armada", coordinate: address }, relayHints: [], attachedAt: 10 };
    const detached = { ...active, detachedAt: 20 };
    const attachments = [
      { channelId: "one", communityId: "community-one", attachment: active },
      { channelId: "two", communityId: "community-two", attachment: detached },
    ];
    const issue = plainEvent(1621, [["a", address], ["subject", "Fix unread"]]);
    issue.pubkey = PEER;
    issue.created_at = 15;
    const comment = plainEvent(1111, [["E", root, "", PEER], ["K", "1621"]]);
    comment.pubkey = PEER;
    comment.created_at = 15;
    const trustedStatus = plainEvent(1632, [["e", root, "", "root"]]);
    trustedStatus.pubkey = owner;
    trustedStatus.created_at = 15;
    const spoofedStatus = plainEvent(1632, [["e", root, "", "root"]]);
    spoofedStatus.pubkey = "c".repeat(64);
    spoofedStatus.created_at = 15;
    const { captured, off, sinks } = withSink({
      gitByRepository: new Map([[address, attachments]]),
      gitRootById: new Map([[root, address]]),
    });
    try {
      await ingestWireEvents(sinks, [issue, comment, trustedStatus, spoofedStatus]);
    } finally {
      off();
    }
    // Issue, comment, and trusted status each fan out to both active intervals.
    expect(captured).toHaveLength(6);
    expect(captured.map((candidate) => candidate.path)).toContain(`/c/community-one/one?ticket=${issue.id}`);
    expect(captured.map((candidate) => candidate.path)).toContain(`/c/community-two/two?ticket=${root}`);
    expect(captured.every((candidate) => candidate.git?.repository === "armada")).toBe(true);
    expect(captured.some((candidate) => candidate.author === spoofedStatus.pubkey)).toBe(false);

    // A self-authored Git item remains stored but never reaches notifications.
    const selfIssue = plainEvent(1621, [["a", address]]);
    selfIssue.pubkey = SELF;
    selfIssue.created_at = 15;
    const selfRun = withSink({ gitByRepository: new Map([[address, attachments]]) }, SELF);
    try {
      await ingestWireEvents(selfRun.sinks, [selfIssue]);
    } finally {
      selfRun.off();
    }
    expect(selfRun.captured).toHaveLength(0);

    // The half-open detach boundary excludes exactly the detached channel.
    const afterDetach = plainEvent(1621, [["a", address]]);
    afterDetach.created_at = 20;
    const boundary = withSink({ gitByRepository: new Map([[address, attachments]]) });
    try {
      await ingestWireEvents(boundary.sinks, [afterDetach]);
    } finally {
      boundary.off();
    }
    expect(boundary.captured.map((candidate) => candidate.channelIdHex)).toEqual(["one"]);
  });

  it("never emits a DM candidate for a NIP-17 wrap (can't attribute without decrypting)", async () => {
    // The wire holds no NIP-44 keys, so an inbound gift wrap can't be
    // attributed to a sender here — it only buffers the wrap and rings
    // `dm:wrap` for useDm17 to decrypt. No foreground DM candidate is emitted.
    const wrap: NostrEvent = {
      id: "d".repeat(64),
      kind: 1059,
      pubkey: "a".repeat(64),
      created_at: Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60,
      content: "sealed",
      tags: [["p", SELF]],
      sig: "",
    };
    const { captured, off, sinks } = withSink({});
    try {
      await ingestWireEvents(sinks, [wrap]);
    } finally {
      off();
    }
    expect(captured).toHaveLength(0);
    // The wrap is buffered for the decrypt path, not parked.
    expect(drainLiveDmWraps().map((w) => w.id)).toEqual([wrap.id]);
    const parked = await peekPendingWraps(["a".repeat(64)]);
    expect(parked.some((w) => w.id === wrap.id)).toBe(false);
  });
});
