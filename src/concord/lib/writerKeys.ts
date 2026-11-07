/**
 * Posting in a restricted Channel as one of its writers (CORD-03 §1): the live
 * writer epoch's secret and this member's certificate, delivered on the Channel's
 * access plane at its writer scope, and the address and tags a post sends with.
 * Ported from Vector's `service/writing.rs` (`collect_writers`, `usable_writer`,
 * `send_group`, `as_writer`).
 */

import { noteRefused, refusedBefore } from "@/concord/lib/blobOnce";
import type { FoldedControl } from "@/concord/lib/control";
import { bytesToHex, certifierScope, channelWriterGroupKey, hex32, writerScope, type GroupKey } from "@/concord/lib/derive";
import type { ParsedDelivery } from "@/concord/lib/delivery";
import { kickedInto, type GuestbookHistory } from "@/concord/lib/guestbook";
import { base64ToBytes, decodeWrappedKey, myLocator } from "@/concord/lib/rekey";
import { channelPermissions, hasPermission, Permissions } from "@/concord/lib/roles";
import { certDigest, certifierOf, ledgerRestricted, ridesWriterAddress, stopped, verifyWriterCert, writerWindows, type Ledger } from "@/concord/lib/writers";
import { schnorr } from "@noble/curves/secp256k1.js";

import { KvPrefixCache } from "@/lib/db/kvCache";

/**
 * What this device holds for one writer epoch, all hex: its secret and this member's
 * certificate; as a minter the secret and certifier it minted, reused on a retry; as a
 * manager the certifier handed to it.
 */
interface HeldWriter {
  secret?: string;
  cert?: string;
  minted?: string;
  mintedCertifier?: string;
  certifier?: string;
}

const held = new KvPrefixCache<HeldWriter>({ prefix: "c2writer:" });

const heldId = (communityIdHex: string, channelIdHex: string, epoch: number) => `${communityIdHex}:${channelIdHex}:${epoch}`;

/** Since when this device could post in a Channel without its key, kept across restarts (Vector `postable_since`). */
const postable = new KvPrefixCache<number>({ prefix: "c2wpost:" });

/** Warm the store; reads before it lands miss. */
export function writerKeysReady(): Promise<void> {
  return held.ready();
}

/** Drop every writer and certifier secret this device holds in a Community, once it leaves it (CORD-03 §1). */
export async function forgetWriterKeys(communityIdHex: string): Promise<void> {
  await Promise.all([held.ready(), postable.ready()]);
  for (const cache of [held, postable] as KvPrefixCache<unknown>[]) {
    for (const id of cache.ids()) if (id.startsWith(`${communityIdHex}:`)) cache.delete(id);
  }
}

/** Since when this device could post in a Channel without holding its live key; cleared once it holds one. */
export function postableSince(communityIdHex: string, channelIdHex: string, keyless: boolean, nowMs: number): number {
  const id = `${communityIdHex}:${channelIdHex}`;
  if (!keyless) {
    if (postable.get(id) !== undefined) postable.delete(id);
    return Number.MAX_SAFE_INTEGER;
  }
  const at = postable.get(id);
  if (at !== undefined) return at;
  postable.set(id, nowMs);
  return nowMs;
}

export function subscribeWriterKeys(listener: () => void): () => void {
  return held.subscribe(listener);
}

/** The writer epoch taking posts now and its address, when the ledger restricts the Channel. */
export function currentWriter(l: Ledger | undefined): { epoch: number; pk: string; from: number } | undefined {
  if (!l || !ledgerRestricted(l)) return undefined;
  const live = writerWindows(l).find((w) => w.to === undefined);
  return live ? { epoch: live.epoch, pk: live.pk, from: live.from } : undefined;
}

/** The secret this device holds for writer `epoch`, when it derives to `pk`. */
function heldSecret(communityIdHex: string, channelIdHex: string, epoch: number, pk: string): Uint8Array | undefined {
  const h = held.get(heldId(communityIdHex, channelIdHex, epoch));
  for (const hex of [h?.secret, h?.minted]) {
    if (!hex || !/^[0-9a-f]{64}$/.test(hex)) continue;
    const secret = hex32(hex);
    if (channelWriterGroupKey(secret, hex32(channelIdHex), epoch).pk === pk) return secret;
  }
  return undefined;
}

/** The secret this device minted for writer `epoch`, minted now if it holds none (Vector `minted_scope`). */
export function mintedSecrets(communityIdHex: string, channelIdHex: string, epoch: number): { secret: Uint8Array; certifier: Uint8Array } {
  const id = heldId(communityIdHex, channelIdHex, epoch);
  const prior = held.get(id) ?? {};
  const secret = prior.minted ?? bytesToHex(randomSecret());
  const certifier = prior.mintedCertifier ?? bytesToHex(randomSecret());
  if (prior.minted !== secret || prior.mintedCertifier !== certifier) held.set(id, { ...prior, minted: secret, mintedCertifier: certifier });
  return { secret: hex32(secret), certifier: hex32(certifier) };
}

