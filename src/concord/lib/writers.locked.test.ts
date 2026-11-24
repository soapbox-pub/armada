/**
 * Locked Channels and sealed history in the Writers ledger (CORD-03 §1 at concord#27),
 * ported from Vector v0.5.2's `writers.rs` tests.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import { bytesToHex } from "@/concord/lib/derive";
import { Permissions } from "@/concord/lib/roles";
import {
  certDigest,
  certEventId,
  emptyLedger,
  ledgerAppended,
  ledgerAppendedSeal,
  ledgerExtends,
  ledgerLocked,
  ledgerRestricted,
  ledgerToJson,
  lockedAt,
  parseLedger,
  postStands,
  quietSpans,
  readAddressQuiet,
  readRange,
  runStart,
  scopeCovers,
  scopedCertDigest,
  sealTarget,
  signWriterCert,
  verifyWriterCert,
  writerStart,
  type Ledger,
  type SealRef,
  type Spell,
} from "@/concord/lib/writers";
import { KIND_DELETE, KIND_MESSAGE, KIND_REACTION, KIND_VOICE_PRESENCE } from "@/concord/lib/kinds";

const fill = (b: number) => new Uint8Array(32).fill(b);
const pk = (n: number) => bytesToHex(schnorr.getPublicKey(fill(n)));
const CH = "07".repeat(32);
const BY = pk(0x7f);
const MIN = 60_000;

const w = (epoch: number, n: number, certifier?: string): Spell => ({ kind: "writer", epoch, pk: pk(n), root: 0, by: BY, ...(certifier ? { certifier } : {}) });
const withWriter = (l: Ledger, at: number, s: Spell, locked: boolean) => ledgerAppended(l, at, s, undefined, locked)!;
const seal = (o: Partial<SealRef> & Pick<SealRef, "until" | "run" | "count">): SealRef => ({ page: "06".repeat(32), read: 2, extra: {}, ...o });

describe("a Locked window (CORD-03 §1)", () => {
  it("is carried whole and ends at the next move", () => {
    let l = withWriter(emptyLedger(CH), 100, w(1, 1), false);
    expect(ledgerRestricted(l) && !ledgerLocked(l)).toBe(true);
    l = withWriter(l, 200, w(2, 2), true);
    expect([ledgerLocked(l), lockedAt(l, 200), lockedAt(l, 10_000), lockedAt(l, 150)]).toEqual([true, true, true, false]);
    const back = parseLedger(ledgerToJson(l))!;
    expect(ledgerToJson(back)).toBe(ledgerToJson(l));
    expect(ledgerExtends(back, parseLedger(ledgerToJson(withWriter(emptyLedger(CH), 100, w(1, 1), false)))!)).toBe(true);
    l = ledgerAppended(l, 300, { kind: "open" })!;
    expect([ledgerLocked(l), lockedAt(l, 300), lockedAt(l, 250)]).toEqual([false, false, true]);
    // Only the flag set to true locks.
    const odd = parseLedger(ledgerToJson(l).replace('"locked":true', '"locked":"yes"'))!;
    expect(lockedAt(odd, 250)).toBe(false);
    // A stop sits inside the window without ending it.
    const stopped = ledgerAppended(withWriter(emptyLedger(CH), 100, w(1, 1), true), 150, { kind: "stop", writer: pk(9) })!;
    expect(ledgerLocked(stopped) && lockedAt(stopped, 160)).toBe(true);
  });

  it("makes a run one quiet stretch from ten minutes in", () => {
    let l = withWriter(emptyLedger(CH), 100 * MIN, w(1, 1), false);
    l = withWriter(l, 200 * MIN, w(2, 2), true);
    l = withWriter(l, 300 * MIN, w(3, 3), true);
    expect(quietSpans(l)).toEqual([{ from: 210 * MIN, to: undefined }]);
    expect(runStart(l)).toBe(200 * MIN);
    expect([readAddressQuiet(l, 250 * MIN), readAddressQuiet(l, 305 * MIN), readAddressQuiet(l, 205 * MIN)]).toEqual([true, true, false]);
    expect(readRange(l, 400 * MIN)).toEqual([0, 210 * MIN - 1]);
    expect(readRange(l, 150 * MIN)).toEqual([0, 150 * MIN]);
    l = ledgerAppended(l, 500 * MIN, { kind: "open" })!;
    expect(quietSpans(l)).toEqual([{ from: 210 * MIN, to: 500 * MIN }]);
    expect(readRange(l, 600 * MIN)).toEqual([500 * MIN, 600 * MIN]);
    expect(readRange(l, 499 * MIN)).toEqual([0, 210 * MIN - 1]);
    expect(runStart(l)).toBeUndefined();
  });

  it("keeps a seal's stretch past the cap", () => {
    let l = withWriter(emptyLedger(CH), 200 * MIN, w(1, 1), true);
    expect(sealTarget(l, 201 * MIN)).toBe(200 * MIN);
    l = ledgerAppendedSeal(l, 200 * MIN, seal({ until: 200 * MIN, run: 200 * MIN, count: 4 }))!;
    expect(sealTarget(l, 205 * MIN)).toBeUndefined();
    expect(sealTarget(l, 210 * MIN)).toBe(210 * MIN);
    expect(readRange(l, 209 * MIN)).toEqual([200 * MIN, 209 * MIN]);
    const second = seal({ page: "07".repeat(32), until: 210 * MIN, run: 200 * MIN, count: 5 });
    l = ledgerAppendedSeal(l, 211 * MIN, second)!;
    expect(sealTarget(l, 10_000 * MIN)).toBeUndefined();
    expect(ledgerToJson(parseLedger(ledgerToJson(l))!)).toBe(ledgerToJson(l));
    expect(readRange(l, 400 * MIN)).toBeUndefined();
    for (let e = 2; e <= 70; e++) l = withWriter(l, (211 + e) * MIN, w(e, (e % 200) + 1), true);
    expect(l.retired.some((r) => r.epoch === 1)).toBe(true);
    expect(l.entries.some((e) => "sealed" in e.extra)).toBe(false);
    expect(l.seal).toEqual(second);
    expect(sealTarget(l, 10_000 * MIN)).toBeUndefined();
    expect(readAddressQuiet(l, 212 * MIN)).toBe(true);
    expect(readRange(l, 10_000 * MIN)).toBeUndefined();
    // Opened and Locked again, the new run is the seal's no longer.
    l = withWriter(ledgerAppended(l, 400 * MIN, { kind: "open" })!, 500 * MIN, w(71, 9), true);
    expect(sealTarget(l, 10_000 * MIN)).toBe(500 * MIN);
    expect(quietSpans(l)).toEqual([{ from: 210 * MIN, to: 400 * MIN }, { from: 510 * MIN, to: undefined }]);
    expect(readRange(l, 10_000 * MIN)).toEqual([400 * MIN, 510 * MIN - 1]);
  });

  it("reads a seal that reaches past its run's first ten minutes, or lacks a field, as none, and carries it", () => {
    const l = ledgerAppendedSeal(withWriter(emptyLedger(CH), 200 * MIN, w(1, 1), true), 200 * MIN, seal({ until: 200 * MIN, run: 200 * MIN, count: 1 }))!;
    const json = ledgerToJson(l);
    const far = parseLedger(json.replace(`"until":${200 * MIN}`, `"until":${211 * MIN}`))!;
    expect(far.seal).toBeUndefined();
    expect(ledgerToJson(far)).toContain(`"until":${211 * MIN}`);
    expect(parseLedger(json.replace('"count":1,', ""))!.seal).toBeUndefined();
    const empty = parseLedger(json.replace(`"page":"${"06".repeat(32)}"`, '"page":null'))!.seal;
    expect(empty && empty.page === undefined && empty.count === 1).toBe(true);
  });
});

describe("a scoped writer certificate (CORD-03 §1)", () => {
  it("matches the published test vector", () => {
    const d = scopedCertDigest(fill(0x01), fill(0x02), 3, fill(0x04), Permissions.ADD_REACTIONS);
    expect(bytesToHex(d)).toBe("14129a75435ce645cd6c76d170f4ad61e88f54c0168a2deed48c9213b5eba10c");
    const certifier = bytesToHex(schnorr.getPublicKey(fill(0x05)));
    expect(certEventId(certifier, d)).toBe("418f80ff45b3122867c508997774858af6ab99bc12f18afb97ff2c99ad8a7db0");
    expect(verifyWriterCert(certifier, d, "ec9f4cf12a0f5f09f199fdf776e4416859531e60e70c66ec477711c1f184fad59c913e6378b2be73d632c17223dc70a9acfcc930bd351bac461e2b521682c145")).toBe(true);
  });

  it("vouches only for its rights, never a post, and is never a whole one", () => {
    const secret = fill(0x31);
    const certifier = bytesToHex(schnorr.getPublicKey(secret));
    const l = withWriter(emptyLedger(CH), 100, w(1, 1, certifier), true);
    const community = fill(1);
    const author = pk(5);
    const react = Permissions.ADD_REACTIONS;
    const cert = signWriterCert(secret, scopedCertDigest(community, fill(7), 1, fill(0).map((_, i) => parseInt(author.slice(i * 2, i * 2 + 2), 16)), react));
    const at = (kind: number, tags: string[][]) => postStands(l, community, { author, kind, ms: 200, tags: [["wepoch", "1"], ...tags] });
    expect(at(KIND_REACTION, [["rcert", cert, String(react)]])).toBe(true);
    expect(at(KIND_DELETE, [["rcert", cert, String(react)]])).toBe(true);
    expect(at(KIND_MESSAGE, [["rcert", cert, String(react)]])).toBe(false);
    expect(at(KIND_VOICE_PRESENCE, [["rcert", cert, String(react)]])).toBe(false);
    expect(at(KIND_REACTION, [["rcert", cert, String(react | Permissions.CONNECT)]])).toBe(false);
    expect(at(KIND_REACTION, [["wcert", cert]])).toBe(false);
    expect(postStands(l, community, { author: pk(6), kind: KIND_REACTION, ms: 200, tags: [["wepoch", "1"], ["rcert", cert, String(react)]] })).toBe(false);
    const whole = signWriterCert(secret, certDigest(community, fill(7), 1, fill(0).map((_, i) => parseInt(author.slice(i * 2, i * 2 + 2), 16))));
    expect(at(KIND_REACTION, [["rcert", whole, String(react)]])).toBe(false);
    expect(at(KIND_MESSAGE, [["wcert", whole]])).toBe(true);
    expect(writerStart(l, 1)).toBe(100);
    expect([scopeCovers(react, KIND_REACTION), scopeCovers(0n, KIND_DELETE), scopeCovers(Permissions.SEND_MESSAGES, KIND_MESSAGE)]).toEqual([true, true, false]);
  });
});
