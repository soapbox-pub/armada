import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/**
 * Shared mock for `light-bolt11-decoder`: `lnmock<msats>[:x][:h<hash>]`
 * invoices decode to controlled sections (`:x` = amountless, `:h` = explicit
 * payment hash, default {@link MOCK_PAYMENT_HASH} — settled by
 * {@link MOCK_PREIMAGE}); anything else hits the real decoder.
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
      const hash = parts.find((p) => p.startsWith("h"))?.slice(1) ?? MOCK_PAYMENT_HASH;
      return {
        sections: [
          ...(parts.includes("x") ? [] : [{ name: "amount", value: parts[0] }]),
          { name: "payment_hash", value: hash },
        ],
      };
    },
  };
}