/** Record this device's own writer secret and certificate for `epoch`, as a minter that is among its writers. */
export function storeOwnWriter(communityIdHex: string, channelIdHex: string, epoch: number, secret: Uint8Array, cert?: string): void {
  const id = heldId(communityIdHex, channelIdHex, epoch);
  held.set(id, { ...(held.get(id) ?? {}), secret: bytesToHex(secret), ...(cert ? { cert } : {}) });
}

/** The certifier secret held for writer `epoch`, minted or handed over, when it is the one the ledger names (Vector `certifier_held`). */
export function heldCertifier(communityIdHex: string, ledger: Ledger, epoch: number): Uint8Array | undefined {
  const named = certifierOf(ledger, epoch);
  const h = held.get(heldId(communityIdHex, ledger.channel, epoch));
  for (const hex of [h?.certifier, h?.mintedCertifier]) {
    if (!hex || !named) continue;
    if (bytesToHex(schnorr.getPublicKey(hex32(hex))) === named) return hex32(hex);
  }
  return undefined;
}

/** The live writer secret this device holds, given or minted, when it derives to the ledger's address (Vector `live_writer`). */
export function heldLiveSecret(communityIdHex: string, ledger: Ledger | undefined): { epoch: number; secret: Uint8Array; pk: string } | undefined {
  const live = currentWriter(ledger);
  if (!ledger || !live) return undefined;
  const h = held.get(heldId(communityIdHex, ledger.channel, live.epoch));
  for (const hex of [h?.secret, h?.minted]) {
    if (!hex) continue;
    if (channelWriterGroupKey(hex32(hex), hex32(ledger.channel), live.epoch).pk === live.pk) return { epoch: live.epoch, secret: hex32(hex), pk: live.pk };
  }
  return undefined;
}

function randomSecret(): Uint8Array {
  return schnorr.utils.randomSecretKey();
}

/** This member's certificate for writer `epoch`, when the ledger's certifier signed it. */
function heldCert(communityId: Uint8Array, ledger: Ledger, epoch: number, me: string): string | undefined {
  const certifier = certifierOf(ledger, epoch);
  const cert = held.get(heldId(bytesToHex(communityId), ledger.channel, epoch))?.cert;
  if (!certifier || !cert) return undefined;
  return verifyCert(communityId, ledger, epoch, me, cert) ? cert : undefined;
}

function verifyCert(communityId: Uint8Array, ledger: Ledger, epoch: number, writer: string, cert: string): boolean {
  const certifier = certifierOf(ledger, epoch);
  return certifier !== undefined && verifyWriterCert(certifier, certDigest(communityId, hex32(ledger.channel), epoch, hex32(writer)), cert);
}

/** Whether `me` holds SEND_MESSAGES in the Channel, or manages it (Vector `may_write`, `manages`). */
function mayWrite(control: FoldedControl, channelIdHex: string, me: string): boolean {
  const isPrivate = control.channels.get(channelIdHex)?.isPrivate ?? false;
  return (channelPermissions(control.roster, control.ownerHex, me, channelIdHex, isPrivate) & Permissions.SEND_MESSAGES) !== 0n;
}

function manages(control: FoldedControl, me: string): boolean {
  return me === control.ownerHex || (!control.banned.has(me) && hasPermission(control.roster, me, Permissions.MANAGE_CHANNELS));
}

/** What a writer posts with: the epoch it commits, its certificate, and the key signing its wraps. */
export interface UsableWriter {
  epoch: number;
  cert?: string;
  /** The epoch's writer secret; `sk` and `pk` are the address it derives. */
  secret: Uint8Array;
  sk: Uint8Array;
  pk: string;
}

/**
 * The live writer key this member may post with (Vector `usable_writer`): the Roster
 * lets them send, the secret is held, the certificate too where the epoch names a
 * certifier, they weren't stopped, and, unless they manage, weren't kicked while it held.
 */
