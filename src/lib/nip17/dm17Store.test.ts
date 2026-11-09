import { IDBFactory } from "fake-indexeddb";
import { getPublicKey, generateSecretKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import {
  conversationFilters,
  countUnreadDm17Messages,
  dm17Store,
  dm17ToStored,
  onFreshDm17,
  queryDm17Conversations,
  queryDm17Messages,
  queryDm17Rumor,
  queryDm17Thread,
  queryDm17Timer,
  queryDm17Webxdc,
  readDm17Cursor,
  searchDm17Rumors,
  storedToDm17,
  sweepExpiredDm17Rumors,
  updateDm17Cursor,
  writeDm17Rumors,
} from "@/lib/nip17/dm17Store";
import {
  buildDmEditRumors,
  buildDmRumor,
  DM_RUMOR_KINDS,
  DM_THREAD_KINDS,
  dmChatTags,
  dmDeleteTags,
  dmReactionTags,
  dmTimerTags,
  dmWebxdcTags,
  KIND_DM_CHAT,
  KIND_DM_DELETE,
  KIND_DM_FILE,
  KIND_DM_REACTION,
  KIND_DM_TIMER,
  KIND_DM_WEBXDC,
  type OpenedDm,
} from "@/lib/nip17/protocol";
import { dmConvKey, dmPeersOf } from "@/lib/nip17/conversation";
import { dmThreadScope, onWireScopes, resetWireBus } from "@/wire/bus";

// The removed-message list reads localStorage, which this environment lacks.
const removedIds = vi.hoisted(() => new Set<string>());
vi.mock("@/lib/removedMessages", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/removedMessages")>()),
  isRemovedMessageId: (id: string) => removedIds.has(id),
}));

