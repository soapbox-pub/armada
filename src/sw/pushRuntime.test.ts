import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from "nostr-tools/pure";
import { getConversationKey, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { bytesToHex } from "@noble/hashes/utils.js";
import { nip19 } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";

import { queryChannelRumors } from "@/concord/lib/rumorStore";
import { appEventStore } from "@/lib/db/mainEventStore";
import { queryDm17Thread } from "@/lib/nip17/dm17Store";
import { fetchProfiles } from "@/sw/profileFetch";

import { communityAvatarShown, openConcord, openDm, preparePush, pushScope } from "./pushRuntime";

// No sockets in the suite: profile lookups answer from whatever a test sets.
vi.mock("@/sw/profileFetch", () => ({ fetchProfiles: vi.fn(async () => []) }));
const fetchProfilesMock = vi.mocked(fetchProfiles);
afterEach(() => fetchProfilesMock.mockClear());

import type { SwConcordStream, SwPushConfig } from "@/lib/swPushConfig";

const now = () => Math.floor(Date.now() / 1000);

/** Seal a rumor with the sender's real key (kind 13, nip44 to the recipient). */
function seal(
  rumor: Record<string, unknown>,
  senderSk: Uint8Array,
  recipientPk: string,
  tags: string[][] = [],
) {
  return finalizeEvent(
    {
      kind: 13,
      content: nip44Encrypt(JSON.stringify(rumor), getConversationKey(senderSk, recipientPk)),
      tags,
      created_at: now(),
    },
    senderSk,
  );
}

/** Wrap a seal in a single-use ephemeral gift wrap (kind 1059). */
function wrap(sealEvent: unknown, recipientPk: string, tags: string[][] = [["p", recipientPk]]) {
  const wrapSk = generateSecretKey();
  return finalizeEvent(
    {
      kind: 1059,
      content: nip44Encrypt(JSON.stringify(sealEvent), getConversationKey(wrapSk, recipientPk)),
      tags,
      created_at: now(),
    },
    wrapSk,
  );
}

describe("openDm", () => {
  const senderSk = generateSecretKey();
  const recipientSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientPk = getPublicKey(recipientSk);
  const sk = bytesToHex(recipientSk);

  const rumor = {
    pubkey: senderPk,
    kind: 14,
    content: "are you coming tonight?",
    tags: [["p", recipientPk]],
    created_at: now(),
  };

  it("returns the real sender, message and rumor timestamp", async () => {
    const opened = await openDm(
      wrap(seal(rumor, senderSk, recipientPk), recipientPk),
      sk,
      recipientPk,
    );
    expect(opened).toMatchObject({
      author: senderPk,
      kind: 14,
      content: "are you coming tonight?",
      createdAt: rumor.created_at,
      peers: [senderPk],
    });
  });

  it("returns undefined for a wrap this key can't open", async () => {
    const strangerPk = getPublicKey(generateSecretKey());
    expect(await openDm(wrap(seal(rumor, senderSk, strangerPk), strangerPk), sk, recipientPk))
      .toBeUndefined();
  });

  it("opens the user's own sent copy too — dropping it is prepareDm's call", async () => {
    // It has to open: the copy is how a message sent from another device
    // reaches this one's store at all. Whether to SHOW it is decided later.
    const selfRumor = { ...rumor, pubkey: recipientPk, tags: [["p", senderPk]] };
    const opened = await openDm(
      wrap(seal(selfRumor, recipientSk, recipientPk), recipientPk),
      sk,
      recipientPk,
    );
    expect(opened?.author).toBe(recipientPk);
  });

  it("rejects an anti-spoofed rumor (rumor.pubkey != seal signer)", async () => {
    const spoofed = { ...rumor, pubkey: getPublicKey(generateSecretKey()) };
    expect(await openDm(wrap(seal(spoofed, senderSk, recipientPk), recipientPk), sk, recipientPk))
      .toBeUndefined();
  });

  it("rejects an already-expired rumor (NIP-40)", async () => {
    const past = String(now() - 60);
    const expiredRumor = { ...rumor, tags: [["p", recipientPk], ["expiration", past]] };
    expect(await openDm(wrap(seal(expiredRumor, senderSk, recipientPk), recipientPk), sk, recipientPk))
      .toBeUndefined();
  });

  it("rejects a wrap whose outer expiration has passed without decrypting", async () => {
    const past = String(now() - 60);
    const w = wrap(seal(rumor, senderSk, recipientPk), recipientPk, [
      ["p", recipientPk],
      ["expiration", past],
    ]);
    expect(await openDm(w, sk, recipientPk)).toBeUndefined();
  });

  it("returns undefined for garbage rather than throwing", async () => {
    const junk = { ...wrap(seal(rumor, senderSk, recipientPk), recipientPk), content: "nope" };
    expect(await openDm(junk, sk, recipientPk)).toBeUndefined();
  });
});

describe("openConcord", () => {
  const CHANNEL = "aa".repeat(32);
  const EPOCH = "3";
  const streamSk = generateSecretKey();
  const streamPk = getPublicKey(streamSk);
  const convKey = getConversationKey(streamSk, streamPk); // self-ECDH, per CORD-01
  const authorSk = generateSecretKey();
  const authorPk = getPublicKey(authorSk);

  const stream: SwConcordStream = {
    pk: streamPk,
    convKey: bytesToHex(convKey),
    epoch: EPOCH,
    communityId: "bb".repeat(32),
    channelId: CHANNEL,
  };

  /**
   * A chat rumor bound to the channel + epoch (CORD-02 §5).
   *
   * `id` is computed rather than omitted: `openWrap` requires a rumor to carry
   * its own correct event hash and rejects one that doesn't — unlike NIP-17's
   * `openDmWrap`, which fills a missing id in.
   */
  function chatRumor(over: Partial<Record<string, unknown>> = {}) {
    const rumor = {
      pubkey: authorPk,
      kind: 9,
      content: "shipped it",
      tags: [["channel", CHANNEL], ["epoch", EPOCH]],
      created_at: now(),
      ...over,
    };
    return { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
  }

  /** Seal (20013 encrypted) + wrap under the stream key. */
  function streamWrap(rumor: Record<string, unknown>, sealKind = 20013) {
    const sealed = finalizeEvent(
      {
        kind: sealKind,
        content: sealKind === 20013
          ? nip44Encrypt(JSON.stringify(rumor), convKey)
          : JSON.stringify(rumor),
        tags: [],
        created_at: rumor.created_at as number,
      },
      authorSk,
    );
    return finalizeEvent(
      {
        kind: 1059,
        content: nip44Encrypt(JSON.stringify(sealed), convKey),
        tags: [["p", getPublicKey(generateSecretKey())]],
        created_at: now(),
      },
      streamSk,
    );
  }

  it("opens a chat wrap routed by the stream address", () => {
    const result = openConcord(streamWrap(chatRumor()), [stream]);
    if (result === "malformed") throw new Error("opened as malformed");
    expect(result?.opened).toMatchObject({
      author: authorPk,
      kind: 9,
      content: "shipped it",
      channelIdHex: CHANNEL,
      epoch: BigInt(EPOCH),
    });
    expect(result?.stream).toBe(stream);
  });

  it("drops only the Concord plane while its config snapshot is explicitly unready", async () => {
    const prepared = await preparePush({
      scope: "c2",
      event: streamWrap(chatRumor()),
    }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      dmReady: true,
      concordReady: false,
      concord: [stream],
    });
    expect(prepared?.drop).toBe(true);
  });

  it("treats an undefined Concord readiness flag as legacy-ready", async () => {
    const prepared = await preparePush({
      scope: "c2",
      event: streamWrap(chatRumor()),
    }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concordReady: undefined,
      concord: [stream],
    });
    expect(prepared?.drop).not.toBe(true);
    expect(prepared?.line).toContain("shipped it");
  });

  it("holds a future-dated message: stored, but not announced", async () => {
    const prepared = await preparePush({
      scope: "c2",
      event: streamWrap(chatRumor({ created_at: now() + 3600 })),
    }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [stream],
    });
    // The timeline HOLDS it until its time comes (FUTURE_HOLD_MS); buzzing now
    // would notify about a message the reader can't yet see.
    expect(prepared?.drop).toBe(true);
  });

  it("judges what's dated ahead by the relays' clock the page synced (CORD-03 §3)", async () => {
    const prepared = await preparePush({
      scope: "c2",
      event: streamWrap(chatRumor({ created_at: now() + 3600 })),
    }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [{ ...stream, clockOffsetMs: 3_600_000 }],
    });
    expect(prepared?.drop).not.toBe(true);
  });

  it("names a Community sender by the Nickname they go by there (CORD-04 §10)", async () => {
    const event = streamWrap(chatRumor({ created_at: now() }));
    const prepared = await preparePush({ scope: "c2", event }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [{ ...stream, nicknames: { [authorPk]: "Captain" } }],
    });
    expect(JSON.stringify(prepared)).toContain("Captain");
  });

  it("announces a message within the future grace window", async () => {
    const prepared = await preparePush({
      scope: "c2",
      event: streamWrap(chatRumor({ created_at: now() + 1 })),
    }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [stream],
    });
    expect(prepared?.drop).not.toBe(true);
    expect(prepared?.line).toContain("shipped it");
  });

  it("returns undefined when no configured stream authored the wrap", () => {
    expect(openConcord(streamWrap(chatRumor()), [{ ...stream, pk: "cc".repeat(32) }]))
      .toBeUndefined();
  });

  it("refuses a plaintext seal, which chat forbids (CORD-02 §5)", () => {
    // Android's service accepts 20014 here; the web rule is stricter, and a
    // plaintext seal would make the message a standalone signed artifact.
    expect(openConcord(streamWrap(chatRumor(), 20014), [stream])).toBeUndefined();
  });

  it("refuses a rumor spliced in from another channel", () => {
    const spliced = chatRumor({ tags: [["channel", "dd".repeat(32)], ["epoch", EPOCH]] });
    expect(openConcord(streamWrap(spliced), [stream])).toBeUndefined();
  });

  it("refuses a rumor bound to another epoch", () => {
    const spliced = chatRumor({ tags: [["channel", CHANNEL], ["epoch", "2"]] });
    expect(openConcord(streamWrap(spliced), [stream])).toBeUndefined();
  });

  it("refuses a rumor whose author isn't the seal's signer", () => {
    const spoofed = chatRumor({ pubkey: getPublicKey(generateSecretKey()) });
    expect(openConcord(streamWrap(spoofed), [stream])).toBeUndefined();
  });

  it("refuses a `wepoch` at the read address, which only a forger writes there (CORD-03 §3)", () => {
    const forged = chatRumor({ tags: [["channel", CHANNEL], ["epoch", EPOCH], ["wepoch", "1"]] });
    expect(openConcord(streamWrap(forged), [stream])).toBeUndefined();
  });

  it("refuses another plane's kinds carried on the chat plane", () => {
    // A control edition re-sealed onto a chat stream must not become a message.
    expect(openConcord(streamWrap(chatRumor({ kind: 3308 })), [stream])).toBeUndefined();
  });

  const cfg = (): SwPushConfig => ({
    policy: "generic",
    self: getPublicKey(generateSecretKey()),
    knownPeers: [],
    concord: [stream],
  });

  it("stores an edit silently rather than announcing it", async () => {
    const edit = chatRumor({ kind: 3302, content: "shipped it (edited)" });
    const prepared = await preparePush({ scope: "c2", event: streamWrap(edit) }, cfg());
    expect(prepared?.drop).toBe(true);
  });

  it("stores a delete silently rather than announcing it", async () => {
    const del = chatRumor({ kind: 5, content: "", tags: [["channel", CHANNEL], ["epoch", EPOCH], ["e", "ab".repeat(32)]] });
    const prepared = await preparePush({ scope: "c2", event: streamWrap(del) }, cfg());
    expect(prepared?.drop).toBe(true);
  });

  it("announces a thread reply and links to its thread", async () => {
    const root = "cd".repeat(32);
    const reply = chatRumor({
      kind: 1111,
      content: "replying in the thread",
      tags: [["channel", CHANNEL], ["epoch", EPOCH], ["E", root], ["e", root]],
    });
    const prepared = await preparePush({ scope: "c2", event: streamWrap(reply) }, cfg());
    expect(prepared?.drop).not.toBe(true);
    expect(prepared?.line).toContain("replying in the thread");
    expect(prepared?.url).toBe(`/c/${stream.communityId}/${CHANNEL}/t/${root}`);
  });

  it("drops a message with a malformed ms tag rather than announcing it (CORD-02 §5, Vector `resolve_ms_strict`)", async () => {
    for (const ms of ["1000", "05", "x"]) {
      const bad = chatRumor({ tags: [["channel", CHANNEL], ["epoch", EPOCH], ["ms", ms]] });
      const prepared = await preparePush({ scope: "c2", event: streamWrap(bad) }, cfg());
      expect(prepared?.drop, ms).toBe(true);
    }
  });

  /** Signed by our stream address, but under a key we don't hold (another epoch's). */
  function unopenable() {
    const otherKey = getConversationKey(generateSecretKey(), streamPk);
    return finalizeEvent(
      { kind: 1059, content: nip44Encrypt("{}", otherKey), tags: [], created_at: now() },
      streamSk,
    );
  }

  it("names the room for a wrap from our stream that will not open", async () => {
    const prepared = await preparePush({ scope: "c2", event: unopenable() }, cfg());
    expect(prepared?.drop).not.toBe(true);
    expect(prepared?.tag).toBe(`c2:${CHANNEL}`);
    expect(prepared?.url).toBe(`/c/${stream.communityId}/${CHANNEL}`);
    expect(prepared?.line).toBe("New message");
  });

  it("keeps an unopenable wrap silent in a mentions-only channel", async () => {
    const prepared = await preparePush(
      { scope: "c2", event: unopenable() },
      { ...cfg(), concord: [{ ...stream, mentionOnly: true }] },
    );
    expect(prepared?.drop).toBe(true);
  });

  it("returns undefined for garbage rather than throwing", () => {
    const junk = { ...streamWrap(chatRumor()), content: "not-ciphertext" };
    expect(openConcord(junk, [stream])).toBeUndefined();
  });
});

