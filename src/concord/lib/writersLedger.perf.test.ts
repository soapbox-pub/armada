/**
 * Folding a long Writers ledger chain (CORD-03 §1). The chain of editions has no cap,
 * only the ledger inside each does, so a manager can lengthen it at will; Vector checks
 * each writer key once per run (`KeyCheck`) and walks the chain by hash (`ledger_chain_ok`),
 * and benchmarks a 1024-version chain (`bench_ledger_chain`).
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import { foldControlState } from "@/concord/lib/control";
import { bytesToHex, random32, writersLocator } from "@/concord/lib/derive";
import { Permissions } from "@/concord/lib/roles";
import { ledgerAppended, ledgerToJson, parseLedger } from "@/concord/lib/writers";
import { eidHex, hexKey, rankedCommunity } from "@/test/concordEditions";

const T0 = 1_700_000_000_000;
const point = () => bytesToHex(schnorr.getPublicKey(random32()));

describe("a long Writers ledger chain", () => {
  it("folds 1024 editions, each carrying a full ledger, in well under the time a check per key per edition took", () => {
    const { c, base } = rankedCommunity(Permissions.MANAGE_CHANNELS);
    const ch = hexKey();
    const eid = writersLocator(c.id, hexToBytes(ch));
    const at = Math.floor(T0 / 1000);
    let ledger = parseLedger(JSON.stringify({ channel: ch, ledger: [{ at: T0, epoch: 1, writer: point(), root: 0, by: c.owner }] }))!;
    let prev = c.edition({ vsk: "18", eid, author: c.owner, createdAt: at, content: ledgerToJson(ledger) });
    const chain = [prev];
    // Every edition a new writer epoch, so each holds 64 entries and up to 64 retired windows.
    for (let i = 1; i < 1024; i++) {
      ledger = ledgerAppended(ledger, T0, { kind: "writer", epoch: i + 1, pk: point(), root: 0, by: c.owner })!;
      prev = c.edition({ vsk: "18", eid, author: c.owner, createdAt: at, prev, content: ledgerToJson(ledger) });
      chain.push(prev);
    }
    const start = performance.now();
    const folded = foldControlState([...base, ...chain], c.id, c.owner);
    const took = performance.now() - start;
    expect(folded.heads.get(eidHex(prev))?.version).toBe(1024n);
    // ~20 ms an edition before; ~1 ms after.
    expect(took).toBeLessThan(5_000);
  });
});
