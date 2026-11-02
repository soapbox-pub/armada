import { KIND_STREAM_MESSAGE_EDIT } from "@/buzz/kinds";
import { forgetChatRumor } from "@/concord/lib/chat";
import { KIND_EDIT } from "@/concord/lib/kinds";
import { scrubTimelineSnapshots } from "@/concord/hooks/timelineSnapshot";
import { forgetStoredSeals } from "@/concord/lib/rumorStore";
import { forgetTokenizedContent } from "@/components/chat/tokenCache";
import { forgetRenderedPlaintext } from "@/hooks/dmRenderCache";
import { getArmadaDB } from "@/lib/db/armadaDB";
import { literalSearch } from "@/lib/db/ParsedFilter";
import { forgetDecrypt, forgetDecryptsOfRumor } from "@/lib/decryptCache";
import { evictMessageMedia, mediaRefs, type KeptMessage } from "@/lib/evictMessageMedia";
import { scrubDm17ThreadSnapshots } from "@/lib/nip17/threadSnapshot";
import { addRemovedMessageId } from "@/lib/removedMessages";
import { scrubMessageFromQueries } from "@/lib/scrubQueryCache";

import type { ArmadaDB } from "@/lib/db/types";
import type { NostrRumor } from "@/lib/nostrRumor";
import type { QueryClient } from "@tanstack/react-query";

/** A community's tenant id prefix (`communityTenant`). */
const C2_TENANT = "c2:";

/** The message kinds the content index holds (`CONTENT_INDEXED_KINDS`), so a body search stays on it. */
const MESSAGE_KINDS = [9, 14, 15, 1068, 1111];

export interface RemovedMessage {
  id: string;
  pubkey: string;
  kind: number;
  tags: readonly string[][];
  content: string;
}

async function tenantIdsOf(db: ArmadaDB): Promise<string[]> {
  return "tenantIds" in db && typeof db.tenantIds === "function"
    ? await (db as { tenantIds(): Promise<string[]> }).tenantIds().catch(() => [])
    : [];
}

/**
 * Stored messages, anywhere on the device, that name any of `message`'s media:
 * a forward or a repost still shows it, so its copies stay. By `imeta` url (an
 * indexed tag) and by blob hash or URL in the body (content-index words).
 */
export async function otherUsersOfMedia(
  db: ArmadaDB,
  message: Pick<RemovedMessage, "id" | "tags" | "content">,
): Promise<KeptMessage[]> {
  const { urls, hashes } = mediaRefs(message.tags, message.content);
  if (urls.size === 0 && hashes.size === 0) return [];
  const imeta = [...urls].map((url) => `url ${url}`);
  const kept: KeptMessage[] = [];
  for (const tenant of await tenantIdsOf(db)) {
    const store = db.tenant(tenant);
    const reads = [
      imeta.length > 0 ? store.query([{ "#imeta": imeta, limit: 20 }]) : Promise.resolve([]),
      ...[...hashes].map((hash) => store.query([{ kinds: MESSAGE_KINDS, search: hash, limit: 5 }])),
      ...[...urls].map((url) => store.query([{ kinds: MESSAGE_KINDS, search: literalSearch(url), limit: 5 }])),
    ];
    for (const rows of await Promise.all(reads.map((read) => read.catch(() => [])))) {
      for (const row of rows) if (row.id !== message.id) kept.push(row);
    }
  }
  return kept;
}

/**
 * Remove a message from this device for good: every store refuses its id from
 * now on (`ArmadaDB.forget`), every decrypted copy goes, and so does its media
 * unless another stored message names it. Relays and media servers keep theirs.
 */
export async function removeMessageFromDevice(
  self: string,
  message: RemovedMessage,
  opts: { queryClient?: QueryClient } = {},
): Promise<void> {
  // Synchronously first: the timelines stop showing it before anything awaits.
  addRemovedMessageId(self, message.id);
  forgetChatRumor(message.id);
  forgetRenderedPlaintext(message.id);
  forgetTokenizedContent(message.id);
  if (opts.queryClient) scrubMessageFromQueries(opts.queryClient, message.id);

  const db = getArmadaDB();
  const tenants = await tenantIdsOf(db);
  // An edit is its own rumor holding the edited text, so it goes the same way.
  const edits = await editsOf(db, tenants, message);
  for (const edit of edits) {
    forgetChatRumor(edit.id);
    forgetRenderedPlaintext(edit.id);
    forgetTokenizedContent(edit.id);
    if (opts.queryClient) scrubMessageFromQueries(opts.queryClient, edit.id);
  }
  await db.forget([message.id, ...edits.map((edit) => edit.id)]);

  const communities = tenants.filter((id) => id.startsWith(C2_TENANT)).map((id) => id.slice(C2_TENANT.length));
  const counterparty = message.pubkey === self
    ? message.tags.find(([name]) => name === "p")?.[1]
    : message.pubkey;
  await Promise.all([
    scrubTimelineSnapshots(message.id),
    scrubDm17ThreadSnapshots(message.id),
    forgetStoredSeals(communities, message.id),
    ...edits.map((edit) => forgetStoredSeals(communities, edit.id)),
    forgetDecryptsOfRumor(self, message),
    // Kind 4's body is the ciphertext; its one decrypt is addressed by it.
    message.kind === 4 && counterparty
      ? forgetDecrypt(self, "nip04", counterparty, message.content)
      : Promise.resolve(),
  ]);

  for (const removed of [message, ...edits]) {
    evictMessageMedia(removed.tags, removed.content, await otherUsersOfMedia(db, removed));
  }
}

/** The author's own edits of `message` (Concord 3302, Buzz 40003), in every tenant. */
async function editsOf(db: ArmadaDB, tenants: string[], message: RemovedMessage): Promise<NostrRumor[]> {
  const reads = tenants.map((tenant) =>
    db.tenant(tenant)
      .query([{ kinds: [KIND_EDIT, KIND_STREAM_MESSAGE_EDIT], authors: [message.pubkey], "#e": [message.id], limit: 200 }])
      .catch(() => [] as NostrRumor[]));
  const byId = new Map<string, NostrRumor>();
  for (const rows of await Promise.all(reads)) for (const row of rows) byId.set(row.id, row);
  return [...byId.values()];
}