describe("preparePush — relay-scoped NIP-29 identity", () => {
  it("uses a one-relay gateway spec as exact room authority without cached metadata", async () => {
    const event = finalizeEvent({
      kind: 9,
      content: "hello",
      tags: [["h", "general"]],
      created_at: now(),
    }, generateSecretKey());

    const prepared = await preparePush({
      scope: "group",
      relays: ["wss://relay-a.example"],
      event,
    }, null);

    expect(prepared?.roomKey).toBe("h:wss://relay-a.example|general");
    expect(prepared?.url).toContain("relay-a.example");
  });

  it("opens a thread reply inside its thread", async () => {
    const root = "a".repeat(64);
    const event = finalizeEvent({
      kind: 9,
      content: "in the thread",
      tags: [["h", "general"], ["e", root, "", "reply"], ["q", root, "", "b".repeat(64)]],
      created_at: now(),
    }, generateSecretKey());

    const prepared = await preparePush({
      scope: "group",
      relays: ["wss://relay-a.example"],
      event,
    }, null);

    expect(prepared?.url).toBe(`/s/relay-a.example/general/t/${root}/m/${event.id}`);
  });
});

describe("preparePush — DM request gating", () => {
  const senderSk = generateSecretKey();
  const recipientSk = generateSecretKey();
  const senderPk = getPublicKey(senderSk);
  const recipientPk = getPublicKey(recipientSk);
  const sk = bytesToHex(recipientSk);

  function dmWrap(over: Partial<Record<string, unknown>> = {}) {
    const rumor = {
      pubkey: senderPk,
      kind: 14,
      content: "meet at 8 by the pier",
      tags: [["p", recipientPk]],
      created_at: now(),
      ...over,
    };
    return wrap(seal(rumor, senderSk, recipientPk), recipientPk);
  }

  const cfg = (over: Partial<SwPushConfig> = {}): SwPushConfig => ({
    policy: "generic",
    self: recipientPk,
    knownPeers: [],
    sk,
    ...over,
  });

  const push = (event: unknown, config: SwPushConfig | null) =>
    preparePush({ scope: "dm", event: event as never }, config);

  it("shows the message for a known sender", async () => {
    const p = await push(dmWrap(), cfg({ knownPeers: [senderPk] }));
    expect(p?.line).toContain("meet at 8");
    expect(p?.tag).toBe(`dm-${senderPk}`);
    expect(p?.roomKey).toBe(`dm:${senderPk}`);
    expect(p?.eventId).toMatch(/^[0-9a-f]{64}$/);
    expect(p?.url).toBe(`/dm/${senderPk}`);
    expect(p?.accumulate).toBe(true);
  });

  it("drops only the DM plane while its config snapshot is explicitly unready", async () => {
    const p = await push(dmWrap(), cfg({
      dmReady: false,
      concordReady: true,
      policy: "full",
      knownPeers: [senderPk],
    }));
    expect(p?.drop).toBe(true);
  });

  it("treats an undefined DM readiness flag as legacy-ready", async () => {
    const p = await push(dmWrap(), cfg({
      dmReady: undefined,
      policy: "full",
      knownPeers: [senderPk],
    }));
    expect(p?.drop).not.toBe(true);
    expect(p?.line).toContain("meet at 8");
  });

  it("enforces the exact DM conversation's Nothing level after decrypting", async () => {
    const p = await push(dmWrap(), cfg({
      policy: "full",
      knownPeers: [senderPk],
      dmLevels: { [senderPk]: "nothing" },
    }));
    expect(p?.drop).toBe(true);
  });

  it("uses the global DM fallback when the conversation has no explicit level", async () => {
    const p = await push(dmWrap(), cfg({
      policy: "full",
      knownPeers: [senderPk],
      directMessages: false,
    }));
    expect(p?.drop).toBe(true);
  });

  it("lets an exact All level override the disabled global DM fallback", async () => {
    const p = await push(dmWrap(), cfg({
      policy: "full",
      knownPeers: [senderPk],
      directMessages: false,
      dmLevels: { [senderPk]: "all" },
    }));
    expect(p?.drop).not.toBe(true);
    expect(p?.line).toContain("meet at 8");
  });

  it("treats a DM as directed under an exact Mentions level", async () => {
    const p = await push(dmWrap(), cfg({
      policy: "full",
      knownPeers: [senderPk],
      dmLevels: { [senderPk]: "mentions" },
    }));
    expect(p?.drop).not.toBe(true);
    expect(p?.line).toContain("meet at 8");
  });

  it("routes an authored group by its exact conversation without trusting its members 1:1", async () => {
    const otherPeer = getPublicKey(generateSecretKey());
    const conversation = [senderPk, otherPeer].sort().join(",");
    const group = dmWrap({ tags: [["p", recipientPk], ["p", otherPeer]] });
    const config = cfg({ knownConversations: [conversation] });

    const p = await push(group, config);
    expect(p?.line).toContain("meet at 8");
    expect(p?.tag).toBe(`dm-${conversation}`);
    expect(p?.url).toBe(`/dm/${conversation}`);

    // Exact group participation must not promote the group's author into the
    // global sender allow-list for an unrelated pairwise message.
    const oneToOne = await push(dmWrap(), config);
    expect(oneToOne?.title).toBe("Message requests");
  });

  it("suppresses a trusted group when any participant is muted", async () => {
    const otherPeer = getPublicKey(generateSecretKey());
    const conversation = [senderPk, otherPeer].sort().join(",");
    const p = await push(
      dmWrap({ tags: [["p", recipientPk], ["p", otherPeer]] }),
      cfg({
        policy: "full",
        knownConversations: [conversation],
        mutedPeers: [otherPeer],
      }),
    );
    expect(p?.drop).toBe(true);
  });

  it("shows a content-blind request for an unknown sender under `generic`", async () => {
    const p = await push(dmWrap({ content: "vile slur from a random" }), cfg());
    expect(p?.title).toBe("Message requests");
    expect(p?.accumulate).toBe(false);
    // Nothing the sender controls reaches the notification.
    expect(JSON.stringify(p)).not.toContain("slur");
  });

  it("still shows, quietly, for an unknown sender under `off`", async () => {
    // Never nothing: iOS revokes a subscription that displays nothing.
    const p = await push(dmWrap(), cfg({ policy: "off" }));
    expect(p?.title).toBe("Message requests");
    expect(p?.quiet).toBe(true);
  });

  it("shows full content for an unknown sender under `full`", async () => {
    const p = await push(dmWrap(), cfg({ policy: "full" }));
    expect(p?.line).toContain("meet at 8");
  });

  it("treats a non-message rumor (reaction/delete) as a quiet request", async () => {
    const p = await push(dmWrap({ kind: 7, content: "+" }), cfg({ knownPeers: [senderPk] }));
    expect(p?.title).toBe("Message requests");
    expect(p?.quiet).toBe(true);
  });

  it("declines a login the worker has no key for (bunker / NIP-07)", async () => {
    const { sk: _sk, ...noKey } = cfg();
    expect(await push(dmWrap(), noKey as SwPushConfig)).toBeUndefined();
  });

  it("declines when no event was inlined", async () => {
    expect(await preparePush({ scope: "dm" }, cfg())).toBeUndefined();
  });

  it("declines a wrap it cannot open", async () => {
    const strangerPk = getPublicKey(generateSecretKey());
    const foreign = wrap(seal({ pubkey: senderPk, kind: 14, content: "x", tags: [], created_at: now() }, senderSk, strangerPk), strangerPk);
    expect(await push(foreign, cfg({ policy: "full" }))).toBeUndefined();
  });

  it("declines an unknown scope", async () => {
    expect(await preparePush({ scope: "zap" as never, event: dmWrap() as never }, cfg())).toBeUndefined();
  });
});

