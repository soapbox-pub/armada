/**
 * The writer duty against Vector (CORD-03 §1, `service/writing.rs`): a Channel the
 * owner restricted, a member let post there and then not, and the Channel reopened.
 * At each step Armada's duty, judged on what Vector had published before acting,
 * decides what Vector did, and builds the edition and deliveries Vector sent.
 */
import { IDBFactory } from "fake-indexeddb";
import { encrypt as nip44Encrypt, getConversationKey } from "nostr-tools/nip44";
import type { NostrEvent } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";

import { accessCandidates } from "@/concord/lib/accessDuty";
import { foldControlState, openControlWraps, type FoldedControl } from "@/concord/lib/control";
import { accessPlane, parseDelivery, type ParsedDelivery } from "@/concord/lib/delivery";
import { bytesToHex, certifierScope, controlGroupKey, hex32, writerScope } from "@/concord/lib/derive";
import type { ParsedEdition } from "@/concord/lib/edition";
import type { CoalescedMember } from "@/concord/lib/guestbook";
import { myLocator } from "@/concord/lib/rekey";
import { openWrap } from "@/concord/lib/stream";
import type { Community } from "@/concord/lib/types";
import { planWriterDuty, postersOf, writerCandidates, type WriterDutyInput } from "@/concord/lib/writerDuty";
import { buildMint, certify, ledgerEdition } from "@/concord/lib/writerMint";
import { certDigest, ledgerToJson, parseLedger, verifyWriterCert } from "@/concord/lib/writers";

import actors from "./fixtures/cord25/writer_duty.actors.json";
import fixture from "./fixtures/cord25/writer_duty.json";

