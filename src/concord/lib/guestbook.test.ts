import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { guestbookGroupKey, random32, bytesToHex } from "@/concord/lib/derive";
import {
  buildJoinRumor,
  buildKickRumor,
  buildLeaveRumor,
  buildSnapshotRumors,
  coalesceGuestbook,
  completeMemberlist,
  joinToRestore,
  liveRefound,
  openGuestbookWraps,
  sealGuestbook,
  banDeparturesOwed,
  nextGuestbookMs,
  nicknameToCarry,
  displayNickname,
  foldNicknames,
} from "@/concord/lib/guestbook";
import { KIND_NICKNAME, KIND_SEAL_ENCRYPTED } from "@/concord/lib/kinds";
import type { OpenedEvent } from "@/concord/lib/stream";

function signer(sk = generateSecretKey()) {
  return { sk, pubkey: getPublicKey(sk), signEvent: async (t: EventTemplate) => finalizeEvent(t, sk) };
}

const root = new Uint8Array(32).fill(6);
const cid = new Uint8Array(32).fill(7);
const gb = guestbookGroupKey(root, cid, 0);

const allowAllKicks = () => true;
const denyAllKicks = () => false;

describe("guestbook coalesce (CORD-02 §5)", () => {
  it("one final state per npub — the latest entry wins", async () => {
    const alice = signer();
    const wraps: NostrEvent[] = [
      await sealGuestbook(buildJoinRumor(alice.pubkey, 1000), gb, alice),
      await sealGuestbook(buildLeaveRumor(alice.pubkey, 2000), gb, alice),
      await sealGuestbook(buildJoinRumor(alice.pubkey, 3000), gb, alice),
    ];
    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), { nowMs: 10_000, canKick: denyAllKicks });
    expect(coalesced.get(alice.pubkey)?.state).toBe("join");
    expect(coalesced.get(alice.pubkey)?.ms).toBe(3000);
  });

  it("drops every entry from a banned npub — join and kick alike (CORD-04 §4)", async () => {
    const banned = signer();
    const victim = signer();
    const wraps: NostrEvent[] = [
      // The banned member's own Join is not honored.
      await sealGuestbook(buildJoinRumor(banned.pubkey, 1000), gb, banned),
      // Nor is a Kick they sign, even if the gate would otherwise allow it.
      await sealGuestbook(buildKickRumor(banned.pubkey, victim.pubkey, 2000), gb, banned),
      // A live member's Join is unaffected.
      await sealGuestbook(buildJoinRumor(victim.pubkey, 1500), gb, victim),
    ];
    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), {
      nowMs: 10_000,
      canKick: allowAllKicks,
      banned: new Set([banned.pubkey]),
    });
    expect(coalesced.has(banned.pubkey)).toBe(false);
    expect(coalesced.get(victim.pubkey)?.state).toBe("join"); // the banned member's kick never landed
  });

  it("drops entries dated more than one hour ahead of the local clock", async () => {
    const alice = signer();
    const now = 1_000_000_000_000;
    const wraps = [
      await sealGuestbook(buildJoinRumor(alice.pubkey, now), gb, alice),
      await sealGuestbook(buildLeaveRumor(alice.pubkey, now + 2 * 60 * 60 * 1000), gb, alice), // 2h future
    ];
    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), { nowMs: now, canKick: denyAllKicks });
    expect(coalesced.get(alice.pubkey)?.state).toBe("join"); // the forged-future leave was dropped
  });

  it("a kick is honored only from an authorized actor", async () => {
    const alice = signer();
    const admin = signer();
    const rando = signer();
    const wraps = [
      await sealGuestbook(buildJoinRumor(alice.pubkey, 1000), gb, alice),
      await sealGuestbook(buildKickRumor(rando.pubkey, alice.pubkey, 2000), gb, rando),
    ];
    const opened = openGuestbookWraps(wraps, [gb]);
    const unauthorized = coalesceGuestbook(opened, { nowMs: 10_000, canKick: (actor) => actor === admin.pubkey });
    expect(unauthorized.get(alice.pubkey)?.state).toBe("join");

    const kicked = [...wraps, await sealGuestbook(buildKickRumor(admin.pubkey, alice.pubkey, 3000), gb, admin)];
    const authorized = coalesceGuestbook(openGuestbookWraps(kicked, [gb]), {
      nowMs: 10_000,
      canKick: (actor) => actor === admin.pubkey,
    });
    expect(authorized.get(alice.pubkey)?.state).toBe("kick");
  });

  it("a snapshot seeds members but any newer self-signed entry supersedes it", async () => {
    const refounder = signer();
    const alice = signer();
    const bob = signer();
    const snapId = bytesToHex(random32());
    const rumors = buildSnapshotRumors(refounder.pubkey, [alice.pubkey, bob.pubkey], snapId, 5000);
    const wraps: NostrEvent[] = [];
    for (const r of rumors) wraps.push(await sealGuestbook(r, gb, refounder));
    wraps.push(await sealGuestbook(buildLeaveRumor(bob.pubkey, 6000), gb, bob));

    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), {
      nowMs: 10_000,
      canKick: denyAllKicks,
      snapshotAuthorities: new Set([refounder.pubkey]),
    });
    expect(coalesced.get(alice.pubkey)?.state).toBe("join");
    expect(coalesced.get(alice.pubkey)?.fromSnapshot).toBe(true);
    expect(coalesced.get(bob.pubkey)?.state).toBe("leave");
  });

  it("a snapshot from anyone but the epoch's refounder is ignored", async () => {
    const refounder = signer();
    const impostor = signer();
    const alice = signer();
    const rumors = buildSnapshotRumors(impostor.pubkey, [alice.pubkey], bytesToHex(random32()), 5000);
    const wraps: NostrEvent[] = [];
    for (const r of rumors) wraps.push(await sealGuestbook(r, gb, impostor));
    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), {
      nowMs: 10_000,
      canKick: allowAllKicks,
      snapshotAuthorities: new Set([refounder.pubkey]),
    });
    expect(coalesced.size).toBe(0);
  });

  it("honors a PRIOR epoch's refounder — the sweep spans every held guestbook", async () => {
    // guestbookGroups() reads every held epoch's guestbook, and each was minted
    // by its own refounder (CORD-02 §5). Passing only the current epoch's
    // dropped every earlier snapshot; the authority is the recorded set.
    const past = signer();
    const current = signer();
    const alice = signer();
    const rumors = buildSnapshotRumors(past.pubkey, [alice.pubkey], bytesToHex(random32()), 5000);
    const wraps: NostrEvent[] = [];
    for (const r of rumors) wraps.push(await sealGuestbook(r, gb, past));

    const opened = openGuestbookWraps(wraps, [gb]);
    expect(
      coalesceGuestbook(opened, {
        nowMs: 10_000,
        canKick: denyAllKicks,
        snapshotAuthorities: new Set([current.pubkey]),
      }).size,
    ).toBe(0);
    expect(
      coalesceGuestbook(opened, {
        nowMs: 10_000,
        canKick: denyAllKicks,
        snapshotAuthorities: new Set([current.pubkey, past.pubkey]),
      }).get(alice.pubkey)?.state,
    ).toBe("join");
  });

  it("no snapshot authority (unknown refounder) means NO snapshot is honored — never a blanket owner fallback", async () => {
    // The hook (useGuestbook) must pass the recorded minting refounders, or
    // nothing when none is known — NEVER the owner as a fallback for a
    // post-genesis epoch. With no authority, even an owner-signed snapshot
    // can't seed a ghost member (CORD-02 §5).
    const owner = signer();
    const ghost = signer();
    const rumors = buildSnapshotRumors(owner.pubkey, [ghost.pubkey], bytesToHex(random32()), 5000);
    const wraps: NostrEvent[] = [];
    for (const r of rumors) wraps.push(await sealGuestbook(r, gb, owner));
    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), {
      nowMs: 10_000,
      canKick: denyAllKicks,
      snapshotAuthorities: undefined,
    });
    expect(coalesced.has(ghost.pubkey)).toBe(false);
  });

  it("chunks snapshots at 400 members with one shared id", () => {
    const refounder = signer();
    const members = Array.from({ length: 950 }, () => bytesToHex(random32()));
    const rumors = buildSnapshotRumors(refounder.pubkey, members, bytesToHex(random32()), 5000);
    expect(rumors.length).toBe(3);
    const tags = rumors.map((r) => r.tags.find((t) => t[0] === "snap")!);
    expect(new Set(tags.map((t) => t[1])).size).toBe(1); // one snapshot id
    expect(tags.map((t) => t[2])).toEqual(["1", "2", "3"]);
    expect(tags.every((t) => t[3] === "3")).toBe(true);
  });
});