describe("preparePush — ingest", () => {
  // The point of inlining the event is not just a better-looking notification:
  // the message is WRITTEN to the tenant the app reads it from, so one received
  // while no tab was open is simply there on the next open. That is what the
  // Android background service does with the shared SQLite file.

  it("stores a DM rumor where the app reads it", async () => {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const senderPk = getPublicKey(senderSk);
    const recipientPk = getPublicKey(recipientSk);
    const rumor = {
      pubkey: senderPk,
      kind: 14,
      content: "stored while the tab was closed",
      tags: [["p", recipientPk]],
      created_at: now(),
    };

    await preparePush(
      { scope: "dm", event: wrap(seal(rumor, senderSk, recipientPk), recipientPk) as never },
      { policy: "full", self: recipientPk, knownPeers: [], sk: bytesToHex(recipientSk) },
    );

    const thread = await queryDm17Thread(recipientPk, [senderPk], { limit: 10 });
    expect(thread.map((m) => m.content)).toContain("stored while the tab was closed");
  });

  it("stores a Concord chat rumor in the community's tenant", async () => {
    const CHANNEL = "ee".repeat(32);
    const COMMUNITY = "ff".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);

    const rumor = {
      pubkey: authorPk,
      kind: 9,
      content: "landed while offline",
      tags: [["channel", CHANNEL], ["epoch", "1"]],
      created_at: now(),
    };
    const withId = { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
    const sealed = finalizeEvent(
      { kind: 20013, content: nip44Encrypt(JSON.stringify(withId), convKey), tags: [], created_at: rumor.created_at },
      authorSk,
    );
    const streamed = finalizeEvent(
      {
        kind: 1059,
        content: nip44Encrypt(JSON.stringify(sealed), convKey),
        tags: [["p", getPublicKey(generateSecretKey())]],
        created_at: now(),
      },
      streamSk,
    );

    await preparePush({ scope: "c2", event: streamed as never }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [{
        pk: streamPk,
        convKey: bytesToHex(convKey),
        epoch: "1",
        communityId: COMMUNITY,
        channelId: CHANNEL,
      }],
    });

    const rows = await queryChannelRumors(COMMUNITY, CHANNEL, { limit: 10 });
    expect(rows.map((r) => r.content)).toContain("landed while offline");
  });
});

