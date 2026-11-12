/**
 * Behavioral parity with Vector v0.5.0-3 and CORD-03/04 at concord#25 for Channel
 * permissions, sealed Private Channel metadata, Categories and key delivery.
 * `it.fails` marks what Armada still gets wrong (see roster.parity.test.ts).
 */
import { describe, expect, it } from "vitest";

import { groupChannelsByCategory } from "@/concord/lib/channelCategory";
import { openChannelSeal, sealChannelMetadata } from "@/concord/lib/channelSeal";
import { mayHideIn, sendDeniedIn } from "@/concord/lib/channelJudges";
import { channelsView, visibleChannels } from "@/concord/lib/community";
import { buildConcordSubs } from "@/concord/lib/concordNotifications";
import { foldControlState, readChannelContent } from "@/concord/lib/control";
import { parseDelivery } from "@/concord/lib/delivery";
import { bytesToHex, channelGroupKey, random32 } from "@/concord/lib/derive";
import { overwriteLocator, overwriteToJSON } from "@/concord/lib/roster";
import { channelPermissions, Permissions } from "@/concord/lib/roles";
import type { OpenedEvent } from "@/concord/lib/stream";
import type { PrivateChannelKey } from "@/concord/lib/types";
import { headFloor, hexKey, heldCommunity, rankedCommunity, type TestCommunity } from "@/test/concordEditions";

const MANAGER_BITS = Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS;

function sealedChannel(c: TestCommunity, author: string, cite: Parameters<TestCommunity["edition"]>[0]["cite"], name: string, extra: { creator?: string; publicUntil?: number; topic?: string } = {}) {
  const id = random32();
  const key = random32();
  const { topic, ...sealExtra } = extra;
  const content = sealChannelMetadata({ name, private: true, ...(topic !== undefined ? { topic } : {}) }, key, id, 1n, undefined, sealExtra);
  const edition = c.edition({ vsk: "2", eid: id, author, cite, content });
  const held: PrivateChannelKey = { id, key, epoch: 1n, name: "" };
  return { id, idHex: bytesToHex(id), key, edition, held, content };
}

function publicChannel(c: TestCommunity, name: string) {
  const id = random32();
  return { id, idHex: bytesToHex(id), edition: c.edition({ vsk: "2", eid: id, author: c.owner, content: { name, private: false } }) };
}

describe("a Private Channel's sealed creator (CORD-04 §8, Vector `authorized.creators`)", () => {
  it("lets a non-owner creator holding MANAGE_CHANNELS see the Private Channel they made", () => {
    const { c, admin, base, grant } = rankedCommunity(MANAGER_BITS);
    const ch = sealedChannel(c, admin, grant, "staff-room", { creator: admin });
    const folded = foldControlState([...base, ch.edition], c.id, c.owner, undefined, undefined, { heldChannels: [ch.held] });
    const view = channelsView(heldCommunity(c, [ch.held]), folded);
    expect(visibleChannels(view, folded, admin).map((v) => v.idHex)).toContain(ch.idHex);
  });

  it("gives that creator SEND_MESSAGES in their own Channel, so other readers don't collapse their posts", () => {
    const { c, admin, base, grant } = rankedCommunity(MANAGER_BITS);
    const ch = sealedChannel(c, admin, grant, "staff-room", { creator: admin });
    const folded = foldControlState([...base, ch.edition], c.id, c.owner, undefined, undefined, { heldChannels: [ch.held] });
    channelsView(heldCommunity(c, [ch.held]), folded);
    expect(channelPermissions(folded.roster, folded.ownerHex, admin, ch.idHex, true) & Permissions.SEND_MESSAGES).not.toBe(0n);
  });
});

