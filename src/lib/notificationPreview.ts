/**
 * Notification presentation shared by every notifier (the service worker, the
 * in-app notifier, Electron); a TypeScript port of Android's `NotificationContent.java`.
 * Mirrors MessagingStyle: rooms are titled by the room with "sender: text"
 * bodies; DMs are titled by the sender. Pure and platform-free, so it can be
 * bundled into the service worker; callers pass names/images already resolved.
 */

// `nostr-tools/nip19` subpath, not the barrel: this is bundled into the service worker.
import { decode as nip19Decode } from "nostr-tools/nip19";

import { defineMessages, t } from "@/i18n/intl";
import { ALL_MEDIA_EXTS } from "@/lib/mediaUrls";
import { isWebxdcMime } from "@/lib/webxdcMime";

/** NIP-17 file message — its content is a URL, not prose. */
const KIND_DM_FILE = 15;

/** Longest body we show before eliding, matching `CONTENT_CAP` on Android. */
export const NOTIFICATION_CONTENT_CAP = 140;

/** The notification icon shown when nothing better resolved. */
export const NOTIFICATION_FALLBACK_ICON = "/favicon.png";

/**
 * Monochrome status-bar mark (`badge`); must be single-colour on transparency
 * (only alpha is used). Same file as Android's `drawable-xxxhdpi/ic_stat_armada.png`;
 * source: `android/icon-src/ic_stat_armada.svg`.
 */
export const NOTIFICATION_BADGE_ICON = "/badge-96.png";

/**
 * A media URL plus preceding whitespace (so stripping leaves no double space).
 * Group 1 captures the extension. Mirrors `IMETA_MEDIA_URL_REGEX` and Android's `MEDIA_URL`.
 */
const MEDIA_URL = new RegExp(`\\s*https?://\\S+\\.(${ALL_MEDIA_EXTS})(?:\\?\\S*)?`, "gi");

/**
 * A NIP-21 `nostr:npub…` / `nostr:nprofile…` mention starting a token, so one
 * inside a URL (`https://ditto.pub/npub1…`, `…/nostr:npub1…`, `?u=nostr:…`)
 * stays part of the link. Mirrored by Android's `NotificationContent.MENTION`
 * and iOS's `NotificationPreview.nextMention`.
 */
