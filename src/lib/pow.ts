/**
 * NIP-13 proof of work on the OUTER events Armada publishes: everything a
 * relay is handed as an EVENT, never a seal, rumor or auth token inside or
 * beside one. The difficulty is the user's (`AppConfig.powDifficulty`, pushed
 * here by `AppProvider`), else the deployment's `POW_DIFFICULTY`, else
 * {@link DEFAULT_POW_DIFFICULTY}.
 */
import { NSecSigner } from "@nostrify/nostrify";
import { sha256 } from "@noble/hashes/sha2.js";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { config } from "@/lib/env";

import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

export const DEFAULT_POW_DIFFICULTY = 0;
export const MAX_POW_DIFFICULTY = 32;

/** Mining runs on the UI thread, so it yields this often; matches `verifyPool`'s inline slice. */
const SLICE_MS = 5;

/**
 * Kinds the user's signer signs that never reach a relay as an EVENT: seals
 * (NIP-59, CORD-01) ride inside a wrap, AUTH and HTTP/Blossom tokens are
 * credentials, and a zap request goes to the LNURL server.
 */
const POW_EXEMPT_KINDS = new Set([13, 9734, 20013, 20014, 22242, 24242, 27235]);

/** A difficulty in bits, clamped to {@link MAX_POW_DIFFICULTY}; undefined when not one. */
export function parsePowDifficulty(value: unknown): number | undefined {
  const n = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < 0) return undefined;
  return Math.min(n, MAX_POW_DIFFICULTY);
}

/** The deployment's default: `POW_DIFFICULTY` (build or `window.ENV`), else {@link DEFAULT_POW_DIFFICULTY}. */
export function defaultPowDifficulty(): number {
  return parsePowDifficulty(config("POW_DIFFICULTY")) ?? DEFAULT_POW_DIFFICULTY;
}

let chosenDifficulty: number | undefined;

/** The user's choice; `undefined` follows {@link defaultPowDifficulty}. */
export function setPowDifficulty(bits: number | undefined): void {
  chosenDifficulty = bits === undefined ? undefined : parsePowDifficulty(bits);
}

export function powDifficulty(): number {
  return chosenDifficulty ?? defaultPowDifficulty();
}

/** NIP-13 difficulty: the number of leading zero bits of an id. */
export function leadingZeroBits(hash: Uint8Array): number {
  let bits = 0;
  for (const byte of hash) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
}

/**
 * `template` with a `nonce` tag that gives `pubkey`'s event at least
 * `difficulty` leading zero bits. `created_at` is left alone, since wraps are
 * deliberately backdated. Any `nonce` tag already present is replaced.
 */
export async function minePow<T extends EventTemplate>(
  template: T,
  pubkey: string,
  difficulty: number = powDifficulty(),
): Promise<T> {
  const tags = template.tags.filter(([name]) => name !== "nonce");
  if (difficulty <= 0) return tags.length === template.tags.length ? template : { ...template, tags };

  // The NIP-01 serialization, split around the nonce value so only the nonce and
  // what follows it are hashed per attempt.
  const target = String(difficulty);
  const tagsJson = JSON.stringify([...tags, ["nonce", "", target]]);
  const tail = `",${JSON.stringify(target)}]]`;
  const prefix = `[0,${JSON.stringify(pubkey)},${template.created_at},${template.kind},${tagsJson.slice(0, -tail.length)}`;
  const encoder = new TextEncoder();
  const base = sha256.create().update(encoder.encode(prefix));
  const suffix = encoder.encode(`${tail},${JSON.stringify(template.content)}]`);

  let sliceStart = performance.now();
  for (let n = 0; ; n++) {
    const nonce = n.toString();
    const hash = base.clone().update(encoder.encode(nonce)).update(suffix).digest();
    if (leadingZeroBits(hash) >= difficulty) {
      return { ...template, tags: [...tags, ["nonce", nonce, target]] };
    }
    // Checked every attempt: one hashes the whole content, so on a slow phone a
    // few dozen already overrun the slice, and a typical mine is under 256.
    if (performance.now() - sliceStart >= SLICE_MS) {
      await yieldToEventLoop();
      sliceStart = performance.now();
    }
  }
}

/** A macrotask turn without `setTimeout`'s nested 4ms clamp, which would idle a long mine ~half the time. */
function yieldToEventLoop(): Promise<void> {
  if (typeof MessageChannel === "undefined") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = () => {
      port1.close();
      resolve();
    };
    port2.postMessage(null);
  });
}

/** `finalizeEvent` with proof of work, for events signed by a key held here. */
export async function finalizePowEvent(template: EventTemplate, sk: Uint8Array): Promise<NostrEvent> {
  return finalizeEvent(await minePow(template, getPublicKey(sk)), sk);
}

/**
 * Mines `template` for `pubkey` unless its kind is never published as an event.
 * A `nonce` tag already on it asks for at least its target (`["nonce", "", "18"]`),
 * for events whose work is the point, like a Discover boost.
 */
export function minePowFor<T extends EventTemplate>(template: T, pubkey: string): Promise<T> {
  if (POW_EXEMPT_KINDS.has(template.kind)) return Promise.resolve(template);
  const asked = parsePowDifficulty(template.tags.find(([name]) => name === "nonce")?.[2]) ?? 0;
  return minePow(template, pubkey, Math.max(powDifficulty(), asked));
}

/** An {@link NSecSigner} whose every signature carries proof of work. */
export class PowNSecSigner extends NSecSigner {
  override async signEvent(event: Omit<NostrEvent, "id" | "pubkey" | "sig">): Promise<NostrEvent> {
    return super.signEvent(await minePowFor(event, await this.getPublicKey()));
  }
}
