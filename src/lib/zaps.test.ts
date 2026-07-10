import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it, vi } from "vitest";

import { MOCK_PAYMENT_HASH, MOCK_PREIMAGE, paymentHashOf } from "@/test/bolt11Mock";

import {
  bolt11AmountSats,
  bolt11Info,
  formatSats,
  receiptAmountSats,
  receiptZapRequest,
  tallyZaps,
  verifyZapRumor,
  zapRumorTags,
} from "@/lib/zaps";

import type { NostrEvent } from "@nostrify/nostrify";

vi.mock("light-bolt11-decoder", async (importOriginal) => {
  const { mockBolt11Decoder } = await import("@/test/bolt11Mock");
  return mockBolt11Decoder(await importOriginal<typeof import("light-bolt11-decoder")>());
});

// BOLT11 spec test vector: 2500u = 250000000 msats.
const REAL_INVOICE =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

// Receipts embed a SIGNED 9734 (tallyZaps verifies the signature).
const zapperSk = generateSecretKey();
const ZAPPER = getPublicKey(zapperSk);

let nextId = 0;
function receipt(opts: {
  id?: string;
  targetId?: string;
  sk?: Uint8Array;
  requestAmountMsats?: number;
  bolt11?: string;
  comment?: string;
  badDescription?: boolean;
  unsignedRequest?: boolean;
}): NostrEvent {
  const template = {
    kind: 9734,
    content: opts.comment ?? "",
    created_at: 0,
    tags: [
      ["e", opts.targetId ?? "target1"],
      ["p", "bb".repeat(32)],
      ...(opts.requestAmountMsats ? [["amount", String(opts.requestAmountMsats)]] : []),
    ],
  };
  const request = opts.unsignedRequest
    ? { ...template, pubkey: ZAPPER, id: "req", sig: "00".repeat(64) }
    : finalizeEvent(template, opts.sk ?? zapperSk);
  return {
    id: opts.id ?? `receipt${nextId++}`,
    kind: 9735,
    pubkey: "cc".repeat(32),
    content: "",
    created_at: 0,
    sig: "",
    tags: [
      ["e", opts.targetId ?? "target1"],
      ...(opts.bolt11 ? [["bolt11", opts.bolt11]] : []),
      ["description", opts.badDescription ? "{not json" : JSON.stringify(request)],
    ],
  };
}

describe("formatSats", () => {
  it("formats plain, k, and m ranges", () => {
    expect(formatSats(950)).toBe("950");
    expect(formatSats(1000)).toBe("1k");
    expect(formatSats(1234)).toBe("1.2k");
    expect(formatSats(21000)).toBe("21k");
    expect(formatSats(1_500_000)).toBe("1.5m");
  });
});

describe("bolt11 decoding", () => {
  it("decodes amount and payment hash from a real invoice", () => {
    const info = bolt11Info(REAL_INVOICE);
    expect(info.amountMsats).toBe(250000000);
    expect(info.paymentHash).toBe(
      "0001020304050607080900010203040506070809000102030405060708090102",
    );
    expect(bolt11AmountSats(REAL_INVOICE)).toBe(250000);
  });

  it("returns nulls on garbage without throwing", () => {
    expect(bolt11Info("not an invoice")).toEqual({ amountMsats: null, paymentHash: null });
  });
});

describe("receipt parsing", () => {
  it("extracts the embedded zap request when its signature verifies", () => {
    expect(receiptZapRequest(receipt({}))?.pubkey).toBe(ZAPPER);
  });

  it("rejects malformed descriptions and unsigned/forged requests", () => {
    expect(receiptZapRequest(receipt({ badDescription: true }))).toBeNull();
    expect(receiptZapRequest(receipt({ unsignedRequest: true }))).toBeNull();
  });

  it("takes the amount from the bolt11 invoice, not from tags", () => {
    const r = receipt({ bolt11: "lnmock21000" });
    expect(receiptAmountSats(r, receiptZapRequest(r)!)).toBe(21);
  });

  it("returns 0 when there is no invoice or the request disagrees with it", () => {
    const bare = receipt({ requestAmountMsats: 5000 });
    expect(receiptAmountSats(bare, receiptZapRequest(bare)!)).toBe(0);
    const inflated = receipt({ requestAmountMsats: 500_000_000, bolt11: "lnmock21000" });
    expect(receiptAmountSats(inflated, receiptZapRequest(inflated)!)).toBe(0);
  });
});

