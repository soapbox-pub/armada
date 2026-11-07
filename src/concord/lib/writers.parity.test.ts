/**
 * Behavioral parity with Vector v0.5.0-3 (`writers.rs`, `service/writing.rs`) and
 * CORD-03 §1 at concord#25 for restricted Channels: which posts and edits a
 * Writers ledger stands behind, and which ledger editions fold. `it.fails` marks
 * what Armada still gets wrong.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { restrictedPostersIn, writerJudge } from "@/concord/lib/channelJudges";
import { foldTimeline, type OpenedChat } from "@/concord/lib/chat";
import { channelsView } from "@/concord/lib/community";
import { foldControlState } from "@/concord/lib/control";
import { bytesToHex, channelGroupKey, random32, writersLocator } from "@/concord/lib/derive";
import type { ParsedEdition } from "@/concord/lib/edition";
import type { CoalescedMember } from "@/concord/lib/guestbook";
import { KIND_EDIT } from "@/concord/lib/kinds";
import { Permissions } from "@/concord/lib/roles";
import { ledgerExtends, parseLedger } from "@/concord/lib/writers";
import { parseDelivery } from "@/concord/lib/delivery";
import { resetClockOffset, syncClockWithRelays } from "@/lib/relayClock";
import { eidHex, headFloor, hexKey, heldCommunity, rankedCommunity, type TestCommunity } from "@/test/concordEditions";

const point = () => bytesToHex(schnorr.getPublicKey(random32()));
const T0 = 1_700_000_000_000;
const MIN = 60_000;

function ledgerEdition(c: TestCommunity, channel: string, ledger: object[], opts: { prev?: ParsedEdition; author?: string; createdAt?: number; version?: bigint; cite?: ParsedEdition } = {}) {
  return c.edition({
    vsk: "18",
    eid: writersLocator(c.id, hexToBytes(channel)),
    author: opts.author ?? c.owner,
    prev: opts.prev,
    version: opts.version,
    cite: opts.cite,
    createdAt: opts.createdAt ?? Math.floor(T0 / 1000),
    content: { channel, ledger },
  });
}

function post(author: string, channel: string, ms: number, extra: Partial<OpenedChat> = {}): OpenedChat {
  return { rumorId: hexKey(), author, kind: 9, content: "hi", tags: [], ms, createdAt: Math.floor(ms / 1000), channelIdHex: channel, epoch: 0n, ...extra };
}

const member = (pubkey: string, state: CoalescedMember["state"], ms: number): [string, CoalescedMember[]] => [pubkey, [{ pubkey, state, ms, rumorId: hexKey(), fromSnapshot: false }]];

/** A restricted public Channel: writer epoch 1 from T0, its writer address `wpk`. */
function restricted(more: object[] = []) {
  const k = rankedCommunity(Permissions.MANAGE_CHANNELS | Permissions.MANAGE_ROLES);
  const { c, base } = k;
  const ch = hexKey();
  const wpk = point();
  const channel = c.edition({ vsk: "2", eid: ch, author: c.owner, content: { name: "announcements", private: false } });
  // One edition per entry, each appending to its predecessor's.
  const entries: object[] = [{ at: T0, epoch: 1, writer: wpk, root: 0, by: c.owner }, ...more];
  const ledgers: ParsedEdition[] = [];
  entries.forEach((_, i) => ledgers.push(ledgerEdition(c, ch, entries.slice(0, i + 1), { prev: ledgers[i - 1] })));
  const folded = foldControlState([...base, channel, ...ledgers], c.id, c.owner);
  return { ...k, ch, wpk, folded };
}


describe("who rings at a restricted Channel's read address (CORD-03 §1 Held posts)", () => {
  it("names the owner and the managers, as the judge vouches for them, and nobody while the read address takes everyone's", () => {
    const { c, ch, admin, folded } = restricted();
    expect(restrictedPostersIn(folded, ch)).toEqual([c.owner, admin].sort());
    const judge = writerJudge(folded, ch, c.id, undefined)!;
    // Past the move's skew, where only a vouched post stands at the read address.
    expect(judge.stands(post(hexKey(), ch, T0 + 20 * MIN))).toBe(false);
    expect(judge.stands(post(admin, ch, T0 + 20 * MIN))).toBe(true);
    expect(restrictedPostersIn(folded, hexKey())).toBeUndefined();
  });
});

