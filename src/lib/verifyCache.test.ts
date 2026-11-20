/**
 * The verify memo's security argument, pinned:
 *
 *  - the hash is recomputed for EVERY copy, so a verified id can never bless
 *    different content;
 *  - a failed verify is never memoized, so a forged copy can't poison the id
 *    for the honest copy arriving later;
 *  - the memo genuinely engages: a re-received copy of identical content is
 *    accepted without a second Schnorr pass (even with a mangled sig — the
 *    documented, deliberate acceptance).
 */
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { _resetVerifyCacheForTests, idIsHash, persistVerifiedIds, primeHashes, verifyEventOnce, verifyEventsOnce } from "./verifyCache";
import { perfReport, perfReset } from "./perf";
import { ecVerifyBatch as inlineEcVerify } from "./verifyPool";

import type { NostrEvent } from "@nostrify/nostrify";
import type { EcVerifyBatch } from "./verifyCache";

function signed(content = "hello"): NostrEvent {
  return finalizeEvent(
    { kind: 1, content, tags: [], created_at: 1000 },
    generateSecretKey(),
  );
}

beforeEach(() => {
  _resetVerifyCacheForTests();
});

describe("verifyEventOnce", () => {
  it("accepts a validly signed event and rejects a bad signature", () => {
    expect(verifyEventOnce(signed())).toBe(true);
    expect(verifyEventOnce({ ...signed("other"), sig: "00".repeat(64) })).toBe(false);
  });

  it("never lets a verified id bless different content", () => {
    const ev = signed();
    expect(verifyEventOnce(ev)).toBe(true);
    // Same claimed id and sig, tampered content: the recomputed hash no longer
    // matches the id, so the memo entry for that id must not apply.
    expect(verifyEventOnce({ ...ev, content: "tampered" })).toBe(false);
  });

  it("accepts a re-received copy of identical content without re-verifying", () => {
    const ev = signed();
    expect(verifyEventOnce(ev)).toBe(true);
    // Identical content (hash matches the verified id) with a garbage sig:
    // accepted, because the content is authentic and sigs are stripped before
    // storage. Passing here is also the proof that the memo engaged at all —
    // a full verify of this copy would reject it.
    expect(verifyEventOnce({ ...ev, sig: "00".repeat(64) })).toBe(true);
  });

  it("does not memoize a failed verify — the honest copy still passes later", () => {
    const ev = signed();
    expect(verifyEventOnce({ ...ev, sig: "00".repeat(64) })).toBe(false);
    expect(verifyEventOnce(ev)).toBe(true);
  });
});

describe("verifyEventsOnce", () => {
  it("returns one verdict per event, in input order, through the real inline verifier", async () => {
    const good = [signed("a"), signed("b"), signed("c")];
    const bad = { ...signed("d"), sig: "00".repeat(64) };
    const tampered = { ...signed("e"), content: "tampered" };

    const results = await verifyEventsOnce([good[0], bad, good[1], tampered, good[2]], inlineEcVerify);

    expect(results).toEqual([true, false, true, false, true]);
  });

  it("applies the same security argument as the sync path — a verified id never blesses different content", async () => {
    const ev = signed();
    expect(await verifyEventsOnce([ev], inlineEcVerify)).toEqual([true]);
    // Tampered content riding a known-good id must be hash-refused on the main
    // thread, without the EC verifier ever being consulted.
    const ecVerify = vi.fn<EcVerifyBatch>(async (triples) => triples.map(() => true));
    expect(await verifyEventsOnce([{ ...ev, content: "tampered" }], ecVerify)).toEqual([false]);
    expect(ecVerify).not.toHaveBeenCalled();
  });

  it("hands the EC verifier only the residue the memo can't answer", async () => {
    const seen = signed("seen");
    const fresh = signed("fresh");
    expect(verifyEventOnce(seen)).toBe(true);

    const ecVerify = vi.fn<EcVerifyBatch>(inlineEcVerify);
    const results = await verifyEventsOnce([seen, fresh], ecVerify);

    expect(results).toEqual([true, true]);
    expect(ecVerify).toHaveBeenCalledTimes(1);
    expect(ecVerify.mock.calls[0][0]).toEqual([{ sig: fresh.sig, id: fresh.id, pubkey: fresh.pubkey }]);
  });

  it("feeds the memo: a batched verify makes the sync path's later copy a memo hit", async () => {
    const ev = signed();
    expect(await verifyEventsOnce([ev], inlineEcVerify)).toEqual([true]);
    // A mangled-sig copy passing is the proof the memo engaged (see above).
    expect(verifyEventOnce({ ...ev, sig: "00".repeat(64) })).toBe(true);
  });

  it("does not memoize a failed batched verify — the honest copy still passes later", async () => {
    const ev = signed();
    expect(await verifyEventsOnce([{ ...ev, sig: "00".repeat(64) }], inlineEcVerify)).toEqual([false]);
    expect(await verifyEventsOnce([ev], inlineEcVerify)).toEqual([true]);
  });

  it("reads a throwing verifier as unverified for the residue, never as an exception", async () => {
    const memoized = signed("memoized");
    expect(verifyEventOnce(memoized)).toBe(true);
    const fresh = signed("fresh");

    const broken: EcVerifyBatch = async () => {
      throw new Error("worker exploded");
    };
    const results = await verifyEventsOnce([memoized, fresh], broken);

    // The memo hit survives; only the residue reads as unverified — and is not
    // memoized as failed, so the same event verifies once the verifier works.
    expect(results).toEqual([true, false]);
    expect(await verifyEventsOnce([fresh], inlineEcVerify)).toEqual([true]);
  });

  it("pads a short answer with false instead of leaving holes", async () => {
    const events = [signed("a"), signed("b"), signed("c")];
    const short: EcVerifyBatch = async (triples) => triples.slice(0, 1).map(() => true);

    const results = await verifyEventsOnce(events, short);

    expect(results).toEqual([true, false, false]);
    for (const r of results) expect(typeof r).toBe("boolean");
  });

  it("verifies a duplicate id within one batch only once", async () => {
    const ev = signed();
    const ecVerify = vi.fn<EcVerifyBatch>(inlineEcVerify);

    const results = await verifyEventsOnce([ev, { ...ev }, ev], ecVerify);

    expect(results).toEqual([true, true, true]);
    // One EC verify for three identical copies: the residue is deduped by the
    // whole triple, so the same seal arriving from two relays in one batch
    // costs one point-mul.
    const handed = ecVerify.mock.calls.flatMap((c) => c[0]);
    expect(handed).toHaveLength(1);
  });

  it("does not let a mangled-sig copy veto the honest copy's verdict in one batch", async () => {
    // Same id (identical content — the hash still binds), different sigs. A
    // keyholder can craft exactly this: take a victim's real seal, mangle its
    // sig, re-wrap it. If the dedupe keyed by id alone, the mangled copy
    // arriving FIRST would carry its verdict onto the honest copy — and
    // openChatBatch memoizes a false verdict per wrap for the session, so
    // that would be message suppression, not a hiccup.
    const ev = signed();
    const mangled = { ...ev, sig: "00".repeat(64) };

    const results = await verifyEventsOnce([mangled, ev], inlineEcVerify);

    expect(results).toEqual([false, true]);
  });

  it("handles an empty batch without consulting the verifier", async () => {
    const ecVerify = vi.fn<EcVerifyBatch>(inlineEcVerify);
    expect(await verifyEventsOnce([], ecVerify)).toEqual([]);
    expect(ecVerify).not.toHaveBeenCalled();
  });
});