describe("complete memberlist", () => {
  it("guestbook ∪ observed − banned, with observation counting only forward", async () => {
    const alice = signer();
    const bob = signer();
    const carol = signer();
    const wraps = [
      await sealGuestbook(buildJoinRumor(alice.pubkey, 1000), gb, alice),
      await sealGuestbook(buildLeaveRumor(bob.pubkey, 5000), gb, bob),
    ];
    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), { nowMs: 10_000, canKick: denyAllKicks });

    // Bob's OLD activity (before his leave) can't resurrect him; carol was
    // never in the guestbook but is observably present.
    const observed = new Map<string, number>([
      [bob.pubkey, 4000],
      [carol.pubkey, 8000],
      [alice.pubkey, 2000],
    ]);
    const members = completeMemberlist(coalesced, observed, new Set([carol.pubkey]));
    expect(members.has(alice.pubkey)).toBe(true);
    expect(members.has(bob.pubkey)).toBe(false);
    expect(members.has(carol.pubkey)).toBe(false); // banned

    // Bob speaks AFTER his leave → observably present again.
    const rejoined = completeMemberlist(coalesced, new Map([[bob.pubkey, 6000]]), new Set());
    expect(rejoined.has(bob.pubkey)).toBe(true);
  });

  it("a standing Join counts once the ban is lifted: the lift's Kick is the departure (CORD-04 §6, Vector)", async () => {
    const alice = signer();
    // Alice joined at 1000ms; the control plane recorded a ban at 2s (= 2000ms), since lifted.
    const wraps = [await sealGuestbook(buildJoinRumor(alice.pubkey, 1000), gb, alice)];
    const coalesced = coalesceGuestbook(openGuestbookWraps(wraps, [gb]), { nowMs: 10_000, canKick: denyAllKicks });
    const bannedAt = new Map([[alice.pubkey, 2]]); // SECONDS
    expect(completeMemberlist(coalesced, new Map(), new Set(), bannedAt).has(alice.pubkey)).toBe(true);
    // Still banned: not counted.
    expect(completeMemberlist(coalesced, new Map(), new Set([alice.pubkey]), bannedAt).has(alice.pubkey)).toBe(false);
  });

  it("observed activity before a ban doesn't re-add; activity after the ban does", async () => {
    const alice = signer();
    const bannedAt = new Map([[alice.pubkey, 5]]); // 5s = 5000ms
    const empty = coalesceGuestbook([], { nowMs: 10_000, canKick: denyAllKicks });

    // Old activity (before the ban) can't resurrect a departed-by-ban member.
    expect(completeMemberlist(empty, new Map([[alice.pubkey, 4000]]), new Set(), bannedAt).has(alice.pubkey)).toBe(false);
    // Activity after the ban → observably present again.
    expect(completeMemberlist(empty, new Map([[alice.pubkey, 6000]]), new Set(), bannedAt).has(alice.pubkey)).toBe(true);
  });
});

