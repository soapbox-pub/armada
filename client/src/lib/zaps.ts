/**
 * Zaps — shared pure helpers for both zap surfaces:
 *
 *  - NIP-29 group chat: standard NIP-57. The LNURL provider publishes a public
 *    kind-9735 receipt to our app relays; we aggregate receipts per message
 *    ({@link tallyZaps}) and decode amounts defensively across the three
 *    places an amount can live.
 *
 *  - Concord v2 channels: CORD.md private zaps. No public event exists — the
 *    payer seals a kind-9735-shaped rumor (NIP-57 receipt shape + `preimage`
 *    tag) into the Chat Plane, and every member verifies the payment locally
 *    ({@link verifyZapRumor}): sha256(preimage) must equal the invoice's
 *    payment hash and the `amount` tag must match the invoice's amount.
 *
 * Everything here is pure (no React, no network) so it tests in isolation and
 * folds can call it synchronously.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { decode as decodeBolt11 } from "light-bolt11-decoder";

import type { NostrEvent } from "@nostrify/nostrify";

export const KIND_ZAP_RECEIPT = 9735;

/** Preset amounts (sats) for the zap dialog. */
export const ZAP_PRESETS = [21, 100, 500, 1000, 5000, 21000];

/** One counted zap on a message. */
export interface ZapEntry {
  /** Receipt event id (NIP-29) or rumor id (Concord). */
  id: string;
  /** The zapper's pubkey (embedded 9734 author for NIP-29; seal author for Concord). */
  pubkey: string;
  sats: number;
  comment: string;
}

/** Aggregated zaps for one message. */
export interface ZapTally {
  totalSats: number;
  count: number;
  /** Whether the current user is among the zappers. */
  mine: boolean;
  /** Individual zaps, largest first. */
  zaps: ZapEntry[];
}

/** "1234567" → "1.2m", "21000" → "21k", "950" → "950". */
export function formatSats(sats: number): string {
  if (sats >= 1_000_000) return `${trimmed(sats / 1_000_000)}m`;
  if (sats >= 1_000) return `${trimmed(sats / 1_000)}k`;
  return String(sats);
}

function trimmed(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return rounded % 1 === 0 ? String(Math.round(rounded)) : rounded.toFixed(1);
}

// ── bolt11 ────────────────────────────────────────────────────────────────────

interface Bolt11Info {
  /** Millisats, or null for an amountless invoice. */
  amountMsats: number | null;
  /** Lowercase hex payment hash, or null if absent/undecodable. */
  paymentHash: string | null;
}

/** Decode the two invoice fields zaps care about. Never throws. */
export function bolt11Info(invoice: string): Bolt11Info {
  try {
    const decoded = decodeBolt11(invoice.trim());
    let amountMsats: number | null = null;
    let paymentHash: string | null = null;
    for (const section of decoded.sections as Array<{ name: string; value?: unknown }>) {
      if (section.name === "amount") {
        const n = Number(section.value);
        if (Number.isFinite(n) && n > 0) amountMsats = n;
      } else if (section.name === "payment_hash" && typeof section.value === "string") {
        paymentHash = section.value.toLowerCase();
      }
    }
    return { amountMsats, paymentHash };
  } catch {
    return { amountMsats: null, paymentHash: null };
  }
}

/** Whole sats encoded in an invoice, or null (amountless/undecodable). */
export function bolt11AmountSats(invoice: string): number | null {
  const { amountMsats } = bolt11Info(invoice);
  return amountMsats === null ? null : Math.floor(amountMsats / 1000);
}

// ── NIP-29: public kind-9735 receipts ────────────────────────────────────────

function tagValue(ev: NostrEvent, name: string): string | undefined {
  return ev.tags.find((t) => t[0] === name)?.[1];
}

