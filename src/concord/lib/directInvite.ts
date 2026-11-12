/**
 * Concord Direct Invites — CORD-05 §6. The §1 `CommunityInvite` bundle giftwraps
 * straight to a known npub as a STANDARD NIP-59 giftwrap (not CORD-01's reversed
 * stream wrap):
 *
 *   wrap(1059, ephemeral author, ["p", recipient], ["k", "3313"])
 *     └ seal(13, signed by the inviter)
 *         └ rumor(3313, content = the CommunityInvite bundle as JSON)
 *
 * The outer `k` tag makes invites INDEXED (`{"kinds":[1059], "#p":[me],
 * "#k":["3313"]}`); it's a hint, never authority. Unrevocable once landed, absent
 * from the Registry, never flips the Community Public.
 *
 * Uses only the abstract signer (`signEvent`, `nip44`), so extension and bunker
 * logins work (nostr-tools' nip59 helpers need a raw key).
 */

import { getConversationKey, encrypt as nip44Encrypt } from "nostr-tools/nip44";
import { generateSecretKey } from "nostr-tools/pure";
import type { EventTemplate, NostrEvent } from "nostr-tools/pure";

import { validateBundle, type InviteBundle } from "@/concord/lib/invite";
import { KIND_DIRECT_INVITE, KIND_WRAP } from "@/concord/lib/kinds";
import { t } from "@/i18n/intl";
import { finalizePowEvent } from "@/lib/pow";
import { nowSecs } from "@/lib/relayClock";
import { verifyEventOnce } from "@/lib/verifyCache";

/** The standard NIP-59 seal kind (classic giftwrap — not a CORD-01 seal). */
export const KIND_NIP59_SEAL = 13;

/** NIP-59: outer timestamps are tweaked into the past, up to two days. */
const MAX_BACKDATE_SECS = 2 * 24 * 60 * 60;

function tweakedPast(): number {
  return nowSecs() - Math.floor(Math.random() * MAX_BACKDATE_SECS);
}

