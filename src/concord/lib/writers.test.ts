import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import { bytesToHex } from "@/concord/lib/derive";
import {
  certDigest,
  certEventId,
  parseLedger,
  postStands,
  readAddressTakes,
  signWriterCert,
  stopped,
  verifyWriterCert,
  writerWindows,
} from "@/concord/lib/writers";

const fill = (b: number) => new Uint8Array(32).fill(b);

describe("writer certificates (CORD-03 §1 test vector)", () => {
  const d = certDigest(fill(0x01), fill(0x02), 3, fill(0x04));
  const certifier = bytesToHex(schnorr.getPublicKey(fill(0x05)));

  it("derives the digest, certifier and event id", () => {
    expect(bytesToHex(d)).toBe("f49b5c7359b09366b5b96e074d2b7c5a84bd714a04bf0e6270d13c02d453e619");
    expect(certifier).toBe("62c0a046dacce86ddd0343c6d3c7c79c2208ba0d9c9cf24a6d046d21d21f90f7");
    expect(certEventId(certifier, d)).toBe("1b6fcc32de4a485d7b0109b0e5dd91b7c676fcb26f7dc41c8c2bdc7e3f2cbe90");
  });

  it("verifies the vector's signature and its own, and nothing else", () => {
    const sig = "cd1c3030e1220c539f1efb50d32e5b83432baa20eaa8709aa935050dc11a6ac6e25c3f9555b729cee65829fdbf1ba5e7656865a4fca860e42b05c8341922895a";
    expect(verifyWriterCert(certifier, d, sig)).toBe(true);
    expect(verifyWriterCert(certifier, d, signWriterCert(fill(0x05), d))).toBe(true);
    expect(verifyWriterCert(certifier, certDigest(fill(0x01), fill(0x02), 4, fill(0x04)), sig)).toBe(false);
  });
});

describe("the Writers ledger", () => {
  const pk = (b: number) => bytesToHex(schnorr.getPublicKey(fill(b)));
  const ledger = {
    channel: "02".repeat(32),
    ledger: [
      { at: 1000, epoch: 1, writer: pk(0x10), root: 0, by: "ab".repeat(32), certifier: pk(0x11) },
      { at: 2000, stop: pk(0x20) },
      { at: 3000, open: true },
    ],
  };

  it("parses windows and stops", () => {
    const l = parseLedger(JSON.stringify(ledger))!;
    expect(writerWindows(l)).toEqual([{ epoch: 1, pk: pk(0x10), from: 1000, to: 3000, certifier: pk(0x11) }]);
    expect(stopped(l, 1, pk(0x20), 1999)).toBe(false);
    expect(stopped(l, 1, pk(0x20), 2000)).toBe(true);
    expect(readAddressTakes(l, 999)).toBe(true);
    expect(readAddressTakes(l, 1500)).toBe(false);
    expect(readAddressTakes(l, 3000)).toBe(true);
  });

  it("refuses an out-of-order ledger and a stop after an open", () => {
    expect(parseLedger(JSON.stringify({ ...ledger, ledger: [ledger.ledger[1], ledger.ledger[0]] }))).toBeUndefined();
    expect(parseLedger(JSON.stringify({ ...ledger, ledger: [ledger.ledger[0], ledger.ledger[2], { at: 4000, stop: pk(0x20) }] }))).toBeUndefined();
  });

  it("stands a post by its window, certificate and stops", () => {
    const l = parseLedger(JSON.stringify(ledger))!;
    const author = pk(0x30);
    const good = signWriterCert(fill(0x11), certDigest(fill(0x01), fill(0x02), 1, hexBytes(author)));
    expect(postStands(l, fill(0x01), { author, ms: 1500, tags: [["wepoch", "1"], ["wcert", good]] })).toBe(true);
    expect(postStands(l, fill(0x01), { author, ms: 1500, tags: [["wepoch", "1"]] })).toBe(false);
    expect(postStands(l, fill(0x01), { author, ms: 3500, tags: [["wepoch", "1"], ["wcert", good]] })).toBe(false);
    expect(postStands(l, fill(0x01), { author, ms: 1500, tags: [] })).toBe(false);
  });
});

function hexBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
}