describe("which posts a restricted Channel stands behind", () => {
  it("baseline: a writer's post at the writer address, inside its window, stands", () => {
    const { c, ch, folded } = restricted();
    const writer = hexKey();
    const judge = writerJudge(folded, ch, c.id, undefined)!;
    expect(judge.stands(post(writer, ch, T0 + MIN, { tags: [["wepoch", "1"]] }))).toBe(true);
  });

  it("refuses a post its writer sent after leaving the Community (CORD-03 §1 Departures; Vector `departed`)", () => {
    const { c, ch, folded } = restricted();
    const writer = hexKey();
    const guestbook = new Map([member(writer, "leave", T0 + MIN)]);
    const judge = writerJudge(folded, ch, c.id, undefined, guestbook)!;
    expect(judge.stands(post(writer, ch, T0 + 2 * MIN, { tags: [["wepoch", "1"]] }))).toBe(false);
  });

  it("refuses a post its writer sent after a Kick, whatever Join follows (CORD-03 §1 Stops)", () => {
    const { c, ch, folded } = restricted();
    const writer = hexKey();
    const kicked = new Map([member(writer, "kick", T0 + MIN)]);
    const judge = writerJudge(folded, ch, c.id, undefined, kicked)!;
    expect(judge.stands(post(writer, ch, T0 + 2 * MIN, { tags: [["wepoch", "1"]] }))).toBe(false);
  });

  it("refuses a post by a writer whose Kick began before the window and whose span away reaches into it (Vector `kicked_in`)", () => {
    const { c, ch, folded } = restricted();
    const writer = hexKey();
    const entry = (state: CoalescedMember["state"], ms: number) => ({ pubkey: writer, state, ms, rumorId: hexKey(), fromSnapshot: false });
    const history = new Map([[writer, [entry("join", T0 - 10 * MIN), entry("kick", T0 - 5 * MIN), entry("join", T0 + MIN)]]]);
    const judge = writerJudge(folded, ch, c.id, undefined, history)!;
    expect(judge.stands(post(writer, ch, T0 + 2 * MIN, { tags: [["wepoch", "1"]] }))).toBe(false);
    // A span that closed before the window opened reaches nothing.
    const before = new Map([[writer, [entry("join", T0 - 10 * MIN), entry("kick", T0 - 5 * MIN), entry("join", T0 - MIN)]]]);
    expect(writerJudge(folded, ch, c.id, undefined, before)!.stands(post(writer, ch, T0 + 2 * MIN, { tags: [["wepoch", "1"]] }))).toBe(true);
  });

  it("stands a writer-address post while the Channel is open again (CORD-03 §1: 'anyone may post then')", () => {
    const { c, ch, folded } = restricted([{ at: T0 + MIN, open: true }]);
    const judge = writerJudge(folded, ch, c.id, undefined)!;
    expect(judge.stands(post(hexKey(), ch, T0 + 2 * MIN, { tags: [["wepoch", "1"]] }))).toBe(true);
  });

  it("stands a member's read-address post dated less than ten minutes past the restrict (Vector `crossed_a_move`)", () => {
    const { c, ch, folded } = restricted();
    const author = hexKey();
    const judge = writerJudge(folded, ch, c.id, undefined, new Map([member(author, "join", T0 - MIN)]))!;
    expect(judge.stands(post(author, ch, T0 + 5 * MIN))).toBe(true);
  });

  it("doesn't stand a manager's post once they've left the Community (CORD-03 §1: 'no writer or manager, whatever a Role still says')", () => {
    const { c, admin, ch, folded } = restricted();
    const judge = writerJudge(folded, ch, c.id, undefined, new Map([member(admin, "leave", T0 + MIN)]))!;
    expect(judge.stands(post(admin, ch, T0 + 2 * MIN))).toBe(false);
  });

  it("undoes an edit a stopped writer makes at the writer address (CORD-03 §1 Take-backs)", () => {
    const writer = point();
    const { c, ch, folded } = restricted([{ at: T0 + 2 * MIN, stop: writer }]);
    const judge = writerJudge(folded, ch, c.id, undefined)!;
    const original = post(writer, ch, T0 + MIN, { tags: [["wepoch", "1"]] });
    const edit = post(writer, ch, T0 + 3 * MIN, { kind: KIND_EDIT, content: "rewritten", tags: [["e", original.rumorId], ["wepoch", "1"]] });
    const timeline = foldTimeline([original, edit], undefined, { hold: (m) => !judge.stands(m) });
    expect(timeline.messages.find((m) => m.rumorId === original.rumorId)?.content).toBe("hi");
  });

  it("stands a member's reaction at the read address, which never rides a writer address (CORD-03 §1; Vector `stands_by_ledger`, `rides_writer_address`)", () => {
    const { c, ch, folded } = restricted();
    const author = hexKey();
    const judge = writerJudge(folded, ch, c.id, undefined, new Map([member(author, "join", T0 - MIN)]))!;
    expect(judge.stands(post(author, ch, T0 + 30 * MIN, { kind: 7, content: "+", tags: [["e", hexKey()]] }))).toBe(true);
  });

  it("stands a member's delete of their own post at the read address (CORD-03 §1; Vector `rides_writer_address`)", () => {
    const { c, ch, folded } = restricted();
    const author = hexKey();
    const judge = writerJudge(folded, ch, c.id, undefined, new Map([member(author, "join", T0 - MIN)]))!;
    expect(judge.stands(post(author, ch, T0 + 30 * MIN, { kind: 5, content: "", tags: [["e", hexKey()]] }))).toBe(true);
  });

  it("reads a writer address under every read key it holds, not just the current one (Vector tries every held read coordinate)", () => {
    const { c, ch, wpk, folded } = restricted();
    const old = random32();
    const community = heldCommunity(c);
    // A Refounding since: epoch 1 is current, epoch 0's root still held.
    community.heldRoots = [{ epoch: 1n, key: community.root }, { epoch: 0n, key: old }];
    community.rootEpoch = 1n;
    const shown = channelsView(community, folded).find((v) => v.idHex === ch)!;
    const oldKey = bytesToHex(channelGroupKey(old, hexToBytes(ch), 0n).convKey);
    const writerKeys = shown.streams.filter((s) => s.group.pk === wpk).map((s) => bytesToHex(s.group.convKey));
    expect(writerKeys).toContain(oldKey);
  });
});