/** The signer surface a Direct Invite send needs (every Concord-capable login). */
export interface DirectInviteSigner {
  signEvent(template: EventTemplate): Promise<NostrEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

/** The unsigned kind-3313 rumor: the bundle whole, claimed by the inviter. */
export interface DirectInviteRumor {
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  pubkey: string;
}

/** Build the kind-3313 rumor carrying the bundle as its content (CORD-05 §6). */
export function buildDirectInviteRumor(bundle: InviteBundle, inviterPubkey: string): DirectInviteRumor {
  return {
    kind: KIND_DIRECT_INVITE,
    content: JSON.stringify(bundle),
    tags: [],
    created_at: nowSecs(),
    pubkey: inviterPubkey,
  };
}

/**
 * Seal with the inviter's REAL identity (proves who invited), NIP-44 to the
 * recipient, timestamp backdated per NIP-59.
 */
export async function sealDirectInvite(
  rumor: DirectInviteRumor,
  recipientPubkey: string,
  signer: DirectInviteSigner,
): Promise<NostrEvent> {
  if (!signer.nip44) throw new Error(
      t({ id: "concordDirectInvite.noNip44", defaultMessage: "This signer can't send direct invites (NIP-44 unsupported)." }),
    );
  return signer.signEvent({
    kind: KIND_NIP59_SEAL,
    content: await signer.nip44.encrypt(recipientPubkey, JSON.stringify(rumor)),
    tags: [],
    created_at: tweakedPast(),
  });
}

/**
 * Wrap a signed seal under a single-use ephemeral key, with the outer `p` and
 * indexing `k` tags (plus NIP-40 expiration matching `expires_at`).
 */
export function wrapDirectInvite(
  seal: NostrEvent,
  recipientPubkey: string,
  opts?: { expiresAtMs?: number },
): Promise<NostrEvent> {
  const ephemeralSk = generateSecretKey();
  const convKey = getConversationKey(ephemeralSk, recipientPubkey);
  const tags: string[][] = [
    ["p", recipientPubkey],
    ["k", String(KIND_DIRECT_INVITE)],
  ];
  if (opts?.expiresAtMs) tags.push(["expiration", String(Math.floor(opts.expiresAtMs / 1000))]);
  return finalizePowEvent(
    {
      kind: KIND_WRAP,
      content: nip44Encrypt(JSON.stringify(seal), convKey),
      tags,
      created_at: tweakedPast(),
    },
    ephemeralSk,
  );
}

/** An unwrapped giftwrap: the inner rumor plus its seal-verified sender. */
export interface UnwrappedInvite {
  rumor: DirectInviteRumor;
  /** The seal's author — the verified inviter. */
  sender: string;
}

/**
 * Unwrap a kind-1059 giftwrap to the current user; undefined (never throws) if
 * malformed or unopenable. The rumor must claim the seal's author (NIP-59
 * anti-spoofing).
 */
export async function unwrapDirectInvite(
  giftWrap: NostrEvent,
  signer: Pick<DirectInviteSigner, "nip44">,
): Promise<UnwrappedInvite | undefined> {
  if (giftWrap.kind !== KIND_WRAP || !signer.nip44) return undefined;
  try {
    const seal = JSON.parse(await signer.nip44.decrypt(giftWrap.pubkey, giftWrap.content)) as NostrEvent;
    if (seal.kind !== KIND_NIP59_SEAL) return undefined;
    // The seal's signature is what makes `sender` the inviter (CORD-05 §6, NIP-59).
    if (!verifyEventOnce(seal)) return undefined;

    const rumor = JSON.parse(await signer.nip44.decrypt(seal.pubkey, seal.content)) as DirectInviteRumor;

    // Anti-spoofing: the rumor's claimed author must equal the seal's author.
    if (rumor.pubkey !== seal.pubkey) return undefined;

    return { rumor, sender: seal.pubkey };
  } catch {
    return undefined;
  }
}

/**
 * Parse + validate an unwrapped rumor as a bundle (the rumor kind is the
 * authority, not the `k` tag). Expiry is NOT enforced here: parked invites still
 * render; accepting refuses.
 */
export function parseDirectInviteRumor(kind: number, content: string): InviteBundle | undefined {
  if (kind !== KIND_DIRECT_INVITE) return undefined;
  try {
    const bundle = JSON.parse(content) as InviteBundle;
    if (typeof bundle.community_id !== "string" || typeof bundle.name !== "string") return undefined;
    return validateBundle(bundle);
  } catch {
    return undefined;
  }
}

/** Whether a bundle's shelf life has run out (`expires_at` is unix ms). */
export function directInviteExpired(bundle: InviteBundle, nowMs = Date.now()): boolean {
  return typeof bundle.expires_at === "number" && nowMs > bundle.expires_at;
}

/** What an already-joined member currently holds, for catch-up classification. */
export interface HeldMembership {
  rootEpoch: number;
  /** The base access key currently held (hex). A catch-up may never change it. */
  communityRoot: string;
  /** The Control Plane signer pubkey currently held (hex), when this epoch has one. */
  controlPk?: string;
  /** channel id (hex) → held channel epoch. */
  channelEpochs: ReadonlyMap<string, number>;
  /**
   * channel id (hex) → the channel epoch whose rotation cut me out. Keys BELOW it
   * are revoked access, so an old bundle can't quietly restore it.
   */
  channelCuts?: ReadonlyMap<string, number>;
}

/** Case-insensitive optional hex compare: foreign bundles may not be lowercase. */
function hexEq(a: string | undefined, b: string | undefined): boolean {
  return a?.toLowerCase() === b?.toLowerCase();
}

/**
 * Is a bundle for an already-joined community a CATCH-UP worth parking? Only a
 * bundle on the SAME base carrying a private-channel key the member lacks (or
 * holds at an older epoch) — a role-gate key vend (CORD.md).
 *
 * It may never move the base: nothing binds `community_root` to `community_id`
 * (CORD-02 §1/§2), so a hostile bundle with a real id/owner/salt could relocate
 * the member onto attacker-read streams via the List's `freshest` merge. The base
 * advances only by a CORD-06 §2 rekey blob whose `prevcommit` proves continuity.
 */
/**
 * A bundle channel whose "key" is the Community root: Vector lists every Public
 * Channel this way (`bundle_of`), and a Public Channel's key is just the root. It
 * is no Private key, so it is never held or vended.
 */
export function isRootKeyed(channel: { key: string }, bundle: { community_root: string }): boolean {
  return hexEq(channel.key, bundle.community_root);
}

export function isCatchUpBundle(
  held: HeldMembership | undefined,
  bundle: Pick<InviteBundle, "root_epoch" | "channels" | "community_root" | "control_pk">,
): boolean {
  return catchUpChannelIds(held, bundle).length > 0;
}

/**
 * The private-channel ids (lowercase hex) a bundle would NEWLY contribute —
 * non-empty exactly when {@link isCatchUpBundle}. Split out so adoption can judge
 * entitlement per channel.
 */
export function catchUpChannelIds(
  held: HeldMembership | undefined,
  bundle: Pick<InviteBundle, "root_epoch" | "channels" | "community_root" | "control_pk">,
): string[] {
  if (held === undefined) return [];
  // Same base, or not a catch-up. `control_pk` too: swapping it alone would
  // eclipse the member onto an attacker's Control Plane.
  if (!hexEq(bundle.community_root, held.communityRoot)) return [];
  if (!hexEq(bundle.control_pk, held.controlPk)) return [];
  if (bundle.root_epoch !== held.rootEpoch) return [];
  // Normalize id spelling before consulting the cut floor.
  const out: string[] = [];
  for (const c of bundle.channels) {
    if (isRootKeyed(c, bundle)) continue;
    const id = c.id.toLowerCase();
    const cut = held.channelCuts?.get(id);
    if (cut !== undefined && c.epoch < cut) continue; // revoked access, not a vend
    const heldEpoch = held.channelEpochs.get(id);
    if (heldEpoch === undefined || c.epoch > heldEpoch) out.push(id);
  }
  return out;
}

/**
 * What a Community List entry holds, in the classifier's shape. The single path
 * for this, so "what I hold" can't drift.
 */
export function heldMembershipOf(entry: {
  current: {
    root_epoch: number;
    community_root: string;
    control_pk?: string;
    channels?: Array<{ id: string; epoch: number }>;
  };
  channel_cuts?: Array<{ id: string; epoch: number }>;
}): HeldMembership {
  const channels = Array.isArray(entry.current.channels) ? entry.current.channels : [];
  return {
    rootEpoch: entry.current.root_epoch,
    communityRoot: entry.current.community_root,
    ...(entry.current.control_pk ? { controlPk: entry.current.control_pk } : {}),
    // Lowercase keys, matching catchUpChannelIds.
    channelEpochs: new Map(channels.map((c) => [c.id.toLowerCase(), c.epoch])),
    channelCuts: new Map((entry.channel_cuts ?? []).map((c) => [c.id.toLowerCase(), c.epoch])),
  };
}