export function usableWriter(
  control: FoldedControl | undefined,
  communityId: Uint8Array,
  channelIdHex: string,
  me: string,
  history?: GuestbookHistory,
): UsableWriter | undefined {
  const ledger = control?.writers?.get(channelIdHex);
  const live = currentWriter(ledger);
  if (!control || !ledger || !live || !mayWrite(control, channelIdHex, me)) return undefined;
  const secret = heldSecret(bytesToHex(communityId), channelIdHex, live.epoch, live.pk);
  if (!secret) return undefined;
  const cert = heldCert(communityId, ledger, live.epoch, me);
  if (certifierOf(ledger, live.epoch) && !cert) return undefined;
  if (stopped(ledger, live.epoch, me, Number.MAX_SAFE_INTEGER)) return undefined;
  if (!manages(control, me) && history !== undefined && kickedInto(history, me, live.from)) return undefined;
  const address = channelWriterGroupKey(secret, hex32(channelIdHex), live.epoch);
  return { epoch: live.epoch, ...(cert ? { cert } : {}), secret, sk: address.sk, pk: address.pk };
}

/** Whether the Channel resolves Send Messages for this member; a legacy Roster holds no such bit (Vector `send_chat_message_at`). */
export function sendsIn(control: FoldedControl | undefined, channelIdHex: string, me: string): boolean {
  if (!control || control.roster.everyone === undefined) return true;
  const isPrivate = control.channels.get(channelIdHex)?.isPrivate ?? false;
  return (channelPermissions(control.roster, control.ownerHex, me, channelIdHex, isPrivate) & Permissions.SEND_MESSAGES) !== 0n;
}

/** Whether this member may post in the Channel now: Send Messages, and a restricted one takes only its writers (Vector `can_post`). */
export function canPostIn(control: FoldedControl | undefined, communityId: Uint8Array | undefined, channelIdHex: string | undefined, me: string | undefined, history?: GuestbookHistory): boolean {
  if (!control || !communityId || !channelIdHex || !me) return true;
  if (!sendsIn(control, channelIdHex, me)) return false;
  if (!ledgerRestricted(control.writers?.get(channelIdHex))) return true;
  return usableWriter(control, communityId, channelIdHex, me, history) !== undefined;
}

/**
 * Why the composer is locked in this Channel, if it is (Vector `channelAllowsSend`,
 * `channelAwaitsWriterKey`): no Send Messages here, or a writer of a restricted
 * Channel whose key hasn't arrived yet.
 */
export function postLock(control: FoldedControl | undefined, communityId: Uint8Array | undefined, channelIdHex: string | undefined, me: string | undefined, history?: GuestbookHistory): "cant-send" | "key-pending" | undefined {
  if (!control || !communityId || !channelIdHex || !me) return undefined;
  if (!sendsIn(control, channelIdHex, me)) return "cant-send";
  return canPostIn(control, communityId, channelIdHex, me, history) ? undefined : "key-pending";
}

/**
 * Where a send of `kind` lands (Vector `send_group`): the read group, or, in a
 * restricted Channel, the live writer key signing with the read key encrypting,
 * plus the tags committing its writer epoch and certificate. Undefined when the
 * Channel takes posts only from writers and this member can't post as one.
 */
export function sendTarget(
  read: GroupKey,
  kind: number,
  control: FoldedControl | undefined,
  communityId: Uint8Array,
  channelIdHex: string,
  me: string,
  history?: GuestbookHistory,
): { group: GroupKey; tags: string[][] } | undefined {
  if (!control || !ledgerRestricted(control.writers?.get(channelIdHex)) || !ridesWriterAddress(kind)) return { group: read, tags: [] };
  const w = usableWriter(control, communityId, channelIdHex, me, history);
  if (!w) return undefined;
  return { group: writerGroup(w, read), tags: writerTags(w.epoch, w.cert) };
}

/** The wrap key a writer at `w` sends with: its own signer, the read key's encryption. */
export function writerGroup(w: { sk: Uint8Array; pk: string }, read: GroupKey): GroupKey {
  return { sk: w.sk, pk: w.pk, get convKey() { return read.convKey; } };
}

/** The tags a post at a writer address carries (CORD-03 §1, Vector `with_writer`). */
export function writerTags(epoch: number, cert?: string): string[][] {
  return [["wepoch", String(epoch)], ...(cert ? [["wcert", cert]] : [])];
}

/** The writer key that signed at `wepoch` in a Channel, when held: for re-sending what was sent there (Vector `writer_keys_at`). */
export function writerKeyAt(communityIdHex: string, channelIdHex: string, ledger: Ledger | undefined, wepoch: number): { sk: Uint8Array; pk: string } | undefined {
  const window = ledger ? writerWindows(ledger).find((w) => w.epoch === wepoch) : undefined;
  if (!window) return undefined;
  const secret = heldSecret(communityIdHex, channelIdHex, wepoch, window.pk);
  return secret ? channelWriterGroupKey(secret, hex32(channelIdHex), wepoch) : undefined;
}