/** The embedded, provider-verified kind-9734 zap request, or null. */
export function receiptZapRequest(receipt: NostrEvent): NostrEvent | null {
  const description = tagValue(receipt, "description");
  if (!description) return null;
  try {
    const request = JSON.parse(description) as NostrEvent;
    if (request && typeof request.pubkey === "string" && request.kind === 9734) {
      return request;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A receipt's amount in sats, checked across the three places it can live:
 * the receipt's own `amount` tag, the embedded zap request's `amount` tag,
 * and finally the bolt11 invoice itself.
 */
export function receiptAmountSats(receipt: NostrEvent): number {
  const own = Number(tagValue(receipt, "amount"));
  if (Number.isFinite(own) && own > 0) return Math.floor(own / 1000);
  const request = receiptZapRequest(receipt);
  if (request) {
    const requested = Number(request.tags.find((t) => t[0] === "amount")?.[1]);
    if (Number.isFinite(requested) && requested > 0) return Math.floor(requested / 1000);
  }
  const bolt11 = tagValue(receipt, "bolt11");
  if (bolt11) return bolt11AmountSats(bolt11) ?? 0;
  return 0;
}

/**
 * Fold public kind-9735 receipts for ONE target message into a tally.
 * Guards: dedupe by receipt id, and drop receipts whose embedded zap request
 * doesn't actually name `targetId` in its `e` tag (a relay answering a `#e`
 * query is trusted for routing, not for content).
 */
export function tallyZaps(
  receipts: NostrEvent[],
  targetId: string,
  userPubkey?: string,
): ZapTally {
  const seen = new Set<string>();
  const zaps: ZapEntry[] = [];
  for (const receipt of receipts) {
    if (receipt.kind !== KIND_ZAP_RECEIPT || seen.has(receipt.id)) continue;
    const request = receiptZapRequest(receipt);
    if (!request) continue;
    if (!request.tags.some((t) => t[0] === "e" && t[1] === targetId)) continue;
    const sats = receiptAmountSats(receipt);
    if (sats <= 0) continue;
    seen.add(receipt.id);
    zaps.push({ id: receipt.id, pubkey: request.pubkey, sats, comment: request.content ?? "" });
  }
  zaps.sort((a, b) => b.sats - a.sats);
  return {
    totalSats: zaps.reduce((sum, z) => sum + z.sats, 0),
    count: zaps.length,
    mine: Boolean(userPubkey && zaps.some((z) => z.pubkey === userPubkey)),
    zaps,
  };
}

// ── CORD.md: sealed zap rumors ────────────────────────────────────────────────

/**
 * Verify a CORD.md zap rumor's payment proof (§4):
 *   - sha256(preimage) equals the bolt11 invoice's payment hash, and
 *   - the `amount` tag equals the invoice's encoded amount (millisats).
 * Channel/epoch binding is the plane decoder's job (it checks every chat
 * rumor); this checks only what is zap-specific. Never throws.
 */
export function verifyZapRumor(rumor: {
  kind: number;
  tags: string[][];
}): boolean {
  if (rumor.kind !== KIND_ZAP_RECEIPT) return false;
  const find = (name: string) => rumor.tags.find((t) => t[0] === name)?.[1];
  const bolt11 = find("bolt11");
  const preimage = find("preimage");
  const amount = Number(find("amount"));
  if (!bolt11 || !preimage || !/^[0-9a-f]{64}$/.test(preimage)) return false;
  if (!Number.isFinite(amount) || amount <= 0) return false;

  const { amountMsats, paymentHash } = bolt11Info(bolt11);
  if (!paymentHash || amountMsats === null) return false; // amountless invoices are not zappable
  if (amountMsats !== amount) return false;
  try {
    return bytesToHex(sha256(hexToBytes(preimage))) === paymentHash;
  } catch {
    return false;
  }
}

/** Build the CORD.md zap rumor tag set (binding tags are added by the send path). */
export function zapRumorTags(opts: {
  targetId: string;
  targetKind: number;
  recipient: string;
  amountMsats: number;
  bolt11: string;
  preimage: string;
}): string[][] {
  return [
    ["e", opts.targetId],
    ["p", opts.recipient],
    ["k", String(opts.targetKind)],
    ["amount", String(opts.amountMsats)],
    ["bolt11", opts.bolt11],
    ["preimage", opts.preimage],
  ];
}