describe("tallyZaps", () => {
  it("sums, sorts desc, dedupes by id, and detects mine", () => {
    const dupe = receipt({ id: "r1", bolt11: "lnmock21000" });
    const tally = tallyZaps(
      [
        dupe,
        dupe, // dupe id
        receipt({ id: "r2", bolt11: `lnmock100000:h${paymentHashOf("22".repeat(32))}`, comment: "gm" }),
      ],
      "target1",
      ZAPPER,
    );
    expect(tally.count).toBe(2);
    expect(tally.totalSats).toBe(121);
    expect(tally.zaps[0].sats).toBe(100);
    expect(tally.zaps[0].comment).toBe("gm");
    expect(tally.mine).toBe(true);
  });

  it("counts one payment once: same invoice under a fresh receipt id is dropped", () => {
    const tally = tallyZaps(
      [receipt({ bolt11: "lnmock21000" }), receipt({ bolt11: "lnmock21000" })],
      "target1",
    );
    expect(tally.count).toBe(1);
    expect(tally.totalSats).toBe(21);
  });

  it("drops receipts whose embedded request names a different target", () => {
    const spoofed = receipt({ bolt11: "lnmock21000", targetId: "other" });
    expect(tallyZaps([spoofed], "target1").count).toBe(0);
  });

  it("drops receipts with no invoice to carry the amount", () => {
    expect(tallyZaps([receipt({ requestAmountMsats: 21000 })], "target1").count).toBe(0);
  });
});

describe("verifyZapRumor (CORD.md)", () => {
  const rumor = (over: Partial<{ kind: number; tags: string[][] }> = {}) => ({
    kind: 9735,
    tags: zapRumorTags({
      targetId: "t1",
      targetKind: 9,
      recipient: "bb".repeat(32),
      amountMsats: 21000,
      bolt11: "lnmock21000",
      preimage: MOCK_PREIMAGE,
    }),
    ...over,
  });

  it("accepts a valid preimage + matching amount and returns the payment hash", () => {
    expect(verifyZapRumor(rumor())).toBe(MOCK_PAYMENT_HASH);
  });

  it("rejects a wrong preimage", () => {
    const bad = rumor();
    bad.tags = bad.tags.map((t) => (t[0] === "preimage" ? ["preimage", "22".repeat(32)] : t));
    expect(verifyZapRumor(bad)).toBeNull();
  });

  it("rejects an amount tag that disagrees with the invoice", () => {
    const bad = rumor();
    bad.tags = bad.tags.map((t) => (t[0] === "amount" ? ["amount", "999000"] : t));
    expect(verifyZapRumor(bad)).toBeNull();
  });

  it("rejects amountless invoices", () => {
    const bad = rumor();
    bad.tags = bad.tags.map((t) => (t[0] === "bolt11" ? ["bolt11", "lnmock21000:x"] : t));
    expect(verifyZapRumor(bad)).toBeNull();
  });

  it("rejects missing proof tags and wrong kinds", () => {
    expect(verifyZapRumor({ kind: 9735, tags: [["bolt11", "lnmock21000"]] })).toBeNull();
    expect(verifyZapRumor({ kind: 9, tags: rumor().tags })).toBeNull();
  });

  it("omits the e tag when the send path adds the target itself", () => {
    const tags = zapRumorTags({
      targetId: "t1",
      targetKind: 9,
      recipient: "bb".repeat(32),
      amountMsats: 21000,
      bolt11: "lnmock21000",
      preimage: MOCK_PREIMAGE,
      omitTarget: true,
    });
    expect(tags.some((t) => t[0] === "e")).toBe(false);
  });
});