/** What this member still needs for a restricted Channel's live writer epoch, if anything. */
export function writerNeeds(
  control: FoldedControl,
  communityId: Uint8Array,
  channelIdHex: string,
  me: string,
): { epoch: number; pk: string; key: boolean; cert: boolean; certifier: boolean } | undefined {
  const ledger = control.writers?.get(channelIdHex);
  const live = currentWriter(ledger);
  if (!ledger || !live) return undefined;
  const writes = mayWrite(control, channelIdHex, me);
  const key = (writes || manages(control, me)) && !heldSecret(bytesToHex(communityId), channelIdHex, live.epoch, live.pk);
  const cert = writes && certifierOf(ledger, live.epoch) !== undefined && !heldCert(communityId, ledger, live.epoch, me);
  // A manager takes the epoch's certifier too, so any of them can let a writer in.
  const certifier = manages(control, me) && certifierOf(ledger, live.epoch) !== undefined && !heldCertifier(bytesToHex(communityId), ledger, live.epoch);
  return key || cert || certifier ? { epoch: live.epoch, pk: live.pk, key, cert, certifier } : undefined;
}

/**
 * Take what the writer deliveries on a Channel's access plane hand this member
 * (Vector `collect_writers`): only those naming the ledger's address for the live
 * epoch, a certificate only if the epoch's certifier signed it, whoever carried it,
 * and a secret only if it derives to that address. Returns whether anything was taken.
 */
export async function adoptWriterDeliveries(
  deliveries: readonly ParsedDelivery[],
  control: FoldedControl,
  communityId: Uint8Array,
  channelIdHex: string,
  me: string,
  decrypt: (deliverer: string, wrapped: string) => Promise<string>,
): Promise<boolean> {
  const need = writerNeeds(control, communityId, channelIdHex, me);
  const ledger = control.writers?.get(channelIdHex);
  if (!need || !ledger) return false;
  const scopeHex = bytesToHex(writerScope(hex32(channelIdHex)));
  const named = deliveries.filter((d) => d.form === "access" && d.scopeIdHex === scopeHex && d.newEpoch === BigInt(need.epoch) && d.writer === need.pk);
  const id = heldId(bytesToHex(communityId), channelIdHex, need.epoch);
  const prior = held.get(id) ?? {};
  let next: HeldWriter = prior;
  if (need.cert) {
    const cert = named.flatMap((d) => d.certs.filter(([w]) => w === me).map(([, c]) => c)).find((c) => verifyCert(communityId, ledger, need.epoch, me, c));
    if (cert) next = { ...next, cert };
  }
  if (need.key) {
    outer: for (const d of named) {
      const locator = myLocator(d.deliverer, me, scopeHex, BigInt(need.epoch));
      for (const blob of d.blobs.filter((b) => b.locator.toLowerCase() === locator)) {
        const purpose = `writer:${channelIdHex}:${need.epoch}:${need.pk}`;
        if (refusedBefore(purpose, d.deliverer, blob.wrapped)) continue;
        try {
          const secret = decodeWrappedKey(base64ToBytes(await decrypt(d.deliverer, blob.wrapped)), hex32(scopeHex), BigInt(need.epoch));
          if (channelWriterGroupKey(secret, hex32(channelIdHex), need.epoch).pk === need.pk) {
            next = { ...next, secret: bytesToHex(secret) };
            break outer;
          }
        } catch {
          // a junk blob never hides a later real one
        }
        noteRefused(purpose, d.deliverer, blob.wrapped);
      }
    }
  }
  if (need.certifier) {
    const named = certifierOf(ledger, need.epoch);
    const cscopeHex = bytesToHex(certifierScope(hex32(channelIdHex)));
    const offered = deliveries.filter((d) => d.form === "access" && d.scopeIdHex === cscopeHex && d.newEpoch === BigInt(need.epoch) && d.writer === named);
    outer: for (const d of offered) {
      const locator = myLocator(d.deliverer, me, cscopeHex, BigInt(need.epoch));
      for (const blob of d.blobs.filter((b) => b.locator.toLowerCase() === locator)) {
        const purpose = `certifier:${channelIdHex}:${need.epoch}:${named}`;
        if (refusedBefore(purpose, d.deliverer, blob.wrapped)) continue;
        try {
          const secret = decodeWrappedKey(base64ToBytes(await decrypt(d.deliverer, blob.wrapped)), hex32(cscopeHex), BigInt(need.epoch));
          if (bytesToHex(schnorr.getPublicKey(secret)) === named) {
            next = { ...next, certifier: bytesToHex(secret) };
            break outer;
          }
        } catch {
          // a junk blob never hides a later real one
        }
        noteRefused(purpose, d.deliverer, blob.wrapped);
      }
    }
  }
  if (next === prior) return false;
  held.set(id, next);
  return true;
}