describe("a Refounding's snapshot is the whole guest list (CORD-02 §5, Vector `supersede_by_refounding`)", () => {
  const gb1 = guestbookGroupKey(new Uint8Array(32).fill(8), cid, 1);
  const live = { pk: gb1.pk, refounder: "" };

  async function planes(omitted: ReturnType<typeof signer>, kept: ReturnType<typeof signer>, refounder: ReturnType<typeof signer>, chunks?: number) {
    const wraps: NostrEvent[] = [
      await sealGuestbook(buildJoinRumor(omitted.pubkey, 1000), gb, omitted),
      await sealGuestbook(buildJoinRumor(kept.pubkey, 1000), gb, kept),
    ];
    const rumors = buildSnapshotRumors(refounder.pubkey, [kept.pubkey], bytesToHex(random32()), 5000);
    for (const r of rumors.slice(0, chunks ?? rumors.length)) wraps.push(await sealGuestbook(r, gb1, refounder));
    return openGuestbookWraps(wraps, [gb1, gb]);
  }
  const opts = (refounder: string) => ({
    nowMs: 10_000,
    canKick: denyAllKicks,
    snapshotAuthorityOf: new Map([[gb1.pk, refounder]]),
    live: { ...live, refounder },
  });

  it("an earlier epoch's Joined member the complete snapshot omits holds no state", async () => {
    const [omitted, kept, refounder] = [signer(), signer(), signer()];
    const opened = await planes(omitted, kept, refounder);
    const coalesced = coalesceGuestbook(opened, opts(refounder.pubkey));
    expect(coalesced.get(omitted.pubkey)?.state).toBe("refounded");
    expect(coalesced.get(kept.pubkey)?.state).toBe("join");
    const refound = liveRefound(opened, opts(refounder.pubkey));
    expect(refound?.cut).toBe(5000);
    // Activity no newer than the cut doesn't re-admit them; posting after it does.
    expect(completeMemberlist(coalesced, new Map([[omitted.pubkey, 4000]]), new Set(), undefined, refound).has(omitted.pubkey)).toBe(false);
    expect(completeMemberlist(coalesced, new Map([[omitted.pubkey, 6000]]), new Set(), undefined, refound).has(omitted.pubkey)).toBe(true);
  });

  it("a Join on the live epoch after the cut stands", async () => {
    const [omitted, kept, refounder] = [signer(), signer(), signer()];
    const opened = [...(await planes(omitted, kept, refounder)), ...openGuestbookWraps([await sealGuestbook(buildJoinRumor(omitted.pubkey, 7000), gb1, omitted)], [gb1])];
    expect(coalesceGuestbook(opened, opts(refounder.pubkey)).get(omitted.pubkey)?.state).toBe("join");
  });

  it("takes nothing from a snapshot missing a chunk", async () => {
    const [omitted, refounder] = [signer(), signer()];
    const many = Array.from({ length: 401 }, () => signer().pubkey);
    const wraps = [await sealGuestbook(buildJoinRumor(omitted.pubkey, 1000), gb, omitted)];
    wraps.push(await sealGuestbook(buildSnapshotRumors(refounder.pubkey, many, bytesToHex(random32()), 5000)[0], gb1, refounder));
    const opened = openGuestbookWraps(wraps, [gb1, gb]);
    expect(liveRefound(opened, opts(refounder.pubkey))).toBeUndefined();
    expect(coalesceGuestbook(opened, opts(refounder.pubkey)).get(omitted.pubkey)?.state).toBe("join");
  });

  it("honors a snapshot only from its own epoch's minter", async () => {
    const [alice, minter, other] = [signer(), signer(), signer()];
    const wraps: NostrEvent[] = [];
    for (const r of buildSnapshotRumors(other.pubkey, [alice.pubkey], bytesToHex(random32()), 5000)) wraps.push(await sealGuestbook(r, gb1, other));
    const opened = openGuestbookWraps(wraps, [gb1]);
    // `other` minted some other held epoch, so the union would take it.
    const o = { ...opts(minter.pubkey), snapshotAuthorities: new Set([minter.pubkey, other.pubkey]) };
    expect(coalesceGuestbook(opened, o).has(alice.pubkey)).toBe(false);
  });
});

