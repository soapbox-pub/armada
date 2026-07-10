import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/**
 * Shared mock for `light-bolt11-decoder`: synthetic invoices decode to
 * controlled sections so zap verification and folding can be tested without a
 * bolt11 encoder; anything not starting with "lnmock" hits the real decoder.
 *
 * Invoice grammar: `lnmock<msats>[:x][:h<hash>]`
 *   - `<msats>`  — the amount section (decimal millisats)
 *   - `:x`       — amountless (no amount section)
 *   - `:h<hash>` — explicit payment hash (defaults to {@link MOCK_PAYMENT_HASH},
 *                  i.e. the invoice {@link MOCK_PREIMAGE} settles)
 *
 * Usage (the factory must be inline for vitest's hoisting):
 *
 *   vi.mock("light-bolt11-decoder", async (importOriginal) => {
 *     const { mockBolt11Decoder } = await import("@/test/bolt11Mock");
 *     return mockBolt11Decoder(await importOriginal());
 *   });
 */

export const MOCK_PREIMAGE = "11".repeat(32);
export const MOCK_PAYMENT_HASH = bytesToHex(sha256(hexToBytes(MOCK_PREIMAGE)));

export function paymentHashOf(preimage: string): string {
  return bytesToHex(sha256(hexToBytes(preimage)));
}

export function mockBolt11Decoder(actual: typeof import("light-bolt11-decoder")) {
  return {
    ...actual,
    decode: (invoice: string) => {
      if (!invoice.startsWith("lnmock")) return actual.decode(invoice);
      const parts = invoice.slice("lnmock".length).split(":");
      const msats = parts[0];
      const amountless = parts.includes("x");
      const hash = parts.find((p) => p.startsWith("h"))?.slice(1) ?? MOCK_PAYMENT_HASH;
      return {
        sections: [
          ...(amountless ? [] : [{ name: "amount", value: msats }]),
          { name: "payment_hash", value: hash },
        ],
      };
    },
  };
}