describe("the opened-seal memo", () => {
  it("doesn't open Channel B's edition as Channel A's because B carries A's ciphertext verbatim", () => {
    const { c, admin, grant } = rankedCommunity(MANAGER_BITS);
    const a = sealedChannel(c, c.owner, undefined, "secret-plans");
    const b = sealedChannel(c, admin, grant, "decoy");
    expect(openChannelSeal({ epoch: 1n, sealed: JSON.parse(a.content).sealed }, a.held)?.metadata.name).toBe("secret-plans");
    // B's first edition replays A's seal; only A's key opens it.
    expect(openChannelSeal({ epoch: 1n, sealed: JSON.parse(a.content).sealed }, b.held)).toBeUndefined();
  });

  it("tries a seal again once the reader holds the right key (CORD-03 §2: 'tries again whenever it folds')", () => {
    const { c } = rankedCommunity(MANAGER_BITS);
    const a = sealedChannel(c, c.owner, undefined, "secret-plans");
    const sealed = { epoch: 1n, sealed: JSON.parse(a.content).sealed };
    expect(openChannelSeal(sealed, { ...a.held, key: random32() })).toBeUndefined();
    expect(openChannelSeal(sealed, a.held)?.metadata.name).toBe("secret-plans");
  });
});

describe("reading Channel editions", () => {
  it("takes the sealed form whichever Roster the Community folds (CORD-03 §2, Vector `parse_sealed_channel_meta`)", () => {
    const { c } = rankedCommunity(MANAGER_BITS);
    const a = sealedChannel(c, c.owner, undefined, "secret-plans");
    expect(readChannelContent(a.content)?.sealed).toBeDefined();
  });

  it("normalizes an opened seal like a plain edition: an empty topic reads as absent (Vector `sanitize_channel_metadata`)", () => {
    const { c, base } = rankedCommunity(MANAGER_BITS);
    const ch = sealedChannel(c, c.owner, undefined, "secret-plans", { topic: "" });
    const folded = foldControlState([...base, ch.edition], c.id, c.owner);
    const shown = channelsView(heldCommunity(c, [ch.held]), folded).find((v) => v.idHex === ch.idHex);
    expect(shown?.name).toBe("secret-plans");
    expect(shown?.topic).toBeUndefined();
  });

  it("normalizes an opened seal's topic past 1024 bytes away", () => {
    const { c, base } = rankedCommunity(MANAGER_BITS);
    const ch = sealedChannel(c, c.owner, undefined, "secret-plans", { topic: "x".repeat(1025) });
    const folded = foldControlState([...base, ch.edition], c.id, c.owner);
    expect(channelsView(heldCommunity(c, [ch.held]), folded).find((v) => v.idHex === ch.idHex)?.topic).toBeUndefined();
  });

  it("takes a plain `private: false` edition over a sealed head as the Channel made public again (CORD-03 §2)", () => {
    const { c, base } = rankedCommunity(MANAGER_BITS);
    const ch = sealedChannel(c, c.owner, undefined, "vault");
    const opened = c.edition({ vsk: "2", eid: ch.id, author: c.owner, prev: ch.edition, content: { name: "vault", private: false } });
    const folded = foldControlState([...base, ch.edition, opened], c.id, c.owner, undefined, undefined, { heldChannels: [ch.held] });
    const community = heldCommunity(c, [ch.held]);
    const shown = channelsView(community, folded).find((v) => v.idHex === ch.idHex)!;
    expect(shown.isPrivate).toBe(false);
    expect(shown.current?.group.pk).toBe(channelGroupKey(community.root, ch.id, 0n).pk);
    // The private era stays readable to its key holders.
    expect(shown.streams.map((s) => s.group.pk)).toContain(channelGroupKey(ch.key, ch.id, 1n).pk);
    expect(visibleChannels([shown], folded, hexKey()).map((v) => v.idHex)).toEqual([ch.idHex]);
  });

  it("reads a converted Private Channel's public era at the root planes, before public_until (CORD-03 §2)", () => {
    const { c, base } = rankedCommunity(MANAGER_BITS);
    const ch = sealedChannel(c, c.owner, undefined, "was-public", { publicUntil: 1_700_000_000 });
    const folded = foldControlState([...base, ch.edition], c.id, c.owner);
    const community = heldCommunity(c, [ch.held]);
    const shown = channelsView(community, folded).find((v) => v.idHex === ch.idHex)!;
    const rootPk = channelGroupKey(community.root, ch.id, 0n).pk;
    expect(shown.streams.map((s) => s.group.pk)).toContain(rootPk);
  });
});