describe("restoring a lost Join (CORD-02 §5, Vector `heal_my_join`)", () => {
  const gb1 = guestbookGroupKey(new Uint8Array(32).fill(9), cid, 1);
  const base = (refounder?: string) => ({
    nowMs: 10_000,
    canKick: denyAllKicks,
    snapshotAuthorityOf: new Map(refounder ? [[gb1.pk, refounder]] : []),
    live: { pk: gb1.pk, ...(refounder ? { refounder } : {}) },
  });

  it("dates the Join at the live epoch's oldest entry when no state of ours stands", async () => {
    const [me, other, owner] = [signer(), signer(), signer()];
    const opened = openGuestbookWraps([
      await sealGuestbook(buildJoinRumor(other.pubkey, 4000), gb1, other),
      await sealGuestbook(buildJoinRumor(other.pubkey, 2500), gb1, other),
    ], [gb1]);
    expect(joinToRestore(opened, base(), me.pubkey, owner.pubkey)).toBe(2500);
  });

  it("dates it at the Refounding's cut, and restores one the complete snapshot omitted", async () => {
    const [me, refounder, owner] = [signer(), signer(), signer()];
    const wraps: NostrEvent[] = [await sealGuestbook(buildJoinRumor(me.pubkey, 1000), gb, me)];
    for (const r of buildSnapshotRumors(refounder.pubkey, [signer().pubkey], bytesToHex(random32()), 5000)) wraps.push(await sealGuestbook(r, gb1, refounder));
    expect(joinToRestore(openGuestbookWraps(wraps, [gb1, gb]), base(refounder.pubkey), me.pubkey, owner.pubkey)).toBe(5000);
  });

  it("writes nothing while a state of ours stands, a Leave or a snapshot seed included, nor for the owner", async () => {
    const [me, refounder, owner] = [signer(), signer(), signer()];
    const left = openGuestbookWraps([await sealGuestbook(buildLeaveRumor(me.pubkey, 3000), gb1, me)], [gb1]);
    expect(joinToRestore(left, base(), me.pubkey, owner.pubkey)).toBeUndefined();
    const wraps: NostrEvent[] = [];
    for (const r of buildSnapshotRumors(refounder.pubkey, [me.pubkey], bytesToHex(random32()), 5000)) wraps.push(await sealGuestbook(r, gb1, refounder));
    expect(joinToRestore(openGuestbookWraps(wraps, [gb1]), base(refounder.pubkey), me.pubkey, owner.pubkey)).toBeUndefined();
    expect(joinToRestore(left, base(), owner.pubkey, owner.pubkey)).toBeUndefined();
  });
});

