/**
 * Concord Private Streams — CORD-01.
 *
 * A stream event is a kind-1059 wrap that REVERSES NIP-59: fixed author (the
 * plane's derived stream key), ephemeral `p` tag, and the wrap is encrypted
 * under the stream's NIP-44 self-ECDH conversation key — never the p-tagged
 * key. Inside rides a seal signed by the author's REAL key, around an unsigned
 * rumor carrying the functional kind:
 *
 *   wrap(1059/21059, signed by stream key)
 *     └ seal(20013 encrypted | 20014 plaintext, signed by the author)
 *         └ rumor(unsigned, the functional kind)
 *
 * The encrypted seal (20013) NIP-44-encrypts the rumor again, so no layer can
 * be lifted out as a standalone public event; the plaintext seal (20014,
 * Control Plane only) carries the rumor's JSON string byte-verbatim so a
 * compaction can re-wrap the signed edition into a new epoch (CORD-02 §5).
 */

import { decrypt as nip44Decrypt, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { generateSecretKey, getEventHash, getPublicKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent, UnsignedEvent } from "nostr-tools/pure";

import type { GroupKey, StreamKeyView } from "@/concord/lib/derive";
import {
  KIND_SEAL_ENCRYPTED,
  KIND_SEAL_PLAINTEXT,
  KIND_WRAP,
  KIND_WRAP_EPHEMERAL,
} from "@/concord/lib/kinds";
import { finalizePowEvent } from "@/lib/pow";
import { verifyEventOnce } from "@/lib/verifyCache";
import type { NostrRumor } from "@/lib/nostrRumor";

export class StreamError extends Error {
  constructor(
    public code:
      | "decrypt"
      | "parse"
      | "bad-wrap-kind"
      | "bad-wrap-signature"
      | "bad-seal-kind"
      | "bad-seal-signature"
      | "author-mismatch"
      | "bad-rumor-id"
      | "bad-ms"
      | "binding-mismatch"
      | "oversize",
    message: string,
  ) {
    super(message);
    this.name = "StreamError";
  }
}

/** NIP-44 hard plaintext cap; enforced at every layer (CORD-02 Appendix B). */
export const NIP44_MAX_PLAINTEXT = 65_535;

const TAG_MS = "ms";

function encryptChecked(convKey: Uint8Array, plaintext: string): string {
  // Enforce the cap ourselves: lenient publishers mint events strict readers can't decrypt.
  if (new TextEncoder().encode(plaintext).length > NIP44_MAX_PLAINTEXT) {
    throw new StreamError("oversize", "plaintext exceeds the NIP-44 65,535-byte cap");
  }
  return nip44Encrypt(plaintext, convKey);
}

/**
 * Build an unsigned rumor. `ms` is epoch-ms: `created_at` = seconds, `ms` tag =
 * 0..999 remainder (CORD-02 §4). `ms: null` for rumors without sub-second
 * ordering (control editions).
 */
export function buildRumor(opts: {
  kind: number;
  content: string;
  tags?: string[][];
  pubkey: string;
  ms?: number | null;
  createdAtSecs?: number;
}): NostrRumor {
  const tags = [...(opts.tags ?? [])];
  let createdAt: number;
  if (opts.ms === null || opts.ms === undefined) {
    createdAt = opts.createdAtSecs ?? Math.floor(Date.now() / 1000);
  } else {
    // Fail closed on a negative/non-integer clock: the `ms` tag would be malformed (CORD-02 §5).
    if (!Number.isFinite(opts.ms) || opts.ms < 0) {
      throw new StreamError("bad-ms", `send time must be a non-negative epoch-ms, got ${opts.ms}`);
    }
    createdAt = Math.floor(opts.ms / 1000);
    tags.push([TAG_MS, (Math.floor(opts.ms) % 1000).toString()]);
  }
  const unsigned: UnsignedEvent = {
    kind: opts.kind,
    content: opts.content,
    tags,
    created_at: createdAt,
    pubkey: opts.pubkey,
  };
  return { ...unsigned, id: getEventHash(unsigned) };
}

/** The minimal signer surface stream sends need (matches @nostrify's NUser signer). */
export interface StreamSigner {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
}

/**
 * Seal a rumor with the author's REAL identity: 20013 NIP-44s it under the stream
 * conversation key; 20014 carries the JSON verbatim. One signer round-trip per send.
 */
export async function sealRumor(
  rumor: NostrRumor,
  sealKind: typeof KIND_SEAL_ENCRYPTED | typeof KIND_SEAL_PLAINTEXT,
  stream: StreamKeyView,
  signer: StreamSigner,
): Promise<NostrEvent> {
  const rumorJson = JSON.stringify(rumor);
  const content =
    sealKind === KIND_SEAL_ENCRYPTED ? encryptChecked(stream.convKey, rumorJson) : rumorJson;
  return signer.signEvent({
    kind: sealKind,
    content,
    tags: [],
    created_at: rumor.created_at,
  });
}

/**
 * Wrap a signed seal into the outer stream event: encrypted under the stream
 * conversation key, signed by the stream key, random ephemeral `p` (NIP-59
 * reversed); `created_at` NOT tweaked (CORD-01). `expiration` adds a NIP-40 tag to
 * the WRAP so relays purge it (CORD-08 §2), matching the rumor's own tag.
 */
export function wrapSeal(
  seal: NostrEvent,
  stream: GroupKey,
  opts?: { ephemeral?: boolean; ephemeralSk?: Uint8Array; expiration?: number },
): Promise<NostrEvent> {
  const ephemeralSk = opts?.ephemeralSk ?? generateSecretKey();
  const ephemeralPk = getPublicKey(ephemeralSk);
  const tags: string[][] = [["p", ephemeralPk]];
  if (opts?.expiration !== undefined) tags.push(["expiration", String(Math.floor(opts.expiration))]);
  return finalizePowEvent(
    {
      kind: opts?.ephemeral ? KIND_WRAP_EPHEMERAL : KIND_WRAP,
      content: encryptChecked(stream.convKey, JSON.stringify(seal)),
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    stream.sk,
  );
}

/**
 * A fully-opened, verified stream event. Envelope fields exist only while the wrap
 * is in hand (the store keeps just the rumor); use {@link OpenedWireEvent} where
 * they're required.
 */
export interface OpenedEvent {
  /** The rumor id — the message id / dedup / display key. */
  rumorId: string;
  /** Verified real author (the seal's signer; equals the rumor's pubkey). */
  author: string;
  kind: number;
  content: string;
  tags: string[][];
  /** Ordering timestamp (epoch ms): `created_at*1000 + ms`. */
  ms: number;
  createdAt: number;
  /** WIRE ONLY. The wrap's id (the relay-addressable carrier; the transport dedup key). */
  wrapId?: string;
  /** WIRE ONLY. The stream address (wrap author) this event was read from. */
  streamPk?: string;
  /** WIRE ONLY. Seal form (20013 / 20014), checked at ingest against {@link PLANE_RULES}. */
  sealKind?: number;
  /** WIRE ONLY. The verified seal — for re-wrapping plaintext seals (stored in KV; see `readStoredSeal`). */
  seal?: NostrEvent;
}

/** An {@link OpenedEvent} straight off a wrap, whose envelope is always present. */
export type OpenedWireEvent = OpenedEvent & {
  wrapId: string;
  streamPk: string;
  sealKind: number;
  seal: NostrEvent;
};

/**
 * How far ahead of the local clock a chat event may be dated before it's HELD
 * out of the timeline (`foldTimeline`) and not notified until time catches up.
 * A display grace, not ingest skew (`MAX_FUTURE_SKEW_SECS`); nothing is dropped.
 *
 * Mirrored by native notification services (`FUTURE_HOLD_MS` in
 * `NotificationRelayService.java`, `Concord.futureHoldSecs` in `Concord.swift`).
 */
export const FUTURE_HOLD_MS = 5_000;

/** A message dated further ahead than this isn't held, but met again as its date nears (CORD-03 §3). */
export const FUTURE_HORIZON_MS = 3_600_000;

/**
 * Reconstruct the ms timestamp. Missing tag = 0; out-of-range/non-integer throws
 * (CORD-02 §5), never clamps.
 */
export function resolveMs(createdAtSecs: number, tags: string[][]): number {
  const tag = tags.find((t) => t[0] === TAG_MS);
  if (!tag) return createdAtSecs * 1000;
  // Strict decimal only (no "0x1f", "1e2", " 5 ", "+5"): clients must agree on the
  // ordering basis (CORD-02 §4/§5).
  const raw = tag[1];
  if (raw === undefined || !/^(0|[1-9][0-9]{0,2})$/.test(raw)) {
    throw new StreamError("bad-ms", `malformed ms tag: ${raw}`);
  }
  const n = Number(raw);
  if (n > 999) {
    throw new StreamError("bad-ms", `malformed ms tag: ${raw}`);
  }
  return createdAtSecs * 1000 + n;
}

/**
 * A wrap decoded up to — but NOT through — its seal-signature check, so seal
 * verifies can be batched off-thread (see `chat.ts` `openChatBatch`).
 * {@link finish} is valid ONLY once `seal` has been verified.
 */
export interface WrapToSeal {
  /** The seal whose signature the caller MUST verify before {@link finish}. */
  seal: NostrEvent;
  /**
   * Recover the rumor, check author + id bindings, build the event. Throws
   * {@link StreamError} like `openWrap`.
   */
  finish(): OpenedWireEvent;
}

/**
 * Decode one stream wrap up to its seal, WITHOUT the seal-signature check:
 *   1. wrap author must be the stream address; the wrap's own signature is
 *      ephemeral and unchecked — EXCEPT on write-restricted streams;
 *   2. decrypt to the seal and check its kind;
 *   3. ({@link WrapToSeal.finish}) recover the rumor, verify its id is its NIP-01
 *      hash and its pubkey equals the seal signer (anti re-seal).
 */
export function openWrapToSeal(wrap: NostrRumor, stream: StreamKeyView): WrapToSeal {
  if (wrap.kind !== KIND_WRAP && wrap.kind !== KIND_WRAP_EPHEMERAL) {
    throw new StreamError("bad-wrap-kind", `not a stream wrap: kind ${wrap.kind}`);
  }
  if (wrap.pubkey !== stream.pk) {
    throw new StreamError("author-mismatch", "wrap author is not this stream's address");
  }
  // A WRITE-RESTRICTED stream's wrap signature is the write gate (CORD-01): it
  // proves a `control_root` holder published this. Verified synchronously (low volume).
  if (stream.restricted) {
    const signed = wrap as NostrRumor & { sig?: string };
    if (typeof signed.sig !== "string" || !verifyEventOnce(signed as NostrEvent)) {
      throw new StreamError("bad-wrap-signature", "write-restricted wrap signature invalid");
    }
  }

  let seal: NostrEvent;
  try {
    seal = JSON.parse(nip44Decrypt(wrap.content, stream.convKey)) as NostrEvent;
  } catch (e) {
    throw new StreamError("decrypt", `wrap decrypt: ${e instanceof Error ? e.message : e}`);
  }
  if (seal.kind !== KIND_SEAL_ENCRYPTED && seal.kind !== KIND_SEAL_PLAINTEXT) {
    throw new StreamError("bad-seal-kind", `unknown seal kind ${seal.kind}`);
  }

  return {
    seal,
    finish: () => {
      let rumor: NostrRumor;
      try {
        const json = seal.kind === KIND_SEAL_ENCRYPTED ? nip44Decrypt(seal.content, stream.convKey) : seal.content;
        rumor = JSON.parse(json) as NostrRumor;
      } catch (e) {
        throw new StreamError(
          seal.kind === KIND_SEAL_ENCRYPTED ? "decrypt" : "parse",
          `rumor recover: ${e instanceof Error ? e.message : e}`,
        );
      }

      if (rumor.pubkey !== seal.pubkey) {
        throw new StreamError("author-mismatch", "rumor author does not match the seal's signer");
      }
      const expectedId = getEventHash({
        kind: rumor.kind,
        content: rumor.content,
        tags: rumor.tags,
        created_at: rumor.created_at,
        pubkey: rumor.pubkey,
      });
      if (rumor.id !== expectedId) {
        throw new StreamError("bad-rumor-id", "rumor id is not its event hash");
      }

      return {
        rumorId: rumor.id,
        author: seal.pubkey,
        kind: rumor.kind,
        content: rumor.content,
        tags: rumor.tags,
        ms: resolveMs(rumor.created_at, rumor.tags),
        createdAt: rumor.created_at,
        wrapId: wrap.id,
        streamPk: wrap.pubkey,
        sealKind: seal.kind,
        seal,
      };
    },
  };
}

/**
 * Open and fully verify one stream wrap: {@link openWrapToSeal} plus the seal's
 * Schnorr check, in that order (so error codes stay stable).
 */
export function openWrap(wrap: NostrRumor, stream: StreamKeyView): OpenedWireEvent {
  const { seal, finish } = openWrapToSeal(wrap, stream);
  // Memoized by seal id (recomputed from this copy): the same wrap arrives from
  // every relay as a fresh object, defeating nostr-tools' per-object memo.
  if (!verifyEventOnce(seal)) {
    throw new StreamError("bad-seal-signature", "seal signature invalid");
  }
  return finish();
}

/**
 * Re-wrap an already-verified seal into another stream (a compaction, CORD-06).
 * Only meaningful for plaintext seals, whose signature survives the re-wrap;
 * the seal object's `content` string is carried forward verbatim.
 */
export function rewrapSeal(seal: NostrEvent, targetStream: GroupKey): Promise<NostrEvent> {
  if (seal.kind !== KIND_SEAL_PLAINTEXT) {
    throw new StreamError("bad-seal-kind", "only plaintext seals survive a re-wrap");
  }
  return wrapSeal(seal, targetStream);
}

// Chat-plane binding (CORD-03 §3)
const TAG_CHANNEL = "channel";
const TAG_EPOCH = "epoch";

/** The binding tags a Chat rumor MUST commit: `["channel", id]` + `["epoch", n]`. */
export function channelBindingTags(channelIdHex: string, epoch: bigint): string[][] {
  return [
    [TAG_CHANNEL, channelIdHex],
    [TAG_EPOCH, epoch.toString()],
  ];
}

/** Value of a tag required to appear AT MOST ONCE (binding must be unambiguous). */
function uniqueTag(tags: string[][], name: string): string | undefined {
  let found: string | undefined;
  for (const t of tags) {
    if (t[0] === name) {
      if (found !== undefined) {
        throw new StreamError("binding-mismatch", `duplicate binding tag: ${name}`);
      }
      found = t[1];
    }
  }
  return found;
}

/**
 * Enforce the Chat-plane binding: the rumor's committed channel + epoch must
 * strict-equal the coordinate whose key decrypted the wrap, or a keyholder
 * could splice one author's rumor into a context they never chose.
 */
export function checkChannelBinding(opened: OpenedEvent, channelIdHex: string, epoch: bigint): void {
  if (uniqueTag(opened.tags, TAG_CHANNEL) !== channelIdHex) {
    throw new StreamError("binding-mismatch", "channel-binding mismatch (splice)");
  }
  if (uniqueTag(opened.tags, TAG_EPOCH) !== epoch.toString()) {
    throw new StreamError("binding-mismatch", "epoch-binding mismatch (splice)");
  }
}