describe("Categories and the sidebar", () => {
  it("keeps two Categories that share a name apart (CORD-03 §4 Categories are ids; mirrors ConcordPage's grouping call)", () => {
    const { c, base } = rankedCommunity(MANAGER_BITS);
    const catA = hexKey();
    const catB = hexKey();
    const cats = [catA, catB].map((id, i) => c.edition({ vsk: "15", eid: id, author: c.owner, content: { name: "Voice", position: i === 0 ? "a" : "b" } }));
    const chans = [catA, catB].map((cat, i) => c.edition({ vsk: "2", eid: random32(), author: c.owner, content: { name: `room-${i}`, private: false, category: cat } }));
    const folded = foldControlState([...base, ...cats, ...chans], c.id, c.owner);
    const view = channelsView(heldCommunity(c), folded);
    expect(groupChannelsByCategory(view, (ch) => ch.category).categories).toHaveLength(2);
  });

  it("orders names by UTF-8 bytes, not UTF-16 code units (CORD-03 §2)", () => {
    const { c, base } = rankedCommunity(MANAGER_BITS);
    const astral = publicChannel(c, "\u{1F600}");
    const bmp = publicChannel(c, "\uFF61");
    const folded = foldControlState([...base, astral.edition, bmp.edition], c.id, c.owner);
    // U+FF61 is EF BD A1 in UTF-8, before U+1F600's F0 9F 98 80.
    expect(channelsView(heldCommunity(c), folded).map((v) => v.name)).toEqual(["\uFF61", "\u{1F600}"]);
  });

  it("registers no notification for a public Channel the viewer can't view (CORD-04 §8 honest-client hiding)", () => {
    const { c, base } = rankedCommunity(MANAGER_BITS);
    const hidden = publicChannel(c, "mods-only");
    const o = { scope: hidden.idHex, target: { kind: "everyone" as const }, allow: 0n, deny: Permissions.VIEW_CHANNEL };
    const deny = c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: c.owner, content: overwriteToJSON(o) });
    const folded = foldControlState([...base, hidden.edition, deny], c.id, c.owner);
    const viewer = hexKey();
    expect(channelPermissions(folded.roster, folded.ownerHex, viewer, hidden.idHex, false)).toBe(0n);
    expect(buildConcordSubs(heldCommunity(c), folded, undefined, viewer).subs.map((s) => s.channelId)).not.toContain(hidden.idHex);
  });
});

describe("parsing a delivery, against Vector `parse_access_delivery`", () => {
  const opened = (tags: string[][], content = "[]"): OpenedEvent =>
    ({ kind: 3303, tags, content, author: hexKey(), rumorId: hexKey(), createdAt: 1, ms: 1000 }) as unknown as OpenedEvent;
  const scope = hexKey();

  it("refuses a repeated delivery, scope or newepoch tag (Vector `unique_tag`)", () => {
    expect(parseDelivery(opened([["delivery", "access"], ["scope", scope], ["scope", hexKey()], ["newepoch", "1"]]))).toBeUndefined();
    expect(parseDelivery(opened([["delivery", "access"], ["scope", scope], ["newepoch", "1"], ["newepoch", "2"]]))).toBeUndefined();
  });

  it("refuses more than 120 blobs (Vector `MAX_REKEY_BLOBS_RECEIVED`)", () => {
    const blobs = Array.from({ length: 121 }, () => ({ locator: hexKey(), wrapped: "x" }));
    expect(parseDelivery(opened([["delivery", "access"], ["scope", scope], ["newepoch", "1"]], JSON.stringify(blobs)))).toBeUndefined();
  });

  it("refuses a blob array holding a malformed blob, or content that isn't an array (serde `Vec<RekeyBlob>`)", () => {
    expect(parseDelivery(opened([["delivery", "access"], ["scope", scope], ["newepoch", "1"]], JSON.stringify([{ locator: 5 }])))).toBeUndefined();
    expect(parseDelivery(opened([["delivery", "access"], ["scope", scope], ["newepoch", "1"]], "{}"))).toBeUndefined();
  });

  it("refuses a malformed writer tag rather than dropping it", () => {
    expect(parseDelivery(opened([["delivery", "writer"], ["scope", scope], ["newepoch", "1"], ["writer", "zz"]]))).toBeUndefined();
  });
});