describe("persistVerifiedIds", () => {
  /** An in-memory stand-in for ArmadaKV's key/value/prefix-list surface. */
  function memoryKv() {
    const rows = new Map<string, string>();
    return {
      rows,
      kv: {
        set: async (key: string, value: string) => void rows.set(key, value),
        delete: async (key: string) => void rows.delete(key),
        list: async <T,>({ prefix }: { prefix: string }) =>
          [...rows].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: value as T })),
      },
    };
  }

  it("carries a verdict into the next session, but never one for different content", async () => {
    vi.useFakeTimers();
    try {
      const store = memoryKv();
      const ev = signed("kept");
      persistVerifiedIds(() => store.kv);
      expect(verifyEventOnce(ev)).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect([...store.rows.keys()]).toHaveLength(1);

      // A relaunch: an empty memo, the same store.
      _resetVerifyCacheForTests();
      persistVerifiedIds(() => store.kv);
      // The first verify starts the load; let it land.
      verifyEventOnce(signed("unrelated"));
      await vi.advanceTimersByTimeAsync(0);
      // The saved verdict answers without a Schnorr pass — the mangled sig is
      // the proof, exactly as within one session.
      expect(verifyEventOnce({ ...ev, sig: "00".repeat(64) })).toBe(true);
      // Different content still has to be proven.
      expect(verifyEventOnce({ ...ev, content: "changed", sig: "00".repeat(64) })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("idIsHash", () => {
  it("takes an identical copy without hashing, and never a changed one", () => {
    const event = signed("original");
    expect(idIsHash(event)).toBe(true);
    perfReset();
    expect(idIsHash({ ...event, tags: [] })).toBe(true);
    expect(perfReport().aggregates.find((a) => a.label === "crypto.idHash (copy hit)")?.count).toBe(1);
    expect(idIsHash({ ...event, content: "forged" })).toBe(false);
    expect(idIsHash({ ...event, tags: [["p", "x"]] })).toBe(false);
    expect(idIsHash({ ...event, created_at: event.created_at + 1 })).toBe(false);
  });

  it("isn't fooled by the remembered copy being mutated after", () => {
    const event = signed("original");
    expect(idIsHash(event)).toBe(true);
    event.tags.push(["p", "x"]);
    expect(idIsHash({ ...event, tags: [] })).toBe(true);
    expect(idIsHash(event)).toBe(false);
  });
});

describe("primeHashes", () => {
  it("settles a batch natively, so the synchronous checks after it are copy hits, and primes no forgery", async () => {
    const events = ["a", "b", "c", "d", "e"].map((c) => signed(c));
    const forged = { ...signed("f"), content: "forged" };
    await primeHashes([...events, forged]);
    perfReset();
    for (const e of events) expect(idIsHash({ ...e, tags: e.tags.map((t) => [...t]) })).toBe(true);
    expect(perfReport().aggregates.find((a) => a.label === "crypto.idHash (copy hit)")?.count).toBe(5);
    expect(idIsHash(forged)).toBe(false);
  });
});