const MENTION = /(?<![^\s([{<"'])nostr:(npub1|nprofile1)[023456789acdefghjklmnpqrstuvwxyz]+/gi;

function mentionPubkey(token: string): string | undefined {
  try {
    const decoded = nip19Decode(token.replace(/^nostr:/i, "").toLowerCase());
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch { /* ignore */ }
  return undefined;
}

/**
 * Pubkeys named by NIP-27 mentions. Resolve them locally (never over the
 * network) and pass the map to {@link cleanContent}; unresolved ones keep the raw token.
 */
export function mentionPubkeys(content: string): string[] {
  const out = new Set<string>();
  for (const [token] of content.matchAll(MENTION)) {
    const pubkey = mentionPubkey(token);
    if (pubkey) out.add(pubkey);
  }
  return [...out];
}

/** Strip embeddable media URLs and resolve mentions to `@name` (unknown names keep the raw token). */
export function cleanContent(content: string, names?: Map<string, string>): string {
  if (!content) return "";
  return content
    .replace(MEDIA_URL, "")
    .replace(MENTION, (token) => {
      const pubkey = mentionPubkey(token);
      const name = pubkey && names?.get(pubkey);
      return name ? `@${name}` : token;
    })
    .trim();
}

/** What kind of media a message carries, for its "Sent …" line. */
export type MediaKind = "gif" | "image" | "video" | "voice" | "game";

/**
 * Media kind for attached media. The imeta MIME beats the URL extension:
 * encrypted blob URLs have none, and voice notes in .webm/.mp4 are only
 * distinguishable by `audio/*`.
 */
export function mediaKind(imetaMime: string | undefined, content: string): MediaKind | undefined {
  const byMime = kindForMime(imetaMime);
  if (byMime) return byMime;
  if (!content) return undefined;
  const match = new RegExp(MEDIA_URL.source, "i").exec(content);
  return match ? kindForExt(match[1].toLowerCase()) : undefined;
}

function kindForMime(mime: string | undefined): MediaKind | undefined {
  if (!mime) return undefined;
  const m = mime.toLowerCase();
  if (m === "image/gif") return "gif";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "voice";
  if (isWebxdcMime(m)) return "game";
  return undefined;
}

function kindForExt(ext: string): MediaKind | undefined {
  if (ext === "gif") return "gif";
  if (ext === "xdc") return "game";
  return kindForMime(mimeForMediaExt(ext));
}

/** Coarse MIME for a media extension — enough to pick a label. */
function mimeForMediaExt(ext: string): string | undefined {
  if (/^(jpg|jpeg|png|gif|webp|svg|avif)$/.test(ext)) return "image/";
  if (/^(mp4|webm|mov|qt|avi|mkv|flv)$/.test(ext)) return "video/";
  if (/^(mp3|mpga|wav|ogg|oga|flac|m4a|aac|opus|weba)$/.test(ext)) return "audio/";
  return undefined;
}

/**
 * MIME of the first NIP-92 `imeta`. Not via `imeta.ts`: this is bundled into the
 * service worker and only needs `m`.
 */
export function firstImetaMime(tags: string[][]): string | undefined {
  for (const tag of tags) {
    if (tag[0] !== "imeta") continue;
    for (let i = 1; i < tag.length; i++) {
      if (tag[i].startsWith("m ")) return tag[i].slice(2).trim() || undefined;
    }
  }
  return undefined;
}

/**
 * Thread reply (matching Android and iOS): a kind-1111 NIP-22 comment, an uppercase `E` root
 * tag (Concord), or a kind 9 with a marked `reply` `e` tag (NIP-29, `nip29Threads.ts`).
 */
export function isThreadReply(kind: number, tags: string[][]): boolean {
  if (kind === 1111) return true;
  if (kind === 9 && tags.some((tag) => tag[0] === "e" && tag[3] === "reply" && Boolean(tag[1]))) return true;
  return tags.some((tag) => tag[0] === "E" && typeof tag[1] === "string" && tag[1] !== "");
}

/** Elide to {@link NOTIFICATION_CONTENT_CAP}, matching `sw.js`'s truncate. */
export function truncate(text: string, max = NOTIFICATION_CONTENT_CAP): string {
  if (typeof text !== "string") return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Normalize a kind-7 reaction's content to the emoji a body can show. */
export function reactionEmoji(content: string | undefined): string {
  const raw = (content ?? "").trim();
  if (raw === "" || raw === "+") return "👍";
  if (raw === "-") return "👎";
  // A `:shortcode:` has no glyph here; show the bare word.
  const shortcode = /^:([^:\s]+):$/.exec(raw);
  return shortcode ? shortcode[1] : raw;
}

/** What a notification needs to know about one message. */
export interface NotificationMessage {
  plane: "nip29" | "dm" | "c2";
  /** NIP-29 9/1111/7, or the decrypted rumor kind (9/1111/7/14/15). */
  kind: number;
  content: string;
  authorName: string;
  authorAvatar?: string;
  /** "Community / #channel" (Concord) or group name (NIP-29). Unused for DMs. */
  roomTitle?: string;
  /** Room image (Concord icon, NIP-29 picture), already loadable. Falls back to the sender's avatar. */
  roomImage?: string;
  mention?: boolean;
  /** A reaction to one of the viewer's OWN messages. */
  reaction?: boolean;
  threadReply?: boolean;
  imetaMime?: string;
  mentionNames?: Map<string, string>;
}

/**
 * Every notification text, in every notifier. The `notification.` prefix is
 * the slice handed to the service worker, and Android's `strings.xml` and
 * iOS's `Strings.swift` carry the same messages.
 */
export const notificationMessages = defineMessages({
  reacted: { id: "notification.reacted", defaultMessage: "Reacted {emoji} to your message" },
  repliedInThreadWith: { id: "notification.repliedInThreadWith", defaultMessage: "Replied in thread: {text}" },
  repliedInThread: { id: "notification.repliedInThread", defaultMessage: "Replied in thread" },
  sentMedia: {
    id: "notification.sentMedia",
    defaultMessage: "{kind, select, gif {Sent a GIF} image {Sent an image} video {Sent a video} voice {Sent a voice message} game {Sent a game} other {Sent a file}}",
  },
  sentFile: { id: "notification.sentFile", defaultMessage: "Sent a file" },
  sentDirectMessage: { id: "notification.sentDirectMessage", defaultMessage: "Sent you a direct message" },
  sentMessage: { id: "notification.sentMessage", defaultMessage: "Sent a message" },
  mentionedYou: { id: "notification.mentionedYou", defaultMessage: "@you {text}" },
  attributed: { id: "notification.attributed", defaultMessage: "{name}: {text}" },
  chat: { id: "notification.chat", defaultMessage: "Chat" },
  anonymous: { id: "notification.anonymous", defaultMessage: "Anonymous" },
  appName: { id: "notification.appName", defaultMessage: "Armada" },
  messagesSynced: { id: "notification.messagesSynced", defaultMessage: "Messages synced" },
  newMessage: { id: "notification.newMessage", defaultMessage: "New message" },
  newDirectMessage: { id: "notification.newDirectMessage", defaultMessage: "New direct message" },
  newCommunityMessage: { id: "notification.newCommunityMessage", defaultMessage: "New message in a community" },
  newChannelMessage: { id: "notification.newChannelMessage", defaultMessage: "New message in a channel" },
  someoneMentionedYou: { id: "notification.someoneMentionedYou", defaultMessage: "Someone mentioned you" },
  messageRequests: { id: "notification.messageRequests", defaultMessage: "Message requests" },
  newMessageRequest: {
    id: "notification.newMessageRequest",
    defaultMessage: "{count, plural, one {You have a new message request} other {You have new message requests}}",
  },
  gitActivity: {
    id: "notification.gitActivity",
    defaultMessage: "{name} {action, select, issue {opened an issue} pr {opened a pull request} comment {commented on a ticket} other {changed a ticket status}} in {repository}",
  },
  gitActivityFallback: { id: "notification.gitActivityFallback", defaultMessage: "New activity in the destination channel" },
  roomTitle: { id: "notification.roomTitle", defaultMessage: "{community} / #{channel}" },
  channelTitle: { id: "notification.channelTitle", defaultMessage: "#{channel}" },
});

/** Body text for one message; thread replies get Signal-style "Replied in thread: …". */
export function messageLine(msg: NotificationMessage): string {
  if (msg.reaction) return t(notificationMessages.reacted, { emoji: reactionEmoji(msg.content) });

  const cleaned = truncate(cleanContent(msg.content, msg.mentionNames));
  let text: string;
  if (cleaned) {
    text = msg.threadReply ? t(notificationMessages.repliedInThreadWith, { text: cleaned }) : cleaned;
  } else {
    const kind = mediaKind(msg.imetaMime, msg.content);
    if (kind) text = t(notificationMessages.sentMedia, { kind });
    else if (msg.kind === KIND_DM_FILE) text = t(notificationMessages.sentFile);
    else if (msg.threadReply) text = t(notificationMessages.repliedInThread);
    else text = t(msg.plane === "dm" ? notificationMessages.sentDirectMessage : notificationMessages.sentMessage);
  }

  // Where the room is the title, flag the mention in the body.
  return msg.mention && msg.plane !== "dm" ? t(notificationMessages.mentionedYou, { text }) : text;
}

function attribute(name: string, text: string): string {
  return t(notificationMessages.attributed, { name, text });
}

/** A notification's presentation, ready to hand to the platform. */
export interface PresentedNotification {
  title: string;
  body: string;
  icon: string;
  badge: string;
}

/**
 * Title, body and icon for one message, MessagingStyle-shaped. `lines` are the
 * room's recent lines (this one last) so busy rooms read as a thread.
 */
export function presentNotification(
  msg: NotificationMessage,
  lines?: string[],
): PresentedNotification {
  const line = messageLine(msg);
  const isDm = msg.plane === "dm";

  // Room lines are attributed to their sender; DM lines aren't (the title is the sender).
  const attributed = isDm ? line : attribute(msg.authorName, line);
  const body = lines && lines.length > 0 ? lines.join("\n") : attributed;

  return {
    title: isDm ? msg.authorName : (msg.roomTitle || t(notificationMessages.chat)),
    body,
    icon: (isDm ? msg.authorAvatar : msg.roomImage || msg.authorAvatar)
      || NOTIFICATION_FALLBACK_ICON,
    badge: NOTIFICATION_BADGE_ICON,
  };
}

/** The line {@link presentNotification} would append for `msg`. */
export function attributedLine(msg: NotificationMessage): string {
  const line = messageLine(msg);
  return msg.plane === "dm" ? line : attribute(msg.authorName, line);
}