describe("moderation hides judge MANAGE_MESSAGES in the Channel (CORD-03 §3, Vector `can_hide_in_channel`)", () => {
  function setup(o: (ch: string, roleId: string) => { allow: bigint; deny: bigint }, bits = Permissions.MANAGE_MESSAGES) {
    const { c, admin, adminRole, base } = rankedCommunity(bits);
    const ch = publicChannel(c, "general");
    const ow = { scope: ch.idHex, target: { kind: "role" as const, id: adminRole }, ...o(ch.idHex, adminRole) };
    const edition = c.edition({ vsk: "14", eid: overwriteLocator(c.id, ow), author: c.owner, content: overwriteToJSON(ow) });
    const folded = foldControlState([...base, ch.edition, edition], c.id, c.owner);
    return { folded, admin, ch, other: publicChannel(c, "other") };
  }

  it("refuses a hide in a Channel whose overwrite denies the moderator MANAGE_MESSAGES", () => {
    const { folded, admin, ch } = setup(() => ({ allow: 0n, deny: Permissions.MANAGE_MESSAGES }));
    expect(mayHideIn(folded, admin, hexKey(), ch.idHex)).toBe(false);
  });

  it("honours one in a Channel whose overwrite allows a member without it server-wide", () => {
    const { folded, admin, ch, other } = setup(() => ({ allow: Permissions.MANAGE_MESSAGES, deny: 0n }), Permissions.SEND_MESSAGES);
    expect(mayHideIn(folded, admin, hexKey(), ch.idHex)).toBe(true);
    expect(mayHideIn(folded, admin, hexKey(), other.idHex)).toBe(false);
  });

  it("keeps the outrank server-wide: an allow doesn't reach the owner or a higher rank", () => {
    const { folded, admin, ch } = setup(() => ({ allow: Permissions.MANAGE_MESSAGES, deny: 0n }), Permissions.SEND_MESSAGES);
    expect(mayHideIn(folded, admin, folded.ownerHex!, ch.idHex)).toBe(false);
    expect(mayHideIn(folded, folded.ownerHex!, admin, ch.idHex)).toBe(true);
  });
});

describe("posts readers collapse ring nobody (CORD-04 §8, Vector `post_silenced`)", () => {
  it("lists exactly the members denied SEND in an open Channel, and nobody in a closed one", () => {
    const { c, base, admin, adminRole } = rankedCommunity(Permissions.SEND_MESSAGES);
    const open = publicChannel(c, "open");
    const muted = hexKey();
    const deny = { scope: open.idHex, target: { kind: "member" as const, id: muted }, allow: 0n, deny: Permissions.SEND_MESSAGES };
    const roleDeny = { scope: open.idHex, target: { kind: "role" as const, id: adminRole }, allow: 0n, deny: Permissions.SEND_MESSAGES };
    const editions = [deny, roleDeny].map((o) => c.edition({ vsk: "14", eid: overwriteLocator(c.id, o), author: c.owner, content: overwriteToJSON(o) }));
    const folded = foldControlState([...base, open.edition, ...editions], c.id, c.owner);
    expect(sendDeniedIn(folded, open.idHex)).toEqual([admin, muted].sort());

    const closed = publicChannel(c, "closed");
    const shut = { scope: closed.idHex, target: { kind: "everyone" as const }, allow: 0n, deny: Permissions.SEND_MESSAGES };
    const f2 = foldControlState([...base, closed.edition, c.edition({ vsk: "14", eid: overwriteLocator(c.id, shut), author: c.owner, content: overwriteToJSON(shut) })], c.id, c.owner);
    expect(sendDeniedIn(f2, closed.idHex)).toEqual([]);
  });
});