describe("preparePush — showing nothing on purpose", () => {
  // `drop` exists because the alternative to a notification is the gateway's
  // static wake-up, which is itself visible. Only the DECRYPTED rumor can say
  // "this is your own message" or "this reaction isn't about you", so by the
  // time the worker knows, silence has to be something it can ask for.

  it("drops the user's own DM sent from another device", async () => {
    const selfSk = generateSecretKey();
    const selfPk = getPublicKey(selfSk);
    const peerPk = getPublicKey(generateSecretKey());
    const rumor = {
      pubkey: selfPk,
      kind: 14,
      content: "sent from my laptop",
      tags: [["p", peerPk]],
      created_at: now(),
    };
    const p = await preparePush(
      { scope: "dm", event: wrap(seal(rumor, selfSk, selfPk), selfPk) as never },
      { policy: "full", self: selfPk, knownPeers: [], sk: bytesToHex(selfSk) },
    );
    expect(p?.drop).toBe(true);
    // Still stored — that copy is how the other device's half of the
    // conversation gets here.
    const thread = await queryDm17Thread(selfPk, [peerPk], { limit: 10 });
    expect(thread.map((m) => m.content)).toContain("sent from my laptop");
  });

  it("drops a Concord reaction aimed at somebody else's message", async () => {
    const CHANNEL = "12".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const rumor = {
      pubkey: getPublicKey(authorSk),
      kind: 7,
      content: "+",
      // p-tags a third party, not us.
      tags: [["channel", CHANNEL], ["epoch", "1"], ["p", getPublicKey(generateSecretKey())]],
      created_at: now(),
    };
    const withId = { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
    const sealed = finalizeEvent(
      { kind: 20013, content: nip44Encrypt(JSON.stringify(withId), convKey), tags: [], created_at: rumor.created_at },
      authorSk,
    );
    const streamed = finalizeEvent(
      {
        kind: 1059,
        content: nip44Encrypt(JSON.stringify(sealed), convKey),
        tags: [["p", getPublicKey(generateSecretKey())]],
        created_at: now(),
      },
      streamSk,
    );

    const p = await preparePush({ scope: "c2", event: streamed as never }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [{
        pk: streamPk,
        convKey: bytesToHex(convKey),
        epoch: "1",
        communityId: "34".repeat(32),
        channelId: CHANNEL,
      }],
    });
    expect(p?.drop).toBe(true);
  });

  it("enforces a Concord stream's Mentions level after decrypting", async () => {
    const CHANNEL = "91".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const selfPk = getPublicKey(generateSecretKey());

    const streamed = (mentionsSelf: boolean, content?: string) => {
      const rumor = {
        pubkey: authorPk,
        kind: 9,
        content: content ?? (mentionsSelf ? "hey, you" : "general chatter"),
        tags: [
          ["channel", CHANNEL],
          ["epoch", "1"],
          ...(mentionsSelf ? [["p", selfPk]] : []),
        ],
        created_at: now(),
      };
      const withId = {
        ...rumor,
        id: getEventHash(rumor as Parameters<typeof getEventHash>[0]),
      };
      const sealed = finalizeEvent(
        {
          kind: 20013,
          content: nip44Encrypt(JSON.stringify(withId), convKey),
          tags: [],
          created_at: rumor.created_at,
        },
        authorSk,
      );
      return finalizeEvent(
        {
          kind: 1059,
          content: nip44Encrypt(JSON.stringify(sealed), convKey),
          tags: [["p", getPublicKey(generateSecretKey())]],
          created_at: now(),
        },
        streamSk,
      );
    };

    const config: SwPushConfig = {
      policy: "generic",
      self: selfPk,
      knownPeers: [],
      concord: [{
        pk: streamPk,
        convKey: bytesToHex(convKey),
        epoch: "1",
        communityId: "92".repeat(32),
        channelId: CHANNEL,
        mentionOnly: true,
      }],
    };

    expect((await preparePush({ scope: "c2", event: streamed(false) as never }, config))?.drop)
      .toBe(true);
    const mention = await preparePush({ scope: "c2", event: streamed(true) as never }, config);
    expect(mention?.drop).not.toBe(true);
    expect(mention?.roomKey).toBe(`c2:${CHANNEL}`);

    const massMention = streamed(false, "Heads up @everyone");
    expect((await preparePush({ scope: "c2", event: massMention as never }, config))?.drop)
      .toBe(true);
    const authorizedConfig: SwPushConfig = {
      ...config,
      concord: config.concord?.map((stream) => ({
        ...stream,
        mentionEveryoneAuthors: [authorPk],
      })),
    };
    const authorized = await preparePush(
      { scope: "c2", event: massMention as never },
      authorizedConfig,
    );
    expect(authorized?.drop).not.toBe(true);
    expect(authorized?.roomKey).toBe(`c2:${CHANNEL}`);
    const anyoneConfig: SwPushConfig = {
      ...config,
      concord: config.concord?.map((stream) => ({ ...stream, mentionEveryoneAnyone: true })),
    };
    expect((await preparePush({ scope: "c2", event: massMention as never }, anyoneConfig))?.drop, "@everyone may mention everyone").not.toBe(true);
  });

  it.fails("never rings a reaction, even to the viewer's own message (Vector: a reaction reaches `on_community_update`, never the notifier)", async () => {
    const CHANNEL = "95".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const self = getPublicKey(generateSecretKey());
    const rumor = { pubkey: getPublicKey(authorSk), kind: 7, content: "🔥", tags: [["channel", CHANNEL], ["epoch", "1"], ["e", "ab".repeat(32)], ["p", self]], created_at: now() };
    const withId = { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
    const sealed = finalizeEvent({ kind: 20013, content: nip44Encrypt(JSON.stringify(withId), convKey), tags: [], created_at: rumor.created_at }, authorSk);
    const streamed = finalizeEvent({ kind: 1059, content: nip44Encrypt(JSON.stringify(sealed), convKey), tags: [["p", getPublicKey(generateSecretKey())]], created_at: now() }, streamSk);
    const p = await preparePush({ scope: "c2", event: streamed as never }, {
      policy: "generic",
      self,
      knownPeers: [],
      concord: [{ pk: streamPk, convKey: bytesToHex(convKey), epoch: "1", communityId: "96".repeat(32), channelId: CHANNEL }],
    });
    expect(p?.drop).toBe(true);
  });

  it("never rings a reaction that says @everyone at anyone but the reacted-to author", async () => {
    const CHANNEL = "93".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const rumor = {
      pubkey: getPublicKey(authorSk),
      kind: 7,
      content: "@everyone",
      tags: [["channel", CHANNEL], ["epoch", "1"], ["p", getPublicKey(generateSecretKey())]],
      created_at: now(),
    };
    const withId = { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
    const sealed = finalizeEvent(
      { kind: 20013, content: nip44Encrypt(JSON.stringify(withId), convKey), tags: [], created_at: rumor.created_at },
      authorSk,
    );
    const streamed = finalizeEvent(
      { kind: 1059, content: nip44Encrypt(JSON.stringify(sealed), convKey), tags: [["p", getPublicKey(generateSecretKey())]], created_at: now() },
      streamSk,
    );
    const p = await preparePush({ scope: "c2", event: streamed as never }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [{ pk: streamPk, convKey: bytesToHex(convKey), epoch: "1", communityId: "94".repeat(32), channelId: CHANNEL, mentionEveryoneAnyone: true }],
    });
    expect(p?.drop).toBe(true);
  });

  it("drops a banned member's Concord message but still stores it", async () => {
    const CHANNEL = "56".repeat(32);
    const COMMUNITY = "78".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const rumor = {
      pubkey: authorPk,
      kind: 9,
      content: "message from a banned member",
      tags: [["channel", CHANNEL], ["epoch", "1"]],
      created_at: now(),
    };
    const withId = { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
    const sealed = finalizeEvent(
      { kind: 20013, content: nip44Encrypt(JSON.stringify(withId), convKey), tags: [], created_at: rumor.created_at },
      authorSk,
    );
    const streamed = finalizeEvent(
      {
        kind: 1059,
        content: nip44Encrypt(JSON.stringify(sealed), convKey),
        tags: [["p", getPublicKey(generateSecretKey())]],
        created_at: now(),
      },
      streamSk,
    );

    const p = await preparePush({ scope: "c2", event: streamed as never }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [{
        pk: streamPk,
        convKey: bytesToHex(convKey),
        epoch: "1",
        communityId: COMMUNITY,
        channelId: CHANNEL,
        banned: [authorPk],
      }],
    });
    expect(p?.drop).toBe(true);
    // Stored regardless — the timeline folds the ban away on read, so the row
    // still has to be there for that surface.
    const rows = await queryChannelRumors(COMMUNITY, CHANNEL, { limit: 10 });
    expect(rows.map((r) => r.content)).toContain("message from a banned member");
  });

  it("rings only the owner's and managers' posts at a restricted Channel's read address (CORD-03 §1 Held posts)", async () => {
    const CHANNEL = "5a".repeat(32);
    const COMMUNITY = "7a".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const wrapFrom = (authorSk: Uint8Array, kind: number, content: string) => {
      const rumor = { pubkey: getPublicKey(authorSk), kind, content, tags: [["channel", CHANNEL], ["epoch", "1"]], created_at: now() };
      const withId = { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
      const sealed = finalizeEvent({ kind: 20013, content: nip44Encrypt(JSON.stringify(withId), convKey), tags: [], created_at: rumor.created_at }, authorSk);
      return finalizeEvent({ kind: 1059, content: nip44Encrypt(JSON.stringify(sealed), convKey), tags: [["p", getPublicKey(generateSecretKey())]], created_at: now() }, streamSk);
    };
    const [stranger, manager] = [generateSecretKey(), generateSecretKey()];
    const config = {
      policy: "generic" as const,
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [{ pk: streamPk, convKey: bytesToHex(convKey), epoch: "1", communityId: COMMUNITY, channelId: CHANNEL, postAuthors: [getPublicKey(manager)] }],
    };
    expect((await preparePush({ scope: "c2", event: wrapFrom(stranger, 9, "spam") as never }, config))?.drop).toBe(true);
    expect((await preparePush({ scope: "c2", event: wrapFrom(manager, 9, "news") as never }, config))?.drop).not.toBe(true);
  });

  it("drops a Concord message sent before this membership began", async () => {
    const CHANNEL = "9a".repeat(32);
    const COMMUNITY = "9b".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const self = getPublicKey(generateSecretKey());
    const sentAt = now() - 3600;
    const rumor = {
      pubkey: getPublicKey(authorSk),
      kind: 9,
      content: "from before you joined",
      tags: [["channel", CHANNEL], ["epoch", "1"], ["p", self]],
      created_at: sentAt,
    };
    const withId = { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
    const sealed = finalizeEvent(
      { kind: 20013, content: nip44Encrypt(JSON.stringify(withId), convKey), tags: [], created_at: sentAt },
      authorSk,
    );
    const streamed = finalizeEvent(
      {
        kind: 1059,
        content: nip44Encrypt(JSON.stringify(sealed), convKey),
        tags: [["p", getPublicKey(generateSecretKey())]],
        created_at: now(),
      },
      streamSk,
    );
    const config = (joinedAtMs: number): SwPushConfig => ({
      policy: "generic",
      self,
      knownPeers: [],
      concord: [{
        pk: streamPk,
        convKey: bytesToHex(convKey),
        epoch: "1",
        communityId: COMMUNITY,
        channelId: CHANNEL,
        joinedAtMs,
      }],
    });

    expect((await preparePush({ scope: "c2", event: streamed as never }, config((sentAt + 60) * 1000)))?.drop)
      .toBe(true);
    expect((await preparePush({ scope: "c2", event: streamed as never }, config((sentAt - 60) * 1000)))?.drop)
      .not.toBe(true);
  });

  it("drops a muted Concord channel's message that still wakes the worker", async () => {
    // Reporter's scenario: a community (and a channel inside it) muted to
    // `nothing`, plus "All channel messages" off — yet notifications keep
    // arriving from that community.
    //
    // Muting drops a `nothing` channel from the gateway subscription, but a
    // subscription that lingers past the mute (the prune is gated on the watch
    // set being authoritative — see useNostrPush.ts) still wakes the device.
    // Before the fix the wrap reached the worker with NO matching stream in the
    // config, `prepareConcord` returned `undefined`, and the worker rendered
    // the gateway's visible static "New message" — a
    // notification from a muted community.
    //
    // The muted channel is now kept in the sealed config, flagged `muted`, so
    // `prepareConcord` opens the wrap and drops it — matching `prepareDm`, which
    // drops a `nothing` conversation on-device (pushRuntime.ts).
    const CHANNEL = "ab".repeat(32);
    const COMMUNITY = "cd".repeat(32);
    const streamSk = generateSecretKey();
    const streamPk = getPublicKey(streamSk);
    const convKey = getConversationKey(streamSk, streamPk);
    const authorSk = generateSecretKey();
    const authorPk = getPublicKey(authorSk);
    const rumor = {
      pubkey: authorPk,
      kind: 9,
      content: "chatter in a muted channel",
      tags: [["channel", CHANNEL], ["epoch", "1"]],
      created_at: now(),
    };
    const withId = { ...rumor, id: getEventHash(rumor as Parameters<typeof getEventHash>[0]) };
    const sealed = finalizeEvent(
      { kind: 20013, content: nip44Encrypt(JSON.stringify(withId), convKey), tags: [], created_at: rumor.created_at },
      authorSk,
    );
    const streamed = finalizeEvent(
      {
        kind: 1059,
        content: nip44Encrypt(JSON.stringify(sealed), convKey),
        tags: [["p", getPublicKey(generateSecretKey())]],
        created_at: now(),
      },
      streamSk,
    );

    // The stream reaches the worker (lingering subscription) but is muted: it is
    // kept in the sealed config, with its key, precisely so the worker can open
    // and drop it rather than fall back to the visible static wake-up.
    const p = await preparePush({ scope: "c2", event: streamed as never }, {
      policy: "generic",
      self: getPublicKey(generateSecretKey()),
      knownPeers: [],
      concord: [{
        pk: streamPk,
        convKey: bytesToHex(convKey),
        epoch: "1",
        communityId: COMMUNITY,
        channelId: CHANNEL,
        muted: true,
      }],
    });
    expect(p?.drop).toBe(true);
    // Still stored — a muted channel's timeline stays complete.
    const rows = await queryChannelRumors(COMMUNITY, CHANNEL, { limit: 10 });
    expect(rows.map((r) => r.content)).toContain("chatter in a muted channel");
  });
});

describe("napp.push.payload: the plane read off the event", () => {
  // Neither Tenna nor nostr-push2 says which subscription matched, so a push
  // carries no `scope`. The event itself decides.
  const selfSk = generateSecretKey();
  const self = getPublicKey(selfSk);
  const streamPk = getPublicKey(generateSecretKey());
  const cfg = (over: Partial<SwPushConfig> = {}): SwPushConfig => ({
    policy: "full",
    self,
    knownPeers: [],
    ...over,
  });
  const event = (kind: number, tags: string[][], sk = generateSecretKey()) =>
    finalizeEvent({ kind, content: "x", tags, created_at: now() }, sk);

  it("files a gift wrap addressed to the viewer as a DM", () => {
    expect(pushScope(event(1059, [["p", self]]), cfg())).toBe("dm");
  });

  it("files a wrap authored by a stream address as Concord, whatever it p-tags", () => {
    const streamSk = generateSecretKey();
    const wrapEvent = event(1059, [["p", streamPk]], streamSk);
    const stream = { pk: wrapEvent.pubkey } as SwConcordStream;
    expect(pushScope(wrapEvent, cfg({ concord: [stream] }))).toBe("c2");
  });

  it("places no wrap it cannot attribute", () => {
    expect(pushScope(event(1059, [["p", streamPk]]), cfg())).toBeUndefined();
    expect(pushScope(event(1059, [["p", self]]), null)).toBeUndefined();
  });

  it("files an h-tagged group kind as NIP-29, and a mention of the viewer as one", () => {
    expect(pushScope(event(9, [["h", "general"]]), cfg())).toBe("group");
    expect(pushScope(event(1111, [["h", "general"], ["p", self]]), cfg())).toBe("group-mention");
    expect(pushScope(event(9, [["h", "a"], ["h", "b"]]), cfg())).toBeUndefined();
    expect(pushScope(event(1, [["h", "general"]]), cfg())).toBeUndefined();
  });

  it("opens a DM that arrives with no scope", async () => {
    const senderSk = generateSecretKey();
    const senderPk = getPublicKey(senderSk);
    const dm = wrap(seal({
      pubkey: senderPk,
      kind: 14,
      content: "see you there",
      tags: [["p", self]],
      created_at: now(),
    }, senderSk, self), self);

    const prepared = await preparePush(
      { event: dm, relays: ["wss://relay.example"] },
      cfg({ sk: bytesToHex(selfSk), knownPeers: [senderPk] }),
    );
    expect(prepared?.line).toContain("see you there");
    expect(prepared?.roomKey).toBe(`dm:${senderPk}`);
  });

  it("names a NIP-29 room after the relay the event arrived from", async () => {
    const prepared = await preparePush(
      { event: event(9, [["h", "general"]]), relays: ["wss://relay-a.example"] },
      cfg(),
    );
    expect(prepared?.roomKey).toBe("h:wss://relay-a.example|general");
  });

  it("shows nothing for an event whose signature does not hold", async () => {
    // Through JSON, as a push arrives: nostr-tools caches a passed check on the
    // object itself, and a spread copy would inherit it.
    const forged = { ...JSON.parse(JSON.stringify(event(9, [["h", "general"]]))), content: "not what was signed" };
    const prepared = await preparePush({ event: forged, relays: ["wss://relay-a.example"] }, cfg());
    expect(prepared?.drop).toBe(true);
  });
});

describe("communityAvatarShown", () => {
  it("shows a community sender's avatar only for a known peer", () => {
    const known = "a".repeat(64);
    const cfg = { policy: "generic", self: "c".repeat(64), knownPeers: [known] } as SwPushConfig;
    expect(communityAvatarShown(known, cfg)).toBe(true);
    expect(communityAvatarShown("f".repeat(64), cfg)).toBe(false);
    expect(communityAvatarShown(known, null)).toBe(false);
  });

  it("shows every sender's avatar when the reader loads everyone's media", () => {
    const cfg = {
      policy: "generic",
      self: "c".repeat(64),
      knownPeers: [],
      mediaPolicy: { proxy: "", allCommunityAvatars: true },
    } as SwPushConfig;
    expect(communityAvatarShown("f".repeat(64), cfg)).toBe(true);
  });
});

describe("preparePush — profiles the device has never stored", () => {
  const relay = "wss://group.example";

  function profileEvent(sk: Uint8Array, metadata: Record<string, string>) {
    return finalizeEvent({ kind: 0, content: JSON.stringify(metadata), tags: [], created_at: now() }, sk);
  }

  function groupMessage(content: string, sk = generateSecretKey()) {
    return finalizeEvent({ kind: 9, content, tags: [["h", "lobby"]], created_at: now() }, sk);
  }

  it("asks the relays for a missing author, names them, and keeps the profile", async () => {
    const authorSk = generateSecretKey();
    const author = getPublicKey(authorSk);
    fetchProfilesMock.mockResolvedValueOnce([profileEvent(authorSk, { name: "Fiatjaf" })]);

    const prepared = await preparePush(
      { event: groupMessage("gm", authorSk), relays: [relay] },
      { policy: "generic", self: "c".repeat(64), knownPeers: [], profileRelays: ["wss://app.example"] },
    );

    expect(prepared?.line).toBe("Fiatjaf: gm");
    expect(fetchProfilesMock).toHaveBeenCalledWith([relay, "wss://app.example"], [author]);
    const store = await appEventStore();
    const [stored] = await store.query([{ kinds: [0], authors: [author] }]);
    expect(JSON.parse(stored.content).name).toBe("Fiatjaf");
  });

  it("does not ask again for a profile already stored", async () => {
    const authorSk = generateSecretKey();
    const store = await appEventStore();
    await store.event(profileEvent(authorSk, { name: "Stored" }));

    const prepared = await preparePush({ event: groupMessage("hi", authorSk), relays: [relay] }, null);
    expect(prepared?.line).toBe("Stored: hi");
    expect(fetchProfilesMock).not.toHaveBeenCalled();
  });

  it("resolves a nostr: mention to the mentioned user's name", async () => {
    const mentionedSk = generateSecretKey();
    const npub = nip19.npubEncode(getPublicKey(mentionedSk));
    fetchProfilesMock.mockResolvedValueOnce([profileEvent(mentionedSk, { display_name: "Team Soapbox" })]);

    const prepared = await preparePush(
      { event: groupMessage(`thanks nostr:${npub}! see https://ditto.pub/${npub}`), relays: [relay] },
      null,
    );
    expect(prepared?.line).toContain(`thanks @Team Soapbox! see https://ditto.pub/${npub}`);
  });

  it("keeps a mention nobody can name as its raw token", async () => {
    const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    const prepared = await preparePush(
      { event: groupMessage(`cc nostr:${npub}`), relays: [relay] },
      null,
    );
    expect(prepared?.line).toContain(`cc nostr:${npub}`);
    expect(prepared?.line).not.toContain("@Anonymous");
  });

  it("asks only the user's relays about a DM sender, never the inbox that delivered it", async () => {
    const senderSk = generateSecretKey();
    const senderPk = getPublicKey(senderSk);
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    fetchProfilesMock.mockResolvedValueOnce([profileEvent(senderSk, { name: "Ana" })]);
    const dm = wrap(seal({
      pubkey: senderPk,
      kind: 14,
      content: "hey",
      tags: [["p", recipientPk]],
      created_at: now(),
    }, senderSk, recipientPk), recipientPk);

    const prepared = await preparePush(
      { scope: "dm", event: dm, relays: ["wss://inbox.example"] },
      {
        policy: "generic",
        self: recipientPk,
        knownPeers: [senderPk],
        sk: bytesToHex(recipientSk),
        profileRelays: ["wss://app.example"],
      },
    );
    expect(prepared?.title).toBe("Ana");
    expect(fetchProfilesMock).toHaveBeenCalledWith(["wss://app.example"], [senderPk]);
  });
});
