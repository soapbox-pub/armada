/**
 * Purge a user the blocklist bans from this device: everything of theirs any
 * store holds, every decrypted copy, and their media. Their messages stay as
 * tombstones in place, so a conversation still reads in order; the stores
 * keep it that way as more of theirs arrives (`bannedUsers.ts`).
 *
 * The Android service, iOS extension and service worker write without asking
 * the blocklist, so the purge runs again each session for every banned user
 * the device has met, kept in KV.
 */
import { forgetChatRumor } from "@/concord/lib/chat";
import { scrubTimelineSnapshotsByAuthor } from "@/concord/hooks/timelineSnapshot";
import { forgetStoredSeals, purgeAuthorChat, TOMBSTONE_TAGS } from "@/concord/lib/rumorStore";
import { forgetTokenizedContent } from "@/components/chat/tokenCache";
import { forgetRenderedPlaintext } from "@/hooks/dmRenderCache";
import { authorQueryKey } from "@/lib/authorCache";
import { isUserBannedNow } from "@/lib/bannedUsers";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { forgetDecrypt, forgetDecryptsByAuthor } from "@/lib/decryptCache";
import { scrubDmListSnapshotsByAuthor } from "@/lib/dmListSnapshot";
import { evictMessageMedia } from "@/lib/evictMessageMedia";
import { DM_TOMBSTONE_TAGS, purgeAuthorDms } from "@/lib/nip17/dm17Store";
import { scrubDm17ThreadSnapshotsByAuthor } from "@/lib/nip17/threadSnapshot";
import { tenantIdsOf } from "@/lib/removeMessageFromDevice";
import { tombstoneAuthorInQueries } from "@/lib/scrubQueryCache";
import { dropTimelineSnapshotsByAuthor } from "@/lib/timelineSnapshot";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { QueryClient } from "@tanstack/react-query";

const C2_TENANT = "c2:";
const DM17_TENANT = "dm17:";
/** Tenants of wraps, under one-off keys: nothing in them is anyone's by pubkey. */
const WRAP_TENANTS = new Set(["c2park", "svc"]);

/** KV: the banned users this device has met, purged again each session. */
const MET_KEY = "blocklist:banned-users";

/** The tags a tombstone keeps in a cached query: a Concord row's, or a DM's. */
const QUERY_TOMBSTONE_TAGS: ReadonlySet<string> = new Set([...TOMBSTONE_TAGS, ...DM_TOMBSTONE_TAGS]);

/** The banned users this device has met before. */
export async function knownBannedUsers(): Promise<string[]> {
  const known = await getArmadaDB().kv.get<string[]>(MET_KEY).catch(() => undefined);
  return Array.isArray(known) ? known.filter((pk) => typeof pk === "string") : [];
}

async function rememberBannedUser(pubkey: string): Promise<void> {
  const known = await knownBannedUsers();
  if (known.includes(pubkey)) return;
  await getArmadaDB().kv.set(MET_KEY, [...known, pubkey]).catch(() => undefined);
}

/** Forget the users no longer banned. */
export async function pruneKnownBannedUsers(): Promise<void> {
  const known = await knownBannedUsers();
  const still = known.filter((pk) => isUserBannedNow(pk));
  if (still.length !== known.length) await getArmadaDB().kv.set(MET_KEY, still).catch(() => undefined);
}

/** The media a profile shows: its picture and banner, as URLs in a body. */
function profileMedia(row: NostrRumor): string {
  try {
    const metadata = JSON.parse(row.content) as { picture?: unknown; banner?: unknown };
    return [metadata.picture, metadata.banner].filter((url) => typeof url === "string").join(" ");
  } catch {
    return "";
  }
}

/**
 * Purge `pubkey`, banned, from this device. `self` is the signed-in account,
 * whose own kind-4 decrypts of their messages go too. Relays and media servers
 * keep theirs.
 */
export async function purgeBannedUser(
  self: string | undefined,
  pubkey: string,
  opts: { queryClient?: QueryClient } = {},
): Promise<void> {
  if (!isUserBannedNow(pubkey)) return;
  await rememberBannedUser(pubkey);

  // What's on screen goes first, before anything awaits the stores.
  if (opts.queryClient) {
    opts.queryClient.setQueryData(authorQueryKey(pubkey), {});
    tombstoneAuthorInQueries(opts.queryClient, pubkey, QUERY_TOMBSTONE_TAGS);
  }

  const db = getArmadaDB();
  const tenants = await tenantIdsOf(db);
  const purged: NostrRumor[] = [];
  const forgotten: NostrRumor[] = [];
  for (const tenant of tenants) {
    if (WRAP_TENANTS.has(tenant) || tenant.startsWith("svc:")) continue;
    try {
      if (tenant.startsWith(C2_TENANT)) {
        purged.push(...await purgeAuthorChat(tenant.slice(C2_TENANT.length), pubkey));
      } else if (tenant.startsWith(DM17_TENANT)) {
        purged.push(...await purgeAuthorDms(tenant.slice(DM17_TENANT.length), pubkey));
      } else {
        forgotten.push(...await db.tenant(tenant).query([{ authors: [pubkey] }]));
      }
    } catch {
      // One tenant mustn't keep the rest.
    }
  }
  // Not a message anyone reads in place: gone, and refused from every writer.
  if (forgotten.length > 0) await db.forget(forgotten.map((row) => row.id)).catch(() => undefined);

  const rows = [...purged, ...forgotten];
  for (const row of rows) {
    forgetChatRumor(row.id);
    forgetRenderedPlaintext(row.id);
    forgetTokenizedContent(row.id);
  }
  const communities = tenants.filter((id) => id.startsWith(C2_TENANT)).map((id) => id.slice(C2_TENANT.length));
  dropTimelineSnapshotsByAuthor(pubkey);
  scrubDmListSnapshotsByAuthor(pubkey);
  await Promise.all([
    scrubTimelineSnapshotsByAuthor(pubkey),
    scrubDm17ThreadSnapshotsByAuthor(pubkey),
    forgetDecryptsByAuthor(pubkey),
    ...purged.map((row) => forgetStoredSeals(communities, row.id)),
    // Kind 4's body is the ciphertext; its one decrypt is addressed by it.
    ...(self ? forgotten.filter((row) => row.kind === 4).map((row) => forgetDecrypt(self, "nip04", pubkey, row.content)) : []),
  ]).catch(() => undefined);

  // Their media goes wherever it's named, a forward of it included: it's theirs.
  for (const row of rows) {
    evictMessageMedia(row.tags, row.kind === 0 ? profileMedia(row) : row.content);
  }

  // A tombstone in place of what was showing.
  if (opts.queryClient) tombstoneAuthorInQueries(opts.queryClient, pubkey, QUERY_TOMBSTONE_TAGS);
}