(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();

const c = fixture.community;
const community = { id: hex32(c.id), idHex: c.id, owner: c.owner, root: hex32(c.root), rootEpoch: BigInt(c.root_epoch), heldRoots: [], privateChannels: [], relays: [], name: "", ownerSalt: new Uint8Array(32) } as unknown as Community;
const events = fixture.events as unknown as NostrEvent[];
const read = controlGroupKey(hex32(c.root), hex32(c.id), BigInt(c.root_epoch));
const editionsOf = (evs: NostrEvent[]) => openControlWraps(evs, [{ pk: c.control_pk!, get convKey() { return read.convKey; }, restricted: true }]);
const at = (ids: string[]) => events.filter((e) => ids.includes(e.id));
const fold = (eds: ParsedEdition[]) => foldControlState(eds, hex32(c.id), c.owner);
const ledgers = (eds: ParsedEdition[]) => eds.filter((e) => e.vsk === "18").sort((a, b) => (a.version < b.version ? -1 : 1));
const plane = accessPlane(community, hex32(actors.general));
const deliveriesIn = (evs: NostrEvent[]) => evs.filter((e) => e.pubkey === plane.pk).flatMap((e) => parseDelivery(openWrap(e, plane)) ?? []);
const members = new Map<string, CoalescedMember>([actors.owner, actors.member].map((pk) => [pk, { pubkey: pk, state: "join", ms: 0, rumorId: "", fromSnapshot: false }]));
const memberSet = new Set(members.keys());
const writerScopeHex = bytesToHex(writerScope(hex32(actors.general)));

function planFor(control: FoldedControl, deliveries: ParsedDelivery[], o: Partial<WriterDutyInput> = {}) {
  return planWriterDuty({
    control,
    communityId: community.id,
    rootEpoch: 0,
    channelIdHex: actors.general,
    me: actors.owner,
    members: memberSet,
    candidates: writerCandidates(accessCandidates(control, members), control.ownerHex, actors.owner),
    deliveries,
    holdsLive: true,
    holdsCertifier: true,
    postableSince: Number.MAX_SAFE_INTEGER,
    walked: true,
    nowMs: Date.now(),
    due: () => true,
    sentWriter: new Set(),
    sentCertifier: new Set(),
    ...o,
  });
}

describe("the writer duty (Vector fixture)", () => {
  it("mints writer epoch 1 once a Roster restricts the Channel, as Vector did", async () => {
    const eds = editionsOf(at(actors.before_grant));
    const control = fold(eds.filter((e) => e.vsk !== "18"));
    const plan = planFor(control, [], { holdsLive: false, holdsCertifier: false });
    expect(plan).toEqual({ kind: "backstop", act: { kind: "mint", cut: [] }, lanes: [{ kind: "move" }] });

    const ownerSk = hex32(actors.owner_secret);
    const mint = (await buildMint({
      communityId: community.id,
      control,
      rootEpoch: 0,
      channelIdHex: actors.general,
      me: actors.owner,
      posters: postersOf(control, memberSet, actors.general),
      candidates: writerCandidates(accessCandidates(control, members), control.ownerHex, actors.owner),
      cut: [],
      secrets: () => ({ secret: hex32(actors.writer_secret), certifier: hex32(actors.certifier_secret) }),
      entryAtMs: Date.now(),
      nowMs: Date.now(),
      encrypt: async (pk, plain) => nip44Encrypt(plain, getConversationKey(ownerSk, pk)),
    }))!;
    expect(mint.epoch).toBe(actors.writer_epoch);
    const vector = parseLedger(ledgers(eds)[0].content)!;
    const ours = parseLedger(mint.edition.content)!;
    expect({ ...ours.entries[0], at: 0 }).toEqual({ ...vector.entries[0], at: 0 });
    // Only the owner may post or manages: served alone, certified, as a mint.
    const vectorMint = deliveriesIn(at(actors.before_grant)).filter((d) => d.scopeIdHex === writerScopeHex);
    const ourMint = mint.deliveries.map((r) => parseDelivery({ ...r, author: actors.owner, rumorId: r.id, ms: 0, createdAt: r.created_at } as never)!);
    const locators = (ds: ParsedDelivery[]) => ds.flatMap((d) => d.blobs.map((b) => b.locator)).sort();
    expect(locators(ourMint)).toEqual(locators(vectorMint));
    expect(ourMint.map((d) => d.mint)).toEqual(vectorMint.map((d) => d.mint));
    // Schnorr signatures carry random aux data: both certify the owner under the ledger's certifier.
    const certifier = (vector.entries[0].spell as { certifier: string }).certifier;
    const digest = certDigest(community.id, hex32(actors.general), actors.writer_epoch, hex32(actors.owner));
    expect(verifyWriterCert(certifier, digest, new Map(ourMint[0].certs).get(actors.owner)!)).toBe(true);
    expect(verifyWriterCert(certifier, digest, new Map(vectorMint[0].certs).get(actors.owner)!)).toBe(true);
    // The certifier goes to no other manager: there is none.
    expect(mint.deliveries.some((r) => r.tags.some((t) => t[0] === "scope" && t[1] === bytesToHex(certifierScope(hex32(actors.general)))))).toBe(false);
  });

  it("hands the live key, certified, to the member let post there, as Vector did", async () => {
    const before = at(actors.after_grant).filter((e) => e.pubkey !== plane.pk || actors.before_grant.includes(e.id));
    const control = fold(editionsOf(before));
    const plan = planFor(control, deliveriesIn(before));
    expect(plan).toEqual({ kind: "deliver", epoch: actors.writer_epoch, recipients: [actors.member] });
    const certs = certify(community.id, actors.general, actors.writer_epoch, hex32(actors.certifier_secret), [actors.member]);
    const vector = deliveriesIn(at(actors.after_grant)).find((d) => d.scopeIdHex === writerScopeHex && new Map(d.certs).has(actors.member))!;
    const certifier = (control.writers!.get(actors.general)!.entries[0].spell as { certifier: string }).certifier;
    const digest = certDigest(community.id, hex32(actors.general), actors.writer_epoch, hex32(actors.member));
    expect(verifyWriterCert(certifier, digest, certs.get(actors.member)!)).toBe(true);
    expect(verifyWriterCert(certifier, digest, new Map(vector.certs).get(actors.member)!)).toBe(true);
    expect(vector.blobs.some((b) => b.locator === myLocator(vector.deliverer, actors.member, writerScopeHex, BigInt(actors.writer_epoch)))).toBe(true);
    // Served, nothing is owed.
    expect(planFor(fold(editionsOf(at(actors.after_grant))), deliveriesIn(at(actors.after_grant)))).toEqual({ kind: "none" });
  });

  it("stops the one writer the Channel no longer lets post, as Vector did, then owes nothing", () => {
    const eds = editionsOf(at(actors.after_lose));
    const last = ledgers(eds).at(-1)!;
    const before = fold(eds.filter((e) => e !== last));
    expect(planFor(before, deliveriesIn(at(actors.after_lose)))).toEqual({ kind: "backstop", act: { kind: "stop", writer: actors.member }, lanes: [{ kind: "cut", member: actors.member }] });
    const vector = parseLedger(last.content)!;
    expect(vector.entries.at(-1)!.spell).toEqual({ kind: "stop", writer: actors.member });
    const ours = ledgerEdition({ communityId: community.id, control: before, channelIdHex: actors.general, base: before.writers!.get(actors.general)!, spell: { kind: "stop", writer: actors.member }, entryAtMs: Date.now(), nowMs: Date.now(), me: actors.owner })!;
    expect(parseLedger(ours.rumor.content)!.entries.at(-1)!.spell).toEqual(vector.entries.at(-1)!.spell);
    expect(planFor(fold(eds), deliveriesIn(at(actors.after_lose)))).toEqual({ kind: "none" });
  });

  it("brings the ledger in line once the Channel reopens, then owes nothing", () => {
    const eds = editionsOf(events);
    const last = ledgers(eds).at(-1)!;
    expect(parseLedger(last.content)!.entries.at(-1)!.spell).toEqual({ kind: "open" });
    const before = fold(eds.filter((e) => e !== last));
    expect(planFor(before, deliveriesIn(events))).toEqual({ kind: "backstop", act: { kind: "mint", cut: [] }, lanes: [{ kind: "move" }] });
    expect(planFor(fold(eds), deliveriesIn(events))).toEqual({ kind: "none" });
  });

  it("refuses an edition that doesn't chain from the head it holds", () => {
    const control = fold(editionsOf(events));
    const stale = parseLedger(ledgers(editionsOf(at(actors.before_grant)))[0].content)!;
    expect(ledgerEdition({ communityId: community.id, control, channelIdHex: actors.general, base: stale, spell: { kind: "open" }, entryAtMs: Date.now(), nowMs: Date.now(), me: actors.owner })).toBeUndefined();
  });
});

describe("ledger content, byte for byte (Vector `Ledger::to_json`)", () => {
  it("writes back every Vector ledger edition it parses as Vector wrote it", () => {
    const all = ledgers(editionsOf(events));
    expect(all.length).toBeGreaterThanOrEqual(3);
    for (const e of all) expect(ledgerToJson(parseLedger(e.content)!)).toBe(e.content);
  });
});