describe("the departures a lifted Ban still owes (CORD-04 §6, Vector `heal_ban_departures`)", () => {
  const pk = "ab".repeat(32);
  const atSecs = 1_700_000_000;
  const standing = new Map([[pk, { pubkey: pk, state: "join" as const, ms: atSecs * 1000 - 60_000, rumorId: "r", fromSnapshot: false }]]);

  it("owes none to a member this device holds a post from since the Ban, loaded or not", async () => {
    const owed = await banDeparturesOwed({ bannedAt: new Map([[pk, atSecs]]), banned: new Set() }, standing, new Map(), async () => true);
    expect(owed).toEqual([]);
  });

  it("owes one to a member silent since the Ban, still standing on the pre-ban Join", async () => {
    const owed = await banDeparturesOwed({ bannedAt: new Map([[pk, atSecs]]), banned: new Set() }, standing, new Map(), async () => false);
    expect(owed).toEqual([{ pk, ms: atSecs * 1000 }]);
  });

  it("owes none for a Ban dated past the horizon, which would hold the member out until then", async () => {
    const nowMs = atSecs * 1000;
    const future = atSecs + 10 * 365 * 86_400;
    const owed = await banDeparturesOwed({ bannedAt: new Map([[pk, future]]), banned: new Set() }, standing, new Map(), async () => false, nowMs);
    expect(owed).toEqual([]);
  });
});

describe("carrying this member's own Nickname into a new epoch (CORD-04 §10, Vector `carry_my_nickname`)", () => {
  const me = "ab".repeat(32);
  const [oldPk, livePk] = ["01".repeat(32), "02".repeat(32)];
  const nick = (author: string, content: string, ms: number, streamPk: string): OpenedEvent => ({
    rumorId: `${ms}`.padStart(64, "0"),
    author,
    kind: KIND_NICKNAME,
    content,
    tags: [["p", me]],
    ms,
    createdAt: Math.floor(ms / 1000),
    streamPk,
    sealKind: KIND_SEAL_ENCRYPTED,
  });
  const opts = { me, livePk, nowMs: 10_000_000, mayName: () => true };

  it("re-issues the name it went by when the live epoch lacks it, dated as first set", () => {
    expect(nicknameToCarry([nick(me, "Captain", 5_000, oldPk)], opts)).toEqual({ nick: "Captain", ms: 5_000 });
  });

  it("re-issues nothing when the live epoch already holds it, or a newer one", () => {
    expect(nicknameToCarry([nick(me, "Captain", 5_000, oldPk), nick(me, "Captain", 5_000, livePk)], opts)).toBeUndefined();
    expect(nicknameToCarry([nick(me, "Captain", 5_000, oldPk), nick(me, "Skipper", 6_000, livePk)], opts)).toBeUndefined();
  });

  it("re-issues nothing for a member who may not name themselves", () => {
    expect(nicknameToCarry([nick(me, "Captain", 5_000, oldPk)], { ...opts, mayName: () => false })).toBeUndefined();
  });
});

