/**
 * Last-known-good DM conversation list in its FINAL rendered form. The list
 * depends on four slow async sources, and partial views produce a wrong order
 * that visibly re-sorts; snapshotting the outcome paints the final order at
 * once. (Not `timelineSnapshot`, which stores raw events.)
 *
 * Trust: `preview` is decrypted text at rest (same trust as thread snapshots
 * and the decrypt cache); the `armada:` prefix gets it purged on logout.
 */

const PREFIX = "armada:dmlist:v1:";

/** Rows kept: more than a screenful. */
const MAX_ROWS = 100;

export interface DmListSnapshotRow {
  peer: string;
  /** Latest message id, distinguishing same-second messages. */
  eventId?: string;
  /** Latest message timestamp; the sort key. */
  createdAt: number;
  /** Latest message author; drives unread state. */
  author: string;
  preview?: string;
  /** Latest message's NIP-30 `emoji` tags only, so restored previews render custom emoji. */
  emojiTags?: string[][];
  /** NIP-40 deadline of a disappearing latest message; the preview is dropped past it on read. */
  expiresAt?: number;
  mine: boolean;
}

export function pickEmojiTags(tags: readonly string[][] | undefined): string[][] | undefined {
  const picked = (tags ?? []).filter((t) => t[0] === "emoji" && t[1] && t[2]);
  return picked.length > 0 ? picked : undefined;
}

function isRow(value: unknown): value is DmListSnapshotRow {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.peer === "string" &&
    (r.eventId === undefined || typeof r.eventId === "string") &&
    typeof r.createdAt === "number" &&
    typeof r.author === "string" &&
    typeof r.mine === "boolean" &&
    (r.expiresAt === undefined || typeof r.expiresAt === "number") &&
    (r.preview === undefined || typeof r.preview === "string") &&
    (r.emojiTags === undefined ||
      (Array.isArray(r.emojiTags) &&
        r.emojiTags.every((t) => Array.isArray(t) && t.every((s) => typeof s === "string"))))
  );
}

/** Drop the previews of a banned user's messages from every account's stored list. */
export function scrubDmListSnapshotsByAuthor(author: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
      if (!Array.isArray(parsed)) continue;
      let changed = false;
      const rows = parsed.map((row: unknown) => {
        if (!isRow(row) || row.author !== author || (row.preview === undefined && row.emojiTags === undefined)) return row;
        changed = true;
        return { ...row, preview: undefined, emojiTags: undefined };
      });
      if (changed) localStorage.setItem(key, JSON.stringify(rows));
    }
  } catch {
    // Purely a first-paint optimization.
  }
}

/** The stored list for an account (newest-first), or undefined. Synchronous. */
export function readDmListSnapshot(self: string | undefined): DmListSnapshotRow[] | undefined {
  if (!self || typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(PREFIX + self);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    // Expired previews drop their text/emoji; the row stays so it doesn't blink.
    const now = Math.floor(Date.now() / 1000);
    const rows = parsed
      .filter(isRow)
      .map((row) =>
        row.expiresAt !== undefined && row.expiresAt <= now
          ? { ...row, preview: undefined, emojiTags: undefined }
          : row,
      );
    return rows.length > 0 ? rows : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the list in render order, already filtered (muted/unfollowed peers
 * removed, or cold starts would paint them back).
 */
export function writeDmListSnapshot(self: string | undefined, rows: readonly DmListSnapshotRow[]): void {
  if (!self || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(PREFIX + self, JSON.stringify(rows.slice(0, MAX_ROWS)));
  } catch {
    // Purely a first-paint optimization.
  }
}