describe("which Writers ledger editions fold (CORD-03 §1 Judging the ledger)", () => {
  const writerEntry = (at: number, epoch: number, by: string) => ({ at, epoch, writer: point(), root: 0, by });

  it("refuses an edition whose new entry is dated more than ten minutes from its created_at", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = hexKey();
    const v1 = ledgerEdition(c, ch, [writerEntry(T0 + 20 * MIN, 1, c.owner)]);
    expect(foldControlState([...base, v1], c.id, c.owner).writers?.has(ch)).toBe(false);
  });

  it("refuses a writer entry whose `by` isn't the edition's signer", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = hexKey();
    const v1 = ledgerEdition(c, ch, [writerEntry(T0, 1, hexKey())]);
    expect(foldControlState([...base, v1], c.id, c.owner).writers?.has(ch)).toBe(false);
  });

  it("refuses an entry dated more than an hour past the reader's clock", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = hexKey();
    const at = Date.now() + 2 * 60 * MIN;
    const v1 = ledgerEdition(c, ch, [writerEntry(at, 1, c.owner)], { createdAt: Math.floor(at / 1000) });
    expect(foldControlState([...base, v1], c.id, c.owner).writers?.has(ch)).toBe(false);
  });

  it("refuses a chainless edition that isn't version 1 ('the first holds one, at version 1')", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = hexKey();
    const v5 = ledgerEdition(c, ch, [writerEntry(T0, 1, c.owner)], { version: 5n });
    expect(foldControlState([...base, v5], c.id, c.owner).writers?.has(ch)).toBe(false);
  });

  it("refuses an edition built on a served but malformed predecessor ('stands only on a predecessor that stands')", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = hexKey();
    const bad = c.edition({ vsk: "18", eid: writersLocator(c.id, hexToBytes(ch)), author: c.owner, createdAt: Math.floor(T0 / 1000), content: { channel: ch, ledger: "nope" } });
    const v2 = ledgerEdition(c, ch, [writerEntry(T0, 1, c.owner), { at: T0 + 1, open: true }], { prev: bad });
    expect(foldControlState([...base, bad, v2], c.id, c.owner).writers?.has(ch)).toBe(false);
  });

  it("refuses an edition built on the withheld held head that doesn't extend it, keeping the head it had (Vector `ledger_chain_ok` anchor; CORD-03 §1 'chains grow from the head the reader already holds')", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = hexKey();
    const w1 = writerEntry(T0, 1, c.owner);
    const v1 = ledgerEdition(c, ch, [w1]);
    const held = ledgerEdition(c, ch, [w1, { at: T0 + 1, open: true }], { prev: v1 });
    // Built on the held head, but rewriting the entry it would extend.
    const w2 = writerEntry(T0 + 3, 2, c.owner);
    const rewritten = ledgerEdition(c, ch, [w1, { at: T0 + 2, open: true }, w2], { prev: held });
    // The reader folded `held` last time and stored it; no relay serves it now.
    const floors = new Map([[eidHex(held), headFloor(held)]]);
    const stored = { writers: { [eidHex(held)]: held.content } };
    const folded = foldControlState([...base, v1, rewritten], c.id, c.owner, floors, undefined, stored);
    expect(folded.writers?.get(ch)?.entries.some((e) => e.spell.kind === "writer" && e.spell.pk === w2.writer)).toBe(false);
    expect(folded.writers?.get(ch)?.entries).toHaveLength(2);
  });

  it("takes an edition built on the withheld held head that extends it (Vector `ledger_chain_ok` anchor)", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = hexKey();
    const w1 = writerEntry(T0, 1, c.owner);
    const v1 = ledgerEdition(c, ch, [w1]);
    const held = ledgerEdition(c, ch, [w1, { at: T0 + 1, open: true }], { prev: v1 });
    const w2 = writerEntry(T0 + 3, 2, c.owner);
    const next = ledgerEdition(c, ch, [w1, { at: T0 + 1, open: true }, w2], { prev: held });
    const floors = new Map([[eidHex(held), headFloor(held)]]);
    const folded = foldControlState([...base, v1, next], c.id, c.owner, floors, undefined, { writers: { [eidHex(held)]: held.content } });
    expect(folded.writers?.get(ch)?.entries).toHaveLength(3);
  });

  it("settles two roots as long on the root with the lower rumor id, not the heads' tiebreak (CORD-03 §1 Judging the ledger; Vector `ledger_chain_ok`)", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = hexKey();
    // Rumor ids rise in mint order: the root's is below the orphan's, the orphan's below its rival's.
    const [first, other] = [writerEntry(T0, 1, c.owner), writerEntry(T0, 9, c.owner)];
    const root = ledgerEdition(c, ch, [first]);
    const unserved = ledgerEdition(c, ch, [other]);
    const orphan = ledgerEdition(c, ch, [other, { at: T0 + 2, open: true }], { prev: unserved });
    // A first edition and its successor at v2, against an orphan v2 whose predecessor no relay serves.
    const next = ledgerEdition(c, ch, [first, { at: T0 + 1, open: true }], { prev: root });
    const folded = foldControlState([...base, root, next, orphan], c.id, c.owner);
    expect(folded.heads.get(eidHex(next))?.rumorId).toBe(bytesToHex(next.rumorId));
  });

  it("judges an entry's horizon by the relays' clock (CORD-03 §1, §3; Vector `now_ms`)", async () => {
    // The relays agree this device runs two hours behind.
    const ahead = async () => ({ date: new Date(Date.now() + 2 * 60 * MIN).toUTCString() });
    await syncClockWithRelays(["wss://a.test", "wss://b.test", "wss://c.test"], ahead);
    try {
      const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
      const ch = hexKey();
      const at = Date.now() + 90 * MIN;
      const v1 = ledgerEdition(c, ch, [writerEntry(at, 1, c.owner)], { createdAt: Math.floor(at / 1000) });
      expect(foldControlState([...base, v1], c.id, c.owner).writers?.has(ch)).toBe(true);
    } finally {
      resetClockOffset();
    }
  });

  it("compares an entry's unknown fields by value, not by key order (Vector compares maps)", () => {
    const ch = hexKey();
    const w = point();
    const prev = parseLedger(JSON.stringify({ channel: ch, ledger: [{ at: T0, epoch: 1, writer: w, root: 0, by: "ab".repeat(32), x: 1, y: 2 }] }))!;
    const next = parseLedger(JSON.stringify({ channel: ch, ledger: [{ at: T0, epoch: 1, writer: w, root: 0, by: "ab".repeat(32), y: 2, x: 1 }, { at: T0 + 1, open: true }] }))!;
    expect(ledgerExtends(next, prev)).toBe(true);
  });
});