describe("a Nickname as shown", () => {
  const me = "ab".repeat(32);
  const nick = (content: string, ms = 5_000): OpenedEvent => ({
    rumorId: `${ms}`.padStart(64, "0"),
    author: me,
    kind: KIND_NICKNAME,
    content,
    tags: [["p", me]],
    ms,
    createdAt: Math.floor(ms / 1000),
    sealKind: KIND_SEAL_ENCRYPTED,
  });
  const fold = (content: string) => foldNicknames([nick(content)], { nowMs: 10_000_000, mayName: () => true }).get(me);

  it("drops direction controls and invisible spacers that let it pass for another name", () => {
    expect(fold("\u202Erenwo")).toBe("renwo");
    expect(fold("Ali\u200Bce")).toBe("Alice");
    expect(fold("\u2066Mod\u2069 \uFEFF")).toBe("Mod");
  });

  it("keeps the joiners emoji and scripts need, and shows none when nothing is left", () => {
    expect(fold("\u{1F468}\u200D\u{1F469}")).toBe("\u{1F468}\u200D\u{1F469}");
    expect(displayNickname("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645")).toBe("\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645");
    expect(fold("\u202E\u200B")).toBeUndefined();
  });

  it("carries the Nickname as signed, not as shown", () => {
    const carried = nicknameToCarry([{ ...nick("\u202Erenwo"), streamPk: "01".repeat(32) }], { me, livePk: "02".repeat(32), nowMs: 10_000_000, mayName: () => true });
    expect(carried?.nick).toBe("\u202Erenwo");
  });
});

describe("a Join's invite attribution (CORD-05 §1, Vector `invited_by`)", () => {
  it("takes the first invite tag carrying creator and label, skipping a shorter one", () => {
    const member = "ab".repeat(32);
    const join = (tags: string[][]): OpenedEvent => ({ rumorId: "01".repeat(32), author: member, kind: 3306, content: "join", tags, ms: 1_000, createdAt: 1 });
    const read = (tags: string[][]) => coalesceGuestbook([join(tags)], { nowMs: 10_000, canKick: () => true }).get(member)?.invite;
    expect(read([["invite", "cd".repeat(32)]])).toBeUndefined();
    expect(read([["invite", "cd".repeat(32)], ["invite", "ef".repeat(32), "friends"]])).toEqual({ creator: "ef".repeat(32), label: "friends" });
  });
});

describe("dating a Timeout or Nickname (Vector `timeout_member`, `set_nickname`)", () => {
  const target = "ab".repeat(32);
  const ev = (ms: number, author = "cd".repeat(32)): OpenedEvent => ({ rumorId: `${ms}`.padStart(64, "0"), author, kind: KIND_NICKNAME, content: "x", tags: [["p", target]], ms, createdAt: 1 });
  it("dates it now, or just after a newer one that counts, never past the horizon", () => {
    expect(nextGuestbookMs([ev(500)], KIND_NICKNAME, target, () => true, 1_000)).toBe(1_000);
    expect(nextGuestbookMs([ev(5_000)], KIND_NICKNAME, target, () => true, 1_000)).toBe(5_001);
    expect(nextGuestbookMs([ev(5_000)], KIND_NICKNAME, target, () => false, 1_000)).toBe(1_000);
    expect(nextGuestbookMs([ev(1_000 + 2 * 3600_000)], KIND_NICKNAME, target, () => true, 1_000)).toBe(1_000 + 3600_000);
  });
});
