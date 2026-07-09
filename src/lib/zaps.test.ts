import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";

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

// Synthetic invoices ("lnmock…") decode to controlled sections; everything
// else hits the real decoder.
const PREIMAGE = "11".repeat(32);
const PAYMENT_HASH = bytesToHex(sha256(hexToBytes(PREIMAGE)));

vi.mock("light-bolt11-decoder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("light-bolt11-decoder")>();
  return {
    ...actual,
    decode: (invoice: string) => {
      if (!invoice.startsWith("lnmock")) return actual.decode(invoice);
      // lnmock<msats>[:x] — amount in millisats, ":x" = amountless
      const [, spec] = invoice.split("lnmock");
      const amountless = spec.endsWith(":x");
      const msats = spec.replace(":x", "");
      return {
        sections: [
          ...(amountless ? [] : [{ name: "amount", value: msats }]),
          { name: "payment_hash", value: PAYMENT_HASH },
        ],
      };
    },
  };
});

// BOLT11 spec test vector: 2500u = 250000000 msats.
const REAL_INVOICE =
  "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpu9qrsgquk0rl77nj30yxdy8j9vdx85fkpmdla2087ne0xh8nhedh8w27kyke0lp53ut353s06fv3qfegext0eh0ymjpf39tuven09sam30g4vgpfna3rh";

function receipt(opts: {
  id: string;
  targetId?: string;
  zapper?: string;
  amountMsats?: number;
  requestAmountMsats?: number;
  bolt11?: string;
  comment?: string;
  badDescription?: boolean;
}): NostrEvent {
  const request = {
    kind: 9734,
    pubkey: opts.zapper ?? "aa".repeat(32),
    content: opts.comment ?? "",
    tags: [
      ["e", opts.targetId ?? "target1"],
      ["p", "bb".repeat(32)],
      ...(opts.requestAmountMsats ? [["amount", String(opts.requestAmountMsats)]] : []),
    ],
    created_at: 0,
    id: "req",
    sig: "",
  };
  return {
    id: opts.id,
    kind: 9735,
    pubkey: "cc".repeat(32),
    content: "",
    created_at: 0,
    sig: "",
    tags: [
      ["e", opts.targetId ?? "target1"],
      ...(opts.amountMsats ? [["amount", String(opts.amountMsats)]] : []),
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
  it("extracts the embedded zap request", () => {
    const r = receipt({ id: "r1", zapper: "dd".repeat(32) });
    expect(receiptZapRequest(r)?.pubkey).toBe("dd".repeat(32));
  });

  it("rejects malformed descriptions", () => {
    expect(receiptZapRequest(receipt({ id: "r1", badDescription: true }))).toBeNull();
  });

  it("decodes amount from tag, then embedded request, then bolt11", () => {
    expect(receiptAmountSats(receipt({ id: "a", amountMsats: 21000 }))).toBe(21);
    expect(receiptAmountSats(receipt({ id: "b", requestAmountMsats: 5000 }))).toBe(5);
    expect(receiptAmountSats(receipt({ id: "c", bolt11: REAL_INVOICE }))).toBe(250000);
    expect(receiptAmountSats(receipt({ id: "d" }))).toBe(0);
  });
});

describe("tallyZaps", () => {
  it("sums, sorts desc, dedupes, and detects mine", () => {
    const me = "ee".repeat(32);
    const tally = tallyZaps(
      [
        receipt({ id: "r1", amountMsats: 21000 }),
        receipt({ id: "r1", amountMsats: 21000 }), // dupe id
        receipt({ id: "r2", amountMsats: 100000, zapper: me, comment: "gm" }),
      ],
      "target1",
      me,
    );
    expect(tally.count).toBe(2);
    expect(tally.totalSats).toBe(121);
    expect(tally.zaps[0].sats).toBe(100);
    expect(tally.zaps[0].comment).toBe("gm");
    expect(tally.mine).toBe(true);
  });

  it("drops receipts whose embedded request names a different target", () => {
    const spoofed = receipt({ id: "r1", amountMsats: 21000, targetId: "other" });
    expect(tallyZaps([spoofed], "target1").count).toBe(0);
  });

  it("drops receipts with no parsable amount", () => {
    expect(tallyZaps([receipt({ id: "r1" })], "target1").count).toBe(0);
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
      preimage: PREIMAGE,
    }),
    ...over,
  });

  it("accepts a valid preimage + matching amount", () => {
    expect(verifyZapRumor(rumor())).toBe(true);
  });

  it("rejects a wrong preimage", () => {
    const bad = rumor();
    bad.tags = bad.tags.map((t) => (t[0] === "preimage" ? ["preimage", "22".repeat(32)] : t));
    expect(verifyZapRumor(bad)).toBe(false);
  });

  it("rejects an amount tag that disagrees with the invoice", () => {
    const bad = rumor();
    bad.tags = bad.tags.map((t) => (t[0] === "amount" ? ["amount", "999000"] : t));
    expect(verifyZapRumor(bad)).toBe(false);
  });

  it("rejects amountless invoices", () => {
    const bad = rumor();
    bad.tags = bad.tags.map((t) => (t[0] === "bolt11" ? ["bolt11", "lnmock21000:x"] : t));
    expect(verifyZapRumor(bad)).toBe(false);
  });

  it("rejects missing proof tags and wrong kinds", () => {
    expect(verifyZapRumor({ kind: 9735, tags: [["bolt11", "lnmock21000"]] })).toBe(false);
    expect(verifyZapRumor({ kind: 9, tags: rumor().tags })).toBe(false);
  });
});