describe("reading a ledger's numbers as serde's Value does (Vector `Ledger::parse`)", () => {
  const ch = "ab".repeat(32);
  const wpk = bytesToHex(schnorr.getPublicKey(random32()));
  const by = "cd".repeat(32);
  const ledger = (at: string, extra = "") => `{"channel":"${ch}","ledger":[{"at":${at},"epoch":1,"writer":"${wpk}","root":0,"by":"${by}"${extra}}]}`;

  it("refuses a time written as a float, and takes one past 2^53", () => {
    expect(parseLedger(ledger("1700000000000"))).toBeDefined();
    expect(parseLedger(ledger("1700000000000.0"))).toBeUndefined();
    expect(parseLedger(ledger("1.7e12"))).toBeUndefined();
    expect(parseLedger(ledger("1152921504606846976"))?.entries[0].at).toBe(2 ** 60);
  });

  it("refuses a lone surrogate anywhere, as serde does", () => {
    expect(parseLedger(ledger("1700000000000", `,"note":"\\ud800"`))).toBeUndefined();
  });
});

describe("reading a delivery as Vector's parse_access_delivery does", () => {
  const scope = "ab".repeat(32);
  const opened = (tags: string[][], content = "[]") => ({ rumorId: "01".repeat(32), author: "cd".repeat(32), kind: 3303, content, tags: [["delivery", "access"], ["scope", scope], ["newepoch", "2"], ...tags], ms: 0, createdAt: 0 });
  const cert = (c: string) => ["cert", "ef".repeat(32), c.repeat(128)];

  it("keeps every certificate a recipient is handed, so a valid one after junk still counts", () => {
    expect(parseDelivery(opened([cert("1"), cert("2")]))!.certs).toEqual([["ef".repeat(32), "1".repeat(128)], ["ef".repeat(32), "2".repeat(128)]]);
  });

  it("reads a mint part as u32::from_str does, a leading + or zeros allowed", () => {
    expect(parseDelivery(opened([["mint", "+1", "02"]]))!.mint).toEqual([1, 2]);
    expect(parseDelivery(opened([["mint", "-1", "2"]]))!.mint).toBeUndefined();
  });

  it("refuses blobs given a field twice, or holding a lone surrogate, as serde does", () => {
    expect(parseDelivery(opened([], `[{"locator":"a","locator":"b","wrapped":"c"}]`))).toBeUndefined();
    expect(parseDelivery(opened([], `[{"locator":"\\ud800","wrapped":"c"}]`))).toBeUndefined();
    expect(parseDelivery(opened([], `[{"locator":"a","wrapped":"c"}]`))!.blobs).toEqual([{ locator: "a", wrapped: "c" }]);
  });

  it("refuses an epoch past u64", () => {
    expect(parseDelivery({ ...opened([]), tags: [["delivery", "access"], ["scope", scope], ["newepoch", "18446744073709551616"]] })).toBeUndefined();
  });
});