describe("a fork's head is what applies (Vector `apply_control_fold`)", () => {
  it("folds a Category and a Channel from their head, not a losing sibling at the same version", () => {
    const { c, base, admin, grant } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const cat = random32();
    const v1 = c.edition({ vsk: "15", eid: cat, author: c.owner, content: { name: "Staff", position: "9" } });
    const ownerV2 = c.edition({ vsk: "15", eid: cat, author: c.owner, prev: v1, content: { name: "Voice", position: "1" } });
    const adminV2 = c.edition({ vsk: "15", eid: cat, author: admin, cite: grant, prev: v1, content: { name: "Voice" } });
    for (const order of [[ownerV2, adminV2], [adminV2, ownerV2]]) {
      const folded = foldControlState([...base, v1, ...order], c.id, c.owner);
      const head = folded.heads.get(bytesToHex(cat))!;
      const headEd = [ownerV2, adminV2].find((e) => bytesToHex(e.selfHash!) === bytesToHex(head.hash))!;
      const want = (JSON.parse(headEd.content) as { position?: string }).position;
      expect(folded.categories?.get(bytesToHex(cat))?.position).toBe(want);
    }
  });
});

describe("a deleted Channel's deletion and its settled head (Vector `apply_control_fold`, CORD-04 §2)", () => {
  it("counts a served deletion below the floor, and heads the entity at its newest deletion", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = random32();
    const v1 = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "a", private: false } });
    const v2 = c.edition({ vsk: "2", eid: ch, author: c.owner, prev: v1, content: { name: "a", private: false, deleted: true } });
    const v3 = c.edition({ vsk: "2", eid: ch, author: c.owner, prev: v2, content: { name: "b", private: false } });
    const full = foldControlState([...base, v1, v2, v3], c.id, c.owner);
    expect(bytesToHex(full.heads.get(bytesToHex(ch))!.hash)).toBe(bytesToHex(v2.selfHash!));
    // Floored past v2, served v2 and an edition on v3: still deleted.
    const v4 = c.edition({ vsk: "2", eid: ch, author: c.owner, prev: v3, content: { name: "c", private: false } });
    const floors = new Map([[bytesToHex(ch), headFloor(v3)]]);
    expect(foldControlState([...base, v2, v4], c.id, c.owner, floors).channels.get(bytesToHex(ch))?.deleted).toBe(true);
  });

  it("lets a rival of a withheld settled edition stand in only by winning the tiebreak", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = random32();
    const v1 = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "a", private: false } });
    const rivals = Array.from({ length: 12 }, (_, n) => c.edition({ vsk: "2", eid: ch, author: c.owner, prev: v1, content: { name: `r${n}`, private: false } }));
    const [settled, ...rest] = rivals;
    const floors = new Map([[bytesToHex(ch), headFloor(settled)]]);
    const id = (e: typeof settled) => bytesToHex(e.rumorId);
    const winner = rest.find((r) => id(r) < id(settled));
    const loser = rest.find((r) => id(r) > id(settled));
    if (winner) expect(foldControlState([...base, v1, winner], c.id, c.owner, floors).channels.get(bytesToHex(ch))?.name).toBe(JSON.parse(winner.content).name);
    if (loser) expect(foldControlState([...base, v1, loser], c.id, c.owner, floors).channels.get(bytesToHex(ch))?.name).not.toBe(JSON.parse(loser.content).name);
    expect(winner ?? loser).toBeDefined();
  });
});