// A clean IndexedDB for the suite (the store singleton opens against it lazily).
(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const self = getPublicKey(generateSecretKey());
const alice = getPublicKey(generateSecretKey());
const bob = getPublicKey(generateSecretKey());

let clock = 1_700_000_000;

function opened(opts: { author: string; peer: string; kind?: number; content?: string; tags?: string[][] }): OpenedDm {
  const createdAt = ++clock;
  const kind = opts.kind ?? KIND_DM_CHAT;
  const content = opts.content ?? "hello";
  const tags = opts.tags ?? dmChatTags([opts.author === self ? opts.peer : self]);
  const rumor = buildDmRumor({ kind, content, tags, pubkey: opts.author, createdAt });
  return {
    rumorId: rumor.id,
    author: opts.author,
    kind,
    content,
    tags,
    createdAt,
    peers: [opts.peer],
    wrapId: `wrap-${rumor.id.slice(0, 8)}`,
  };
}

describe("dm17Store", () => {
  it("round-trips the stored codec without touching the rumor's tags", () => {
    const o = opened({ author: alice, peer: alice, content: "codec" });
    const stored = dm17ToStored(o);
    // Nothing is injected: the tags are the bytes the rumor's id commits to.
    expect(stored.tags).toEqual(o.tags);

    const back = storedToDm17(stored, self);
    // The partner is derived from the rumor (NIP-17 names it in `p`), and the
    // wrap id is transport provenance with no reader on this side of the store,
    // so it is not persisted and comes back empty.
    expect(back).toEqual({ ...o, wrapId: "" });
  });

  it("writes rumors and reads a thread scoped by peer", async () => {
    const fromAlice = opened({ author: alice, peer: alice, content: "hi from alice" });
    const toAlice = opened({ author: self, peer: alice, content: "hi back" });
    const fromBob = opened({ author: bob, peer: bob, content: "unrelated" });
    await writeDm17Rumors(self, [fromAlice, toAlice, fromBob]);

    const thread = await queryDm17Thread(self, [alice], { limit: 50 });
    const ids = thread.map((r) => r.rumorId).sort();
    expect(ids).toEqual([fromAlice.rumorId, toAlice.rumorId].sort());

    // A focused search hit bypasses the newest-first thread window, but remains
    // strictly scoped to the conversation named by the route.
    expect(await queryDm17Rumor(self, [alice], fromAlice.rumorId)).toEqual({
      ...fromAlice,
      wrapId: "",
    });
    expect(await queryDm17Rumor(self, [bob], fromAlice.rumorId)).toBeUndefined();
  });

  it("reads reply parents by id within one conversation, minus author deletes", async () => {
    // Its own viewer: the suite shares a store, and other tests list every conversation.
    const viewer = getPublicKey(generateSecretKey());
    const carol = getPublicKey(generateSecretKey());
    const dave = getPublicKey(generateSecretKey());
    const at = (o: OpenedDm): OpenedDm => ({ ...o, peers: [o.author === viewer ? o.peers[0] : o.author] });
    const kept = at(opened({ author: carol, peer: carol, content: "kept", tags: dmChatTags([viewer]) }));
    const deleted = at(opened({ author: carol, peer: carol, content: "deleted", tags: dmChatTags([viewer]) }));
    const forged = at(opened({ author: viewer, peer: carol, content: "someone else's delete", tags: dmChatTags([carol]) }));
    const elsewhere = at(opened({ author: dave, peer: dave, content: "other thread", tags: dmChatTags([viewer]) }));
    // Deletes land BEFORE their targets, as a newest-first backfill writes them.
    const ownDelete = opened({
      author: carol,
      peer: carol,
      kind: KIND_DM_DELETE,
      content: "",
      tags: dmDeleteTags([viewer], deleted.rumorId, KIND_DM_CHAT),
    });
    const notTheAuthors = opened({
      author: dave,
      peer: dave,
      kind: KIND_DM_DELETE,
      content: "",
      tags: dmDeleteTags([viewer], forged.rumorId, KIND_DM_CHAT),
    });
    await writeDm17Rumors(viewer, [ownDelete, notTheAuthors]);
    await writeDm17Rumors(viewer, [kept, deleted, forged, elsewhere]);

    const ids = [kept, deleted, forged, elsewhere].map((r) => r.rumorId);
    const found = await queryDm17Messages(viewer, [carol], ids);
    expect(found.map((r) => r.content).sort()).toEqual(["kept", "someone else's delete"]);
  });

  it("counts only incoming messages newer than a conversation's read stamp", async () => {
    const viewer = getPublicKey(generateSecretKey());
    const friend = getPublicKey(generateSecretKey());
    const first = opened({
      author: friend,
      peer: friend,
      content: "first unread",
      tags: dmChatTags([viewer]),
    });
    const outgoing = opened({
      author: viewer,
      peer: friend,
      content: "my reply",
      tags: dmChatTags([friend]),
    });
    const reaction = opened({
      author: friend,
      peer: friend,
      kind: KIND_DM_REACTION,
      content: "+",
      tags: dmReactionTags([viewer], first.rumorId, KIND_DM_CHAT),
    });
    const second = opened({
      author: friend,
      peer: friend,
      content: "second unread",
      tags: dmChatTags([viewer]),
    });
    await writeDm17Rumors(viewer, [first, outgoing, reaction, second]);

    expect(await countUnreadDm17Messages(viewer, [friend], 0)).toBe(2);
    expect(await countUnreadDm17Messages(viewer, [friend], first.createdAt)).toBe(1);
    expect(await countUnreadDm17Messages(viewer, [friend], second.createdAt)).toBe(0);
    expect(await countUnreadDm17Messages(viewer, [viewer], 0)).toBe(0);
  });

  it("filters conversation search before applying its result limit", async () => {
    const viewer = getPublicKey(generateSecretKey());
    const friend = getPublicKey(generateSecretKey());
    const requester = getPublicKey(generateSecretKey());
    const said = (author: string, peer: string, content: string): OpenedDm => {
      const createdAt = ++clock;
      const rumor = buildDmRumor({
        kind: KIND_DM_CHAT,
        content,
        tags: dmChatTags([author === viewer ? peer : viewer]),
        pubkey: author,
        createdAt,
      });
      return {
        rumorId: rumor.id,
        author,
        kind: KIND_DM_CHAT,
        content,
        tags: rumor.tags,
        createdAt,
        peers: [peer],
        wrapId: `wrap-${rumor.id.slice(0, 8)}`,
      };
    };

    const wanted = said(friend, friend, "launcher needle from a friend");
    const requestSpam = Array.from({ length: 45 }, (_, i) =>
      said(requester, requester, `launcher needle request ${i}`),
    );
    await writeDm17Rumors(viewer, [wanted, ...requestSpam]);

    const matches = await searchDm17Rumors(viewer, "launcher needle", {
      limit: 1,
      allowedConversationKeys: new Set([friend]),
    });
    expect(matches.map((match) => match.rumorId)).toEqual([wanted.rumorId]);
  });

  it("finds a match however many newer messages there are", async () => {
    const viewer = getPublicKey(generateSecretKey());
    const friend = getPublicKey(generateSecretKey());
    const said = (content: string): OpenedDm => {
      const createdAt = ++clock;
      const rumor = buildDmRumor({ kind: KIND_DM_CHAT, content, tags: dmChatTags([viewer]), pubkey: friend, createdAt });
      return {
        rumorId: rumor.id,
        author: friend,
        kind: KIND_DM_CHAT,
        content,
        tags: rumor.tags,
        createdAt,
        peers: [friend],
        wrapId: `wrap-${rumor.id.slice(0, 8)}`,
      };
    };
    const old = said("the fathometer reading");
    await writeDm17Rumors(viewer, [old, ...Array.from({ length: 40 }, (_, i) => said(`filler ${i}`))]);

    // `scan` bounds matches read, not how far back the history goes.
    const matches = await searchDm17Rumors(viewer, "Fathom", { scan: 10 });
    expect(matches.map((match) => match.rumorId)).toEqual([old.rumorId]);
    // Typed operators are words, not a negation or a term lookup.
    expect(await searchDm17Rumors(viewer, "-fathometer")).toHaveLength(1);
    expect(await searchDm17Rumors(viewer, "conv:fathometer")).toEqual([]);
  });

  it("rings the inbox and each affected thread after a durable write", async () => {
    const scopedSelf = getPublicKey(generateSecretKey());
    const scopedAlice = getPublicKey(generateSecretKey());
    const scopedBob = getPublicKey(generateSecretKey());
    resetWireBus();
    const seen = new Set<string>();
    const unsubscribe = onWireScopes((scopes) => {
      for (const scope of scopes) seen.add(scope);
    });

    try {
      await writeDm17Rumors(scopedSelf, [
        opened({
          author: scopedAlice,
          peer: scopedAlice,
          content: "scope alice",
          tags: dmChatTags([scopedSelf]),
        }),
        opened({
          author: scopedBob,
          peer: scopedBob,
          content: "scope bob",
          tags: dmChatTags([scopedSelf]),
        }),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 75));

      expect(seen).toEqual(
        new Set(["dm", dmThreadScope(scopedAlice), dmThreadScope(scopedBob)]),
      );
    } finally {
      unsubscribe();
      resetWireBus();
    }
  });

  it("groups conversations by peer, newest message first", async () => {
    const convos = await queryDm17Conversations(self);
    expect(convos.map((c) => c.key)).toEqual([bob, alice]);
    expect(convos[1].latest.content).toBe("hi back");
  });

  it("marks conversations the viewer has messaged as `mine`", async () => {
    const convos = await queryDm17Conversations(self);
    const byPeer = new Map(convos.map((c) => [c.key, c]));
    // alice's thread has a self-authored "hi back"; bob only messaged us.
    expect(byPeer.get(alice)?.mine).toBe(true);
    expect(byPeer.get(bob)?.mine).toBe(false);
  });

  it("keeps each account's messages in its own tenant", async () => {
    const other = getPublicKey(generateSecretKey());
    // Everything above was written as `self`. Another logged-in account reads
    // its own tenant, which has none of it — not a filtered view of one store.
    expect(await queryDm17Conversations(other)).toEqual([]);
    expect(await queryDm17Thread(other, [alice], { limit: 50 })).toEqual([]);
  });

  it("applies a kind-5 delete rumor to the author's own target only", async () => {
    const target = opened({ author: alice, peer: alice, content: "to be deleted" });
    const reaction = opened({
      author: alice,
      peer: alice,
      kind: KIND_DM_REACTION,
      content: "👍",
      tags: dmReactionTags([self], target.rumorId, KIND_DM_CHAT),
    });
    await writeDm17Rumors(self, [target, reaction]);

    // A FOREIGN delete (authored by someone else) must not remove it.
    const foreignDelete = opened({
      author: bob,
      peer: bob,
      kind: KIND_DM_DELETE,
      content: "",
      tags: dmDeleteTags([self], target.rumorId, KIND_DM_CHAT),
    });
    await writeDm17Rumors(self, [foreignDelete]);
    let thread = await queryDm17Thread(self, [alice], { limit: 50 });
    expect(thread.some((r) => r.rumorId === target.rumorId)).toBe(true);

    // The author's own delete removes it.
    const ownDelete = opened({
      author: alice,
      peer: alice,
      kind: KIND_DM_DELETE,
      content: "",
      tags: dmDeleteTags([self], target.rumorId, KIND_DM_CHAT),
    });
    await writeDm17Rumors(self, [ownDelete]);
    thread = await queryDm17Thread(self, [alice], { limit: 50 });
    expect(thread.some((r) => r.rumorId === target.rumorId)).toBe(false);
    // The reaction survives (deletes are per-target).
    expect(thread.some((r) => r.rumorId === reaction.rumorId)).toBe(true);
  });

  it("persists an edit as the replacement and removes the old rumor", async () => {
    const editor = getPublicKey(generateSecretKey());
    const original = opened({
      author: self,
      peer: editor,
      content: "uncorrected",
      tags: dmChatTags([editor], { replyTo: "parent" }),
    });
    await writeDm17Rumors(self, [original]);

    const { replacement, deletion } = buildDmEditRumors(
      dm17ToStored(original),
      [editor],
      "corrected",
      original.createdAt + 10,
    );
    await writeDm17Rumors(self, [
      storedToDm17(replacement, self),
      storedToDm17(deletion, self),
    ]);

    const thread = await queryDm17Thread(self, [editor], { limit: 50 });
    expect(thread.some((r) => r.rumorId === original.rumorId)).toBe(false);
    expect(thread).toContainEqual(expect.objectContaining({
      rumorId: replacement.id,
      content: "corrected",
      createdAt: original.createdAt,
      tags: expect.arrayContaining([["e", "parent"], ["edited", String(original.createdAt + 10)]]),
    }));
  });
});

describe("dm17Store disappearing messages", () => {
  const carol = getPublicKey(generateSecretKey());

  /** Put a stored rumor in directly, bypassing writeDm17Rumors' expiry guard. */
  async function forceStore(o: OpenedDm): Promise<void> {
    await dm17Store(self).event(dm17ToStored(o));
  }

  const now = () => Math.floor(Date.now() / 1000);

  it("refuses to persist an already-expired rumor", async () => {
    const expired = opened({
      author: carol,
      peer: carol,
      content: "should never land",
      tags: dmChatTags([self], { expiresAt: now() - 1 }),
    });
    await writeDm17Rumors(self, [expired]);
    const thread = await queryDm17Thread(self, [carol], { limit: 50 });
    expect(thread.some((r) => r.rumorId === expired.rumorId)).toBe(false);
  });

  it("stores and returns a message that has not expired yet", async () => {
    const live = opened({
      author: carol,
      peer: carol,
      content: "still here",
      tags: dmChatTags([self], { expiresAt: now() + 3600 }),
    });
    await writeDm17Rumors(self, [live]);
    const thread = await queryDm17Thread(self, [carol], { limit: 50 });
    expect(thread.some((r) => r.rumorId === live.rumorId)).toBe(true);
  });

  it("hides an expired rumor from reads and sweeps it off disk", async () => {
    const stale = opened({
      author: carol,
      peer: carol,
      content: "expired in storage",
      tags: dmChatTags([self], { expiresAt: now() - 1 }),
    });
    await forceStore(stale);

    // Present in the raw store...
    expect((await dm17Store(self).query([{ ids: [stale.rumorId] }])).length).toBe(1);
    // ...but never handed to a reader.
    const thread = await queryDm17Thread(self, [carol], { limit: 50 });
    expect(thread.some((r) => r.rumorId === stale.rumorId)).toBe(false);
    const convos = await queryDm17Conversations(self);
    expect(convos.find((c) => c.key === carol)?.latest.rumorId).not.toBe(stale.rumorId);

    // Hiding is not disappearing: the sweep removes the plaintext.
    expect(await sweepExpiredDm17Rumors(self)).toBeGreaterThan(0);
    expect((await dm17Store(self).query([{ ids: [stale.rumorId] }])).length).toBe(0);
  });

  it("keeps `mine` when the viewer's own newest message has expired", async () => {
    // `convmine:` collapses to exactly ONE row per conversation — the viewer's
    // newest own message — so when disappearing messages are on and that row has
    // expired but not yet been swept, there is no older row to fall back to.
    // Reading `mine` off the live rows only would drop a thread the viewer has
    // written in: the DMs page files it under requests, and the push gateways
    // read its sender as a stranger.
    const dave = getPublicKey(generateSecretKey());
    await forceStore(opened({
      author: self,
      peer: dave,
      content: "mine, now expired",
      tags: dmChatTags([dave], { expiresAt: now() - 1 }),
    }));
    // Dave answers, and his reply is live — so the conversation IS listed, and
    // its newest row is one the viewer did not write.
    await writeDm17Rumors(self, [
      opened({ author: dave, peer: dave, content: "his live reply" }),
    ]);

    const row = (await queryDm17Conversations(self)).find((c) => c.key === dave);
    expect(row?.latest.content).toBe("his live reply");
    expect(row?.mine).toBe(true);
  });

  it("lists no conversation whose every message its author deleted", async () => {
    // Its own viewer: other tests list every conversation of the shared one.
    const viewer = getPublicKey(generateSecretKey());
    const stranger = getPublicKey(generateSecretKey());
    const friend = getPublicKey(generateSecretKey());
    const forger = getPublicKey(generateSecretKey());
    const from = (author: string, content: string): OpenedDm =>
      ({ ...opened({ author, peer: author, content, tags: dmChatTags([viewer]) }), peers: [author] });
    const deleteOf = (author: string, target: OpenedDm): OpenedDm => ({
      ...opened({ author, peer: author, kind: KIND_DM_DELETE, content: "", tags: dmDeleteTags([viewer], target.rumorId, KIND_DM_CHAT) }),
      peers: [author],
    });

    const spam = [from(stranger, "spam 1"), from(stranger, "spam 2")];
    const older = from(friend, "still here");
    const retracted = from(friend, "retracted");
    const forgedTarget = from(forger, "not theirs to delete");
    // Deletes land BEFORE their targets, so the store keeps the targets.
    await writeDm17Rumors(viewer, [
      ...spam.map((m) => deleteOf(stranger, m)),
      deleteOf(friend, retracted),
      deleteOf(stranger, forgedTarget),
    ]);
    await writeDm17Rumors(viewer, [...spam, older, retracted, forgedTarget]);

    const rows = await queryDm17Conversations(viewer);
    expect(rows.find((r) => r.key === stranger)).toBeUndefined();
    expect(rows.find((r) => r.key === friend)?.latest.content).toBe("still here");
    expect(rows.find((r) => r.key === forger)?.latest.content).toBe("not theirs to delete");
  });

  it("reads back the newest timer change, whichever side set it", async () => {
    expect(await queryDm17Timer(self, [carol])).toBeUndefined();

    await writeDm17Rumors(self, [
      opened({ author: self, peer: carol, kind: KIND_DM_TIMER, content: "", tags: dmTimerTags([carol], 86400) }),
    ]);
    expect(await queryDm17Timer(self, [carol])).toBe(86400);

    // The peer turns it off; the newer change wins.
    await writeDm17Rumors(self, [
      opened({ author: carol, peer: carol, kind: KIND_DM_TIMER, content: "", tags: dmTimerTags([self], 0) }),
    ]);
    expect(await queryDm17Timer(self, [carol])).toBe(0);

    // A timer set on one conversation never leaks into another.
    expect(await queryDm17Timer(self, [bob])).toBeUndefined();
  });
});

describe("dm17Store relay cursors", () => {
  it("advances each successful relay independently and preserves the others", async () => {
    const viewer = getPublicKey(generateSecretKey());
    await updateDm17Cursor(viewer, {
      newest: 200,
      oldest: 100,
      exhausted: false,
      relayNewest: { "wss://fast.example": 200 },
    });
    await updateDm17Cursor(viewer, {
      newest: 180,
      relayNewest: {
        "wss://fast.example": 150,
        "wss://slow.example": 180,
      },
    });

    expect(await readDm17Cursor(viewer)).toEqual({
      newest: 200,
      oldest: 100,
      exhausted: false,
      relayNewest: {
        "wss://fast.example": 200,
        "wss://slow.example": 180,
      },
    });
  });

  it("drops watermarks for relays outside pruneRelaysTo and keeps the rest advancing", async () => {
    const viewer = getPublicKey(generateSecretKey());
    await updateDm17Cursor(viewer, {
      newest: 200,
      oldest: 100,
      exhausted: false,
      relayNewest: { "wss://kept.example": 200, "wss://removed.example": 150 },
    });
    await updateDm17Cursor(
      viewer,
      { relayNewest: { "wss://kept.example": 210 } },
      { pruneRelaysTo: ["wss://kept.example"] },
    );

    expect((await readDm17Cursor(viewer))?.relayNewest).toEqual({
      "wss://kept.example": 210,
    });
  });

  it("persists per-relay full-scan times monotonically, pruned like the watermarks", async () => {
    const viewer = getPublicKey(generateSecretKey());
    await updateDm17Cursor(viewer, {
      relayFullScanAt: { "wss://a.example": 5_000, "wss://b.example": 7_000 },
    });
    await updateDm17Cursor(
      viewer,
      { relayFullScanAt: { "wss://a.example": 4_000 } },
      { pruneRelaysTo: ["wss://a.example"] },
    );

    expect((await readDm17Cursor(viewer))?.relayFullScanAt).toEqual({ "wss://a.example": 5_000 });
  });

  it("leaves legacy global progress unattributed so every relay gets a recovery scan", async () => {
    const viewer = getPublicKey(generateSecretKey());
    await updateDm17Cursor(viewer, {
      newest: 300,
      oldest: 100,
      exhausted: true,
    });

    const cursor = await readDm17Cursor(viewer);
    expect(cursor?.newest).toBe(300);
    expect(cursor?.relayNewest).toBeUndefined();
  });
});

describe("dm17Store note to self", () => {
  // Its own account: the conversation with yourself is read with `peer ===
  // self`, and the shared fixtures above would make "only the notes" trivially
  // true by having nothing else to leak in.
  const me = getPublicKey(generateSecretKey());
  const friend = getPublicKey(generateSecretKey());

  it("reads back the notes addressed to yourself, and nothing else you sent", async () => {
    const note = opened({ author: me, peer: me, tags: dmChatTags([me]), content: "milk, eggs" });
    const toFriend = opened({ author: me, peer: friend, tags: dmChatTags([friend]), content: "sent to a person" });
    const fromFriend = opened({ author: friend, peer: friend, tags: dmChatTags([me]), content: "received" });
    await writeDm17Rumors(me, [note, toFriend, fromFriend]);

    // The general two-direction filter pair degenerates for a self thread: its
    // incoming half is `authors: [me]` unqualified, which is every DM this
    // account has ever SENT. Only the `p`-scoped half may run.
    const thread = await queryDm17Thread(me, [me], { limit: 50 });
    expect(thread.map((r) => r.content)).toEqual(["milk, eggs"]);
  });

  it("lists the notes as an ordinary conversation the viewer authored", async () => {
    const convos = await queryDm17Conversations(me);
    const notes = convos.find((c) => c.key === me);
    expect(notes?.latest.content).toBe("milk, eggs");
    // `mine` is what keeps it out of the request tier.
    expect(notes?.mine).toBe(true);
  });

  it("keeps a timer set with a person out of the notes", async () => {
    await writeDm17Rumors(me, [
      opened({ author: me, peer: friend, kind: KIND_DM_TIMER, content: "", tags: dmTimerTags([friend], 3600) }),
    ]);
    expect(await queryDm17Timer(me, [friend])).toBe(3600);
    expect(await queryDm17Timer(me, [me])).toBeUndefined();
  });
});

// Slower than the unit tests above on purpose: these are IndexedDB round-trips
// against the store the rest of this file has been filling, so they carry an
// explicit timeout rather than flaking at vitest's 5s default under a loaded
// full-suite run.
describe("group conversations", () => {
  const me = getPublicKey(generateSecretKey());
  const ana = getPublicKey(generateSecretKey());
  const ben = getPublicKey(generateSecretKey());
  const cy = getPublicKey(generateSecretKey());

  /**
   * An opened rumor addressed to an explicit room (`recipients` are its `p`
   * tags). `peers` comes from the real derivation rather than being asserted
   * here, so these rows are exactly what `openDmWrap` would have produced.
   */
  function room(
    author: string,
    recipients: string[],
    content: string,
    kind = KIND_DM_CHAT,
    tags?: string[][],
  ): OpenedDm {
    const createdAt = ++clock;
    const rumorTags = tags ?? dmChatTags(recipients);
    return {
      rumorId: `${author.slice(0, 4)}-${content}-${createdAt}`,
      author,
      kind,
      content,
      tags: rumorTags,
      createdAt,
      peers: dmPeersOf({ pubkey: author, tags: rumorTags }, me)!,
      wrapId: "",
    };
  }

  it("keeps a group thread separate from its members' 1:1s", async () => {
    // The three conversations that share people: Ana alone, Ben alone, and the
    // room with both. A NIP-01 filter cannot distinguish them at all, so what
    // is under test is the derived term index the read seeks instead (see
    // conversationFilters).
    const oneToOneAna = room(ana, [me], "just ana");
    const oneToOneBen = room(ben, [me], "just ben");
    const groupFromAna = room(ana, [me, ben], "ana to the group");
    const groupFromMe = room(me, [ana, ben], "me to the group");
    await writeDm17Rumors(me, [oneToOneAna, oneToOneBen, groupFromAna, groupFromMe]);

    expect((await queryDm17Thread(me, [ana], { limit: 50 })).map((m) => m.content))
      .toEqual(["just ana"]);
    expect((await queryDm17Thread(me, [ben], { limit: 50 })).map((m) => m.content))
      .toEqual(["just ben"]);
    expect(
      (await queryDm17Thread(me, [ana, ben].sort(), { limit: 50 })).map((m) => m.content).sort(),
    ).toEqual(["ana to the group", "me to the group"]);

    // Exact search hydration is scoped to the whole participant set too: a
    // shared member must not let a group hit leak into their 1:1, or vice versa.
    expect(await queryDm17Rumor(me, [ana, ben].sort(), groupFromAna.rumorId))
      .toEqual(expect.objectContaining({ content: "ana to the group" }));
    expect(await queryDm17Rumor(me, [ana], groupFromAna.rumorId)).toBeUndefined();
    expect(await queryDm17Rumor(me, [ana, ben].sort(), oneToOneAna.rumorId)).toBeUndefined();
  }, 30_000);

  it("lists a group as ONE conversation, not one row per member", async () => {
    const convos = await queryDm17Conversations(me);
    const keys = convos.map((c) => c.key);
    expect(keys).toContain(dmConvKey([ana, ben].sort()));
    expect(keys.filter((k) => k === dmConvKey([ana, ben].sort()))).toHaveLength(1);
    const group = convos.find((c) => c.key === dmConvKey([ana, ben].sort()))!;
    expect(group.peers).toEqual([ana, ben].sort());
    // We authored one of its messages, so it is ours.
    expect(group.mine).toBe(true);
  }, 30_000);

  it("does not let a superset room answer for a subset room", async () => {
    const bigger = room(ana, [me, ben, cy], "all three");
    await writeDm17Rumors(me, [bigger]);
    expect((await queryDm17Thread(me, [ana, ben].sort(), { limit: 50 })).map((m) => m.content))
      .not.toContain("all three");
    expect(
      (await queryDm17Thread(me, [ana, ben, cy].sort(), { limit: 50 })).map((m) => m.content),
    ).toEqual(["all three"]);
  }, 30_000);

  it("rings the group's own wire scope, not its members'", async () => {
    resetWireBus();
    const seen = new Set<string>();
    const off = onWireScopes((scopes) => {
      for (const scope of scopes) seen.add(scope);
    });
    try {
      await writeDm17Rumors(me, [room(ben, [me, ana], "ring")]);
      // The bus debounces, so the ring lands a tick later (see the scoped-write
      // test above).
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(seen).toEqual(new Set(["dm", dmThreadScope(dmConvKey([ana, ben].sort()))]));
    } finally {
      off();
      resetWireBus();
    }
  }, 30_000);

  it("scopes the disappearing timer to the group", async () => {
    const groupKey = [ana, ben].sort();
    expect(await queryDm17Timer(me, groupKey)).toBeUndefined();
    await writeDm17Rumors(me, [
      room(me, groupKey, "", KIND_DM_TIMER, dmTimerTags(groupKey, 3600)),
    ]);
    expect(await queryDm17Timer(me, groupKey)).toBe(3600);
    // The members' own 1:1s are untouched by it.
    expect(await queryDm17Timer(me, [ana])).toBeUndefined();
    expect(await queryDm17Timer(me, [ben])).toBeUndefined();
  }, 30_000);

  it("applies a group member's delete inside the group", async () => {
    const groupKey = [ana, ben].sort();
    const target = room(ana, [me, ben], "regrettable");
    await writeDm17Rumors(me, [target]);
    expect((await queryDm17Thread(me, groupKey, { limit: 50 })).map((m) => m.rumorId))
      .toContain(target.rumorId);
    await writeDm17Rumors(me, [
      room(ana, groupKey, "", KIND_DM_DELETE, dmDeleteTags(groupKey, target.rumorId, KIND_DM_CHAT)),
    ]);
    expect((await queryDm17Thread(me, groupKey, { limit: 50 })).map((m) => m.rumorId))
      .not.toContain(target.rumorId);
  }, 30_000);
});

describe("the conversation list is a list, not a sample", () => {
  const me = getPublicKey(generateSecretKey());
  const chatty = getPublicKey(generateSecretKey());
  const quiet = getPublicKey(generateSecretKey());

  function said(author: string, peer: string, content: string): OpenedDm {
    const createdAt = ++clock;
    const tags = dmChatTags([author === me ? peer : me]);
    const rumor = buildDmRumor({ kind: KIND_DM_CHAT, content, tags, pubkey: author, createdAt });
    return {
      rumorId: rumor.id,
      author,
      kind: KIND_DM_CHAT,
      content,
      tags,
      createdAt,
      peers: [peer],
      wrapId: `wrap-${rumor.id.slice(0, 8)}`,
    };
  }

  it("keeps an old conversation that a busy one has buried", async () => {
    // The viewer wrote to `quiet` once, long ago, and then had a long
    // conversation with `chatty`. The list used to read the newest 500 message
    // rumors, so a busy enough thread pushed everything else out of it — the
    // conversation vanished from the DMs page, and `mine` lost it too, which is
    // what the push gateways read as "this sender is a stranger".
    await writeDm17Rumors(me, [said(me, quiet, "long ago")]);
    const flood: OpenedDm[] = [];
    for (let i = 0; i < 40; i++) flood.push(said(chatty, chatty, `chatter ${i}`));
    await writeDm17Rumors(me, flood);

    const rows = await queryDm17Conversations(me);
    expect(rows.map((row) => row.key)).toEqual([chatty, quiet]);
    expect(rows.find((row) => row.key === quiet)?.mine).toBe(true);
    expect(rows.find((row) => row.key === quiet)?.latest.content).toBe("long ago");
  }, 30_000);

  it("counts conversations against a limit, not messages", async () => {
    // Two conversations exist, and the busiest one holds far more than two
    // messages: a limit of 2 is two CONVERSATIONS.
    const rows = await queryDm17Conversations(me, { limit: 2 });
    expect(rows.map((row) => row.key)).toEqual([chatty, quiet]);
  }, 30_000);

  it("lists no conversation for a reaction alone", async () => {
    // A reaction is in the conversation but is not a row the list can show, and
    // `convmsg:` is what keeps it from becoming one.
    const stranger = getPublicKey(generateSecretKey());
    const createdAt = ++clock;
    const tags = dmReactionTags([stranger], "some-id", KIND_DM_CHAT);
    const rumor = buildDmRumor({
      kind: KIND_DM_REACTION,
      content: "+",
      tags,
      pubkey: stranger,
      createdAt,
    });
    await writeDm17Rumors(me, [{
      rumorId: rumor.id,
      author: stranger,
      kind: KIND_DM_REACTION,
      content: "+",
      tags,
      createdAt,
      peers: [stranger],
      wrapId: `wrap-${rumor.id.slice(0, 8)}`,
    }]);

    const rows = await queryDm17Conversations(me);
    expect(rows.map((row) => row.key)).not.toContain(stranger);
  }, 30_000);

  it("agrees with the wire kinds about what a message is", async () => {
    // `conversation.ts` is dependency-free and so spells the numbers itself. A
    // policy that disagreed with the reader would file rows nothing lists.
    const { DM_MESSAGE_KINDS } = await import("@/lib/nip17/conversation");
    expect([...DM_MESSAGE_KINDS].sort()).toEqual([KIND_DM_CHAT, KIND_DM_FILE].sort());
  });
});

describe("Mini App state", () => {
  const viewer = getPublicKey(generateSecretKey());
  const friend = getPublicKey(generateSecretKey());
  const session = "A".repeat(52);
  const other = "B".repeat(52);

  it("keeps app state out of the conversation's page budget", () => {
    // A thread read is ONE filter with ONE `limit` shared by every kind in it,
    // so a kind listed here spends rows the conversation needs. App state is
    // unbounded in a way messages are not — a game can emit an update per move
    // — and read the other way its own history would be truncated to whatever
    // the messages left over. It is stored, and read by its own session query.
    const [filter] = conversationFilters(viewer, [friend], { limit: 50 });
    expect(filter.kinds).not.toContain(KIND_DM_WEBXDC);
    expect(filter.kinds).toEqual([...DM_THREAD_KINDS]);
    expect([...DM_RUMOR_KINDS].sort()).toEqual([...DM_THREAD_KINDS, KIND_DM_WEBXDC].sort());
  });

  it("reads one session's state, oldest first, and nobody else's", async () => {
    const mine = opened({
      author: viewer,
      peer: friend,
      kind: KIND_DM_WEBXDC,
      content: JSON.stringify({ move: 1 }),
      tags: dmWebxdcTags([friend], session, { summary: "1-0" }),
    });
    const theirs = opened({
      author: friend,
      peer: friend,
      kind: KIND_DM_WEBXDC,
      content: JSON.stringify({ move: 2 }),
      tags: dmWebxdcTags([viewer], session),
    });
    // A second game in the same conversation, and a chat message beside them.
    const elsewhere = opened({
      author: friend,
      peer: friend,
      kind: KIND_DM_WEBXDC,
      content: JSON.stringify({ move: 99 }),
      tags: dmWebxdcTags([viewer], other),
    });
    const chat = opened({
      author: friend,
      peer: friend,
      content: "your turn",
      tags: dmChatTags([viewer]),
    });
    await writeDm17Rumors(viewer, [mine, theirs, elsewhere, chat]);

    const rows = await queryDm17Webxdc(viewer, [friend], session);
    // Ascending: a webxdc update stream is a log the app replays in order and
    // assigns serials to by position.
    expect(rows.map((row) => row.rumorId)).toEqual([mine.rumorId, theirs.rumorId]);
    // The metadata survives the round trip — it is webxdc's `sendUpdate`
    // payload, not decoration.
    expect(rows[0].tags).toContainEqual(["summary", "1-0"]);

    // And the thread it shares a conversation with never sees any of it.
    const thread = await queryDm17Thread(viewer, [friend], { limit: 50 });
    expect(thread.map((row) => row.rumorId)).toEqual([chat.rumorId]);
  });

  it("names no session at all rather than reading every game", async () => {
    expect(await queryDm17Webxdc(viewer, [friend], "")).toEqual([]);
  });
});

describe("the conversation list read", () => {
  const viewer = getPublicKey(generateSecretKey());
  const peer = getPublicKey(generateSecretKey());
  const said = (content: string): OpenedDm => {
    const o = opened({ author: peer, peer, content, tags: dmChatTags([viewer]) });
    return o;
  };
  const collapseReads = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([filters]) => (filters as Array<{ search?: string }>).some((f) => f.search?.startsWith("distinct:"))).length;

  it("is shared by concurrent callers, each getting rows of its own", async () => {
    await writeDm17Rumors(viewer, [said("first")]);
    const store = dm17Store(viewer);
    const query = vi.spyOn(store.constructor.prototype, "query");
    try {
      const [a, b] = await Promise.all([queryDm17Conversations(viewer), queryDm17Conversations(viewer)]);
      expect(collapseReads(query)).toBe(1);
      expect(a).toEqual(b);
      expect(a[0]).not.toBe(b[0]);
    } finally {
      query.mockRestore();
    }
  });

  it("is started afresh by a caller arriving after a write, which it then sees", async () => {
    const before = queryDm17Conversations(viewer);
    const newest = said("written meanwhile");
    await writeDm17Rumors(viewer, [newest]);
    const after = await queryDm17Conversations(viewer);
    await before;
    expect(after.find((c) => c.peers.includes(peer))?.latest.rumorId).toBe(newest.rumorId);
  });

  it("lets a caller's abort reject only that caller", async () => {
    const controller = new AbortController();
    const aborted = queryDm17Conversations(viewer, { signal: controller.signal });
    const other = queryDm17Conversations(viewer);
    controller.abort();
    await expect(aborted).rejects.toBeDefined();
    expect((await other).length).toBeGreaterThan(0);
  });

  it("holds a message handed over before its commit, even against a read begun before it", async () => {
    const heard: string[] = [];
    const off = onFreshDm17(viewer, (fresh) => heard.push(...fresh.map((o) => o.rumorId)));
    try {
      const before = queryDm17Conversations(viewer);
      const newest = said("before the commit");
      const write = writeDm17Rumors(viewer, [newest]);
      // Heard at once, ahead of the commit.
      expect(heard).toEqual([newest.rumorId]);
      expect((await before).find((c) => c.peers.includes(peer))?.latest.rumorId).toBe(newest.rumorId);
      await write;
      expect((await queryDm17Conversations(viewer)).find((c) => c.peers.includes(peer))?.latest.rumorId).toBe(newest.rumorId);
    } finally {
      off();
    }
  });

  it("never hands over a message removed from this device", async () => {
    const heard: string[] = [];
    const off = onFreshDm17(viewer, (fresh) => heard.push(...fresh.map((o) => o.rumorId)));
    const gone = said("removed");
    removedIds.add(gone.rumorId);
    try {
      await writeDm17Rumors(viewer, [gone]);
      expect(heard).toEqual([]);
    } finally {
      off();
      removedIds.delete(gone.rumorId);
    }
  });
});
