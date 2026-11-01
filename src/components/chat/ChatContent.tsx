import { Copy, Download, Expand, Share2 } from "lucide-react";
import { nip19 } from "nostr-tools";
import { Fragment, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { BlurhashCanvas } from "@/components/BlurhashCanvas";
import { AudioMessage } from "@/components/chat/AudioMessage";
import { CashuToken } from "@/components/chat/CashuToken";
import { CharacterCardEmbed } from "@/components/chat/CharacterCard";
import { rememberImageDim, seenImageDim } from "@/components/chat/imageDims";
import { emojify } from "@/components/chat/emojify";
import { EmbeddedNaddr, EmbeddedNote } from "@/components/chat/EmbeddedNote";
import { FileAttachment } from "@/components/chat/FileAttachment";
import { HeldMedia, HeldPreviews } from "@/components/chat/HeldMedia";
import { revealMessageMedia, useMediaHeld, useMediaUrlHold, useMessageRevealed } from "@/components/chat/mediaHold";
import { mediaHost } from "@/lib/mediaPolicy";
import { BuzzInviteEmbed } from "@/components/chat/BuzzInviteEmbed";
import { Nip29GroupInviteEmbed } from "@/components/chat/Nip29GroupInviteEmbed";
import { InviteEmbed } from "@/components/chat/InviteEmbed";
import { Lightbox } from "@/components/chat/Lightbox";
import { LinkEmbed } from "@/components/chat/LinkEmbed";
import { MediaFallback } from "@/components/chat/MediaFallback";
import { MediaSpoilerCover } from "@/components/chat/MediaSpoiler";
import { CodeBlock, InlineCode } from "@/components/chat/Markdown";
import { ChatRouteEmbed } from "@/components/chat/ChatRouteEmbed";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { renderInlineMarkdown, renderInlineNodes } from "@/components/chat/markdownRender";
import { VideoPlayer } from "@/components/chat/VideoPlayer";
import { XdcAttachment } from "@/components/chat/XdcAttachment";
import { DisplayName } from "@/components/DisplayName";
import { AppContext, defaultConfig } from "@/contexts/AppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useChannelNav } from "@/hooks/useChannelNav";
import { type MentionNameMap, useMentionNameMap } from "@/hooks/useMentionNameMap";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { CASHU_TOKEN_PATTERN, parseCashuToken } from "@/lib/cashu";
import { isCharacterCardCandidate, sniffCharacterCard } from "@/lib/characterCard";
import { buildEmojiMap } from "@/lib/customEmoji";
import { canCopyImages, writeClipboardImage, writeClipboardText } from "@/lib/clipboard";
import { dittoHashtagUrl, dittoNip19Url } from "@/lib/dittoUrl";
import { getDisplayName } from "@/lib/getDisplayName";
import { HASHTAG_PATTERN } from "@/lib/hashtag";
import { isBuzzInviteUrl } from "@/buzz/invite";
import { isInviteUrl } from "@/concord/lib/invite";
import { EVERYONE_MENTION_PATTERN } from "@/concord/lib/everyoneMention";
import { parseFileMessageTags, parseImetaMap } from "@/lib/imeta";
import { KIND_DM_FILE } from "@/lib/nip17/protocol";
import { parseInlineRun, splitInlineCode, splitMarkdownBlocks, splitMarkdownLinks } from "@/lib/markdown";
import { filenameFromUrl } from "@/lib/fileBytes";
import { AUDIO_EXTS, EMBED_MEDIA_URL_REGEX, IMAGE_URL_REGEX, isGifLikeUrl, isUnplayableVideo, mimeFromExt } from "@/lib/mediaUrls";
import { KIND_GROUP_METADATA, nip29GroupPath, parseGroupAddress, type GroupAddress } from "@/lib/nip29";
import { normalizeRelayUrl, relayToRouteParam } from "@/lib/platform";
import { isMagnetUri, sanitizeUrl } from "@/lib/sanitizeUrl";
import { parseSelfLink } from "@/lib/selfLink";
import { stripTrackingParams } from "@/lib/trackingParams";
import { WEBXDC_MIME, isWebxdcMime } from "@/lib/webxdcMime";
import { cn } from "@/lib/utils";
import { downloadUrl, savedDescription } from "@/lib/downloadFile";
import { canShareFiles, shareFile } from "@/lib/share";
import { bolt11AmountSats, formatSats } from "@/lib/zaps";
import { useLongPress } from "@/hooks/useLongPress";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { useRoutedCandidates } from "@/hooks/useBlossomCandidates";
import { isBuzzMediaUrl } from "@/buzz/media";
import { decryptAttachmentToObjectURL, peekPrimedAttachment } from "@/lib/encryptedMedia";
import { captureLoadedMedia } from "@/lib/mediaCache";
import { toast, useToast } from "@/hooks/useToast";
import { common, defineMessage, FormattedMessage, t, useIntl } from "@/i18n";
import { useWallet } from "@/hooks/useWallet";
import { useChatImageMenu } from "@/contexts/ChatImageMenuContext";

import type { AddrCoords } from "@/hooks/useEvent";
import type { CharaCard } from "@/lib/characterCard";
import type { ChatRoute } from "@/lib/routes";
import type { MessageActionItem } from "@/components/chat/messageActions";
import type { ImetaEncryption, ImetaEntry } from "@/lib/imeta";
import type { MdBlock } from "@/lib/markdown";
import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";
import type { ReactNode } from "react";
import type { NostrRumor } from "@/lib/nostrRumor";

interface ChatContentProps {
  event: NostrRumor;
  className?: string;
  /** Render nested nostr embeds as links, not cards (prevents recursion in embedded cards). */
  disableNoteEmbeds?: boolean;
  highlight?: string;
  /** Rendered instead of `event.content` (e.g. a /me body); tags still come from `event`. */
  contentOverride?: string;
  /** Mention chips without the `@` (for /me prose). */
  noMentionAtPrefix?: boolean;
  /** Clamp text-only content to this many lines; ignored with block media. */
  clampLines?: number;
  /** Also render headings 4–6 and `[text](url)` links (git issues/PRs/comments). */
  documentMarkdown?: boolean;
  /** Render authorized literal `@everyone` occurrences as mass-mention chips. */
  everyoneMention?: boolean;
}

const BECH32_CHARS = "023456789acdefghjklmnpqrstuvwxyz";

/**
 * A NIP-19 event/naddr as the TERMINAL path segment of a URL (njump-style).
 * `npub`/`nprofile` are excluded: a mention chip would discard the sender's
 * link. Terminal-only so mid-path ids (gitworkshop.dev/npub1…/…/nevent1…)
 * don't claim the whole link. Captured in group 1.
 */
const NOSTR_IN_URL_REGEX = new RegExp(
  `\\/((?:nevent1|naddr1|note1)[${BECH32_CHARS}]{10,})\\/?(?:[?#]|$)`,
  "i",
);

type NostrInUrl =
  | { kind: "event"; eventId: string; relays?: string[]; author?: string }
  | { kind: "addr"; addr: AddrCoords; relays?: string[] };

function splitAddr({ kind, pubkey, identifier, relays }: nip19.AddressPointer): { addr: AddrCoords; relays?: string[] } {
  return { addr: { kind, pubkey, identifier }, relays };
}

/** Decode a nostr entity from a URL path; the caller keeps the URL as a source back-link. */
function extractNostrFromUrl(url: string): NostrInUrl | null {
  const match = url.match(NOSTR_IN_URL_REGEX);
  if (!match) return null;
  try {
    const decoded = nip19.decode(match[1]);
    switch (decoded.type) {
      case "naddr":
        return { kind: "addr", ...splitAddr(decoded.data) };
      case "note":
        return { kind: "event", eventId: decoded.data as string };
      case "nevent":
        return {
          kind: "event",
          eventId: decoded.data.id,
          relays: decoded.data.relays,
          author: decoded.data.author,
        };
    }
  } catch {
    // invalid identifier — fall through to a plain link
  }
  return null;
}

/** A NIP-29 group reference as a join card, or an in-app link mid-sentence. */
function groupRouteToken(url: string, group: GroupAddress, card: boolean): ContentToken {
  return card
    ? { type: "group-invite-embed", url, group }
    : { type: "self-link", url, path: nip29GroupPath(group) };
}

/** `thumb`: the sender's smaller preview (imeta `thumb`), shown inline; the lightbox opens `url`. */
type ImageRef = EncryptedRef & { alt?: string; spoiler?: boolean; thumb?: string };

function imageRefOf(t: Extract<ContentToken, { type: "image-embed" }>): ImageRef {
  return { url: t.url, encryption: t.encryption, mime: t.mime, dim: t.dim, blurhash: t.blurhash, fallbacks: t.fallbacks, alt: t.alt, spoiler: t.spoiler, thumb: t.thumb };
}

/** An imeta preview worth loading instead of the image: a distinct, sane URL. */
function previewOf(url: string, thumbnail: string | undefined): string | undefined {
  const thumb = thumbnail ? sanitizeUrl(thumbnail) : undefined;
  return thumb && thumb !== url ? thumb : undefined;
}

type ContentToken =
  | { type: "text"; value: string }
  | { type: "image-embed"; url: string; encryption?: ImetaEncryption; mime?: string; dim?: string; blurhash?: string; fallbacks?: string[]; alt?: string; spoiler?: boolean; thumb?: string }
  | { type: "image-gallery"; urls: ImageRef[] }
  | { type: "media-embed"; url: string; encryption?: ImetaEncryption; mime?: string; fallbacks?: string[] }
  | { type: "file-embed"; url: string; encryption?: ImetaEncryption; mime?: string; name?: string; size?: number; thumbnail?: string; fallbacks?: string[] }
  | { type: "link-embed"; url: string }
  | { type: "invite-embed"; url: string }
  | { type: "buzz-invite-embed"; url: string }
  | { type: "group-invite-embed"; url: string; group: GroupAddress }
  | { type: "inline-link"; url: string }
  /** A BitTorrent `magnet:` URI, handed to the OS's torrent client on click. */
  | { type: "magnet-link"; url: string }
  /** An own-origin chat link alone on its line — the in-app preview card. */
  | { type: "self-chat-embed"; url: string; route: ChatRoute; path: string }
  /** An own-origin chat link mid-sentence — an internal router link. */
  | { type: "self-link"; url: string; path: string }
  | { type: "mention"; pubkey: string }
  | { type: "text-mention"; pubkey: string; raw: string }
  | { type: "everyone-mention"; raw: string }
  | { type: "nevent-embed"; eventId: string; relays?: string[]; author?: string; sourceUrl?: string }
  | { type: "naddr-embed"; addr: AddrCoords; relays?: string[]; url?: string }
  | { type: "nostr-link"; id: string; raw: string }
  | { type: "hashtag"; tag: string; raw: string }
  | { type: "relay-link"; url: string }
  | { type: "lightning-invoice"; invoice: string }
  | { type: "cashu-token"; raw: string }
  | { type: "code-block"; code: string; lang?: string }
  | { type: "inline-code"; code: string }
  | { type: "quote"; tokens: ContentToken[] }
  | { type: "md-link"; text: string; url: string }
  | { type: "heading"; level: number; tokens: ContentToken[] }
  | { type: "subtext"; tokens: ContentToken[] }
  | { type: "list"; ordered: boolean; start: number; items: ContentToken[][] }
  | { type: "rule" };

/**
 * Collapse whitespace around block tokens, in place. Not `link-embed`: it can
 * render inline, and stripping would glue the URL to adjacent text.
 */
function collapseAroundBlocks(tokens: ContentToken[]): ContentToken[] {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const isBlock = token.type === "image-embed" || token.type === "media-embed"
      || token.type === "file-embed"
      || token.type === "nevent-embed"
      || (token.type === "naddr-embed" && (!token.url || token.addr.kind === 30030))
      || token.type === "lightning-invoice"
      || token.type === "cashu-token"
      || token.type === "code-block" || token.type === "quote"
      || token.type === "invite-embed"
      || token.type === "buzz-invite-embed"
      || token.type === "group-invite-embed";
    if (!isBlock) continue;
    const prev = tokens[i - 1];
    if (prev?.type === "text") prev.value = prev.value.replace(/\s+$/, "");
    const next = tokens[i + 1];
    if (next?.type === "text") next.value = next.value.replace(/^\s+/, "");
  }
  return tokens;
}

/** Tokens inline formatting may span, so `**see https://…**` bolds the link too. */
function isSpannable(token: ContentToken): boolean {
  switch (token.type) {
    case "text":
    case "inline-code":
    case "mention":
    case "text-mention":
    case "everyone-mention":
    case "nostr-link":
    case "hashtag":
    case "relay-link":
    case "inline-link":
    case "magnet-link":
    case "self-link":
    case "md-link":
      return true;
    default:
      return false;
  }
}

/**
 * Split known `@name` aliases (Buzz/legacy mentions, pubkey in a `p` tag) out
 * of plain text. Only aliases in `mentions.byName` match.
 */
function splitTextToken(value: string, mentions: MentionNameMap): ContentToken[] {
  const { regex, byName } = mentions;
  if (!regex || !value) return value ? [{ type: "text", value }] : [];
  const out: ContentToken[] = [];
  let last = 0;
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    const pubkey = byName.get(match[1].toLowerCase());
    // Unreachable (the regex is built from the map); exec advances past it.
    if (!pubkey) continue;
    const at = match.index;
    if (at > last) out.push({ type: "text", value: value.slice(last, at) });
    out.push({ type: "text-mention", pubkey, raw: match[0] });
    last = at + match[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function applyTextMentions(tokens: ContentToken[], mentions: MentionNameMap): ContentToken[] {
  if (!mentions.regex) return tokens;
  const out: ContentToken[] = [];
  for (const token of tokens) {
    if (token.type === "text") {
      out.push(...splitTextToken(token.value, mentions));
    } else if (token.type === "quote") {
      out.push({ type: "quote", tokens: applyTextMentions(token.tokens, mentions) });
    } else {
      out.push(token);
    }
  }
  return out;
}

/** Split authorized literal `@everyone` tokens out of plain-text leaves. */
function splitEveryoneToken(value: string): ContentToken[] {
  if (!value) return [];
  const regex = new RegExp(EVERYONE_MENTION_PATTERN.source, "gu");
  const out: ContentToken[] = [];
  let last = 0;
  for (const match of value.matchAll(regex)) {
    const prefix = match[1] ?? "";
    const at = (match.index ?? 0) + prefix.length;
    if (at > last) out.push({ type: "text", value: value.slice(last, at) });
    out.push({ type: "everyone-mention", raw: "@everyone" });
    last = at + "@everyone".length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function applyEveryoneMentions(tokens: ContentToken[]): ContentToken[] {
  const out: ContentToken[] = [];
  for (const token of tokens) {
    if (token.type === "text") {
      out.push(...splitEveryoneToken(token.value));
    } else if (token.type === "quote") {
      out.push({ ...token, tokens: applyEveryoneMentions(token.tokens) });
    } else if (token.type === "heading" || token.type === "subtext") {
      out.push({ ...token, tokens: applyEveryoneMentions(token.tokens) });
    } else if (token.type === "list") {
      out.push({ ...token, items: token.items.map(applyEveryoneMentions) });
    } else {
      out.push(token);
    }
  }
  return out;
}

function highlightText(
  text: string,
  term: string | undefined,
  emojiMap: Map<string, string>,
  imgClassName?: string,
  authorPubkey?: string,
): ReactNode[] {
  // Inline emojis are clickable (open their source pack); the author is passed
  // so an unknown pack resolves over their relays.
  if (!term || !term.trim()) return emojify(text, emojiMap, imgClassName, true, authorPubkey);

  const needle = term.trim().toLowerCase();
  const out: ReactNode[] = [];
  const hay = text.toLowerCase();
  let from = 0;
  let key = 0;

  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) {
      out.push(...emojify(text.slice(from), emojiMap, imgClassName, true, authorPubkey));
      break;
    }
    if (idx > from) out.push(...emojify(text.slice(from, idx), emojiMap, imgClassName, true, authorPubkey));
    out.push(
      <mark key={`hl-${key++}`} className="bg-primary/30 text-foreground rounded-[2px]">
        {emojify(text.slice(idx, idx + needle.length), emojiMap, imgClassName, true, authorPubkey)}
      </mark>,
    );
    from = idx + needle.length;
  }

  return out;
}

/** One visual emoji unit (ZWJ sequences, skin tones, flags, keycaps, tag sequences). */
const EMOJI_UNIT = [
  "(?:" +
  "(?:\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F)" +
  "[\\u{1F3FB}-\\u{1F3FF}]?" +
  "(?:\\u200D(?:\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F)[\\u{1F3FB}-\\u{1F3FF}]?)+" +
  ")",
  "(?:[\\u{1F1E6}-\\u{1F1FF}]{2})",
  "(?:[0-9#*]\\uFE0F\\u20E3)",
  "(?:\\u{1F3F4}[\\u{E0020}-\\u{E007E}]+\\u{E007F})",
  "(?:(?:\\p{Emoji_Presentation}|\\p{Emoji}\\uFE0F)[\\u{1F3FB}-\\u{1F3FF}]?)",
].join("|");

const CUSTOM_EMOJI_SHORTCODE = ":([a-zA-Z0-9_-]+):";

/** Matches a string of only emoji (unicode and/or custom shortcodes), max 10. */
const EMOJI_OR_CUSTOM_ONLY_REGEX = new RegExp(
  `^\\s*(?:(?:${CUSTOM_EMOJI_SHORTCODE}|${EMOJI_UNIT})\\s*){1,10}$`,
  "u",
);

function isOnlyEmojisOrCustom(text: string, emojiMap: Map<string, string>): boolean {
  if (!EMOJI_OR_CUSTOM_ONLY_REGEX.test(text)) return false;
  const shortcodeMatches = text.matchAll(/:([a-zA-Z0-9_-]+):/g);
  for (const m of shortcodeMatches) {
    if (!emojiMap.has(m[1])) return false;
  }
  return true;
}

/** Counts emoji / custom-shortcode units in an emoji-only string. */
const EMOJI_OR_CUSTOM_UNIT_REGEX = new RegExp(`${CUSTOM_EMOJI_SHORTCODE}|${EMOJI_UNIT}`, "gu");
function countEmojiUnits(text: string): number {
  return [...text.matchAll(EMOJI_OR_CUSTOM_UNIT_REGEX)].length;
}

/**
 * Kinds whose imeta tags describe attached media. Includes NIP-17 rumors (14,
 * 15), whose encrypted attachments live only in `imeta`, and NIP-34 PRs/issues
 * (1618/1621).
 */
const MEDIA_IMETA_KINDS = new Set([1, 9, 11, 14, 15, 1111, 1222, 1244, 1618, 1621]);

/** Raw content length past which a message collapses behind "Read more" (~one screenful). */
const COLLAPSE_CHAR_THRESHOLD = 600;

const COLLAPSED_MAX_HEIGHT = 224;

const AUDIO_EXT_URL_REGEX = new RegExp(`\\.(${AUDIO_EXTS})(\\?[^\\s]*)?$`, "i");

/**
 * Treat `application/octet-stream` (and empty) as no MIME: Blossom reports it
 * for ciphertext, and it breaks `<source type>` and Firefox blob playback.
 */
function usableMime(m: string | undefined): string | undefined {
  if (!m || m.startsWith("application/octet-stream")) return undefined;
  return m;
}


/**
 * Tokenized bodies keyed by event id and dialect, surviving remounts (events
 * are immutable). Content is compared on lookup for synthesized events and
 * `contentOverride` edits.
 */
const TOKEN_CACHE = new Map<string, { content: string; tokens: ContentToken[] }>();

const TOKEN_CACHE_MAX = 800;

function cacheTokens(id: string, content: string, tokens: ContentToken[]): ContentToken[] {
  if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) {
    const oldest = TOKEN_CACHE.keys().next().value;
    if (oldest !== undefined) TOKEN_CACHE.delete(oldest);
  }
  TOKEN_CACHE.set(id, { content, tokens });
  return tokens;
}

/**
 * The body tokenizer's alternation: markdown image | BOLT11 | URL |
 * `nostr:` NIP-19 | bare/`@` NIP-19 | hashtag | Cashu | magnet. Compiled once; shared
 * `lastIndex` is reset by {@link tokenizeSegment} (synchronous, non-reentrant).
 */
const SEGMENT_RE = new RegExp(
  // Markdown image `![alt](url)` first, so its wrapper is consumed.
  "!\\[[^\\]]*\\]\\((https?:\\/\\/[^\\s)]+)\\)" +
  "|(?:lightning:)?(ln(?:bc|tb|bcrt|tbs)\\d*[munp]?1[023456789acdefghjklmnpqrstuvwxyz]+)" +
  // Scheme OR bare `domain.tld/path` (so a bech32 id inside a scheme-less link
  // can't split it into a mention); normalized to `https://` at use.
  // Repetitions are BOUNDED (DNS limits) to keep the scan linear: unbounded
  // is O(n²) on attacker-controlled content.
  // `<`, `>` and `|` are never literal in a URL (RFC 3986), so `<https://…>`
  // ends at the `>` and `||https://…||` at the spoiler's closing bars.
  "|((?:(?:https?|wss?):\\/\\/|(?:[\\w-]{1,63}\\.){1,10}[a-z]{2,24}\\/)[^\\s<>|]+)" +
  "|nostr:(npub1|note1|nprofile1|nevent1|naddr1)([023456789acdefghjklmnpqrstuvwxyz]+)" +
  "|@?(npub1|note1|nprofile1|nevent1|naddr1)([023456789acdefghjklmnpqrstuvwxyz]+)" +
  `|(${HASHTAG_PATTERN})` +
  // New alternatives go last so the group numbers above are untouched.
  `|(${CASHU_TOKEN_PATTERN})` +
  "|(magnet:\\?[^\\s<>|]+)",
  "giu",
);

function ChatContentInner({ event, className, disableNoteEmbeds = false, highlight, contentOverride, noMentionAtPrefix = false, clampLines, documentMarkdown = false, everyoneMention = false }: ChatContentProps) {
  // Canonicalize links on render too (the preview unfurler fetches before any
  // click). `useContext`, not `useAppContext`, so this renders without a provider.
  const cleanLinks =
    useContext(AppContext)?.config.stripTrackingParams ?? defaultConfig.stripTrackingParams;

  const rawTokens = useMemo(() => {
    const text = contentOverride ?? event.content;
    // The dialect is part of the cache identity.
    const cacheKey = `${documentMarkdown ? "doc" : "msg"}:${cleanLinks ? "c" : "r"}:${event.id}`;
    const cached = TOKEN_CACHE.get(cacheKey);
    if (cached && cached.content === text) return cached.tokens;

    // Imeta media declared out-of-band (Vector/0xChat/Concord: ciphertext URL
    // often ONLY in imeta): classifies extension-less URLs and emits embeds for
    // non-inline media.
    const isMediaImetaKind = MEDIA_IMETA_KINDS.has(event.kind);
    const imetaByUrl = isMediaImetaKind
      ? parseImetaMap(event.tags)
      : new Map<string, ImetaEntry>();
    // NIP-17 kind-15 has no imeta: URL is the content, metadata in top-level
    // tags. Synthesize an imeta entry.
    if (event.kind === KIND_DM_FILE && !imetaByUrl.has(text.trim())) {
      const fileEntry = parseFileMessageTags(text.trim(), event.tags);
      if (fileEntry) imetaByUrl.set(fileEntry.url, fileEntry);
    }
    const imetaMimeByUrl = new Map<string, string>();
    for (const [u, entry] of imetaByUrl) {
      const safe = sanitizeUrl(u);
      const mime = usableMime(entry.mime);
      if (safe && mime) imetaMimeByUrl.set(safe, mime);
    }

    // `m`, else URL extension, else `name` extension; octet-stream is skipped.
    const imageMimeFor = (entry: { mime?: string; url: string; name?: string }): string | undefined => {
      const explicit = usableMime(entry.mime);
      if (explicit) return explicit;
      const fromUrl = extOfUrl(entry.url);
      const urlMime = fromUrl ? usableMime(mimeFromExt(fromUrl)) : undefined;
      if (urlMime) return urlMime;
      const fromName = entry.name ? entry.name.split(".").pop()?.toLowerCase() : undefined;
      return fromName ? usableMime(mimeFromExt(fromName)) : undefined;
    };

    const cleanUrl = (url: string) => (cleanLinks ? stripTrackingParams(url) : url);

    // Invites already carded in place, and mid-sentence ones whose card goes after the text.
    const cardedInvites = new Set<string>();
    const trailingInvites: string[] = [];

    const tokenizeSegment = (segment: string): ContentToken[] => {
      const regex = SEGMENT_RE;
      regex.lastIndex = 0;

      const out: ContentToken[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(segment)) !== null) {
        let [fullMatch] = match;
        const mdImageUrl = match[1];
        const bolt11 = match[2];
        let url = mdImageUrl ?? match[3];
        const forceImage = Boolean(mdImageUrl);
        const hashtag = match[8];
        const cashu = match[9];
        const magnet = match[10];
        const { 4: nostrPrefix, 5: nostrData, 6: barePrefix, 7: bareData } = match;
        const index = match.index;

        if (index > lastIndex) {
          out.push({ type: "text", value: segment.substring(lastIndex, index) });
        }

        if (bolt11) {
          out.push({ type: "lightning-invoice", invoice: bolt11.toLowerCase() });
        } else if (magnet) {
          const trimmed = magnet.replace(/[.,;:!?)\]"']+$/, "");
          out.push(isMagnetUri(trimmed) ? { type: "magnet-link", url: trimmed } : { type: "text", value: trimmed });
          lastIndex = index + trimmed.length;
          continue;
        } else if (cashu) {
          // Only if it decodes; otherwise a `cashu`-lookalike renders verbatim.
          out.push(
            parseCashuToken(cashu)
              ? { type: "cashu-token", raw: cashu }
              : { type: "text", value: cashu },
          );
        } else if (url) {
          // Strip trailing punctuation (not for markdown images, delimited by `)`).
          const trailingPunctMatch = forceImage ? null : url.match(/^(.*?)([.,;:!?)\]]+)$/);
          if (trailingPunctMatch) {
            let [, urlWithoutPunct, trailingPunct] = trailingPunctMatch;
            // Keep a `)` that balances a `(` in the URL (`/wiki/Ditto_(Pokémon)`).
            while (trailingPunct.startsWith(")")) {
              const opens = (urlWithoutPunct.match(/\(/g) ?? []).length;
              const closes = (urlWithoutPunct.match(/\)/g) ?? []).length;
              if (opens <= closes) break;
              urlWithoutPunct += ")";
              trailingPunct = trailingPunct.slice(1);
            }
            if (trailingPunct && urlWithoutPunct && urlWithoutPunct.length > 10) {
              url = urlWithoutPunct;
              fullMatch = urlWithoutPunct;
            }
          }

          // Discord's `<url>`: a plain link with its embed suppressed, brackets hidden.
          const bracketed = !forceImage && index > lastIndex && segment[index - 1] === "<" &&
            segment[index + fullMatch.length] === ">";
          if (bracketed) {
            const prev = out[out.length - 1];
            if (prev?.type === "text") {
              prev.value = prev.value.slice(0, -1);
              if (!prev.value) out.pop();
            }
            fullMatch += ">";
          }

          // Scheme-less links get `https://`; `fullMatch` stays the source span.
          if (!/^(?:https?|wss?):\/\//i.test(url)) url = `https://${url}`;

          // Canonicalize before anything classifies or fetches. imeta URLs are matched
          // by exact string, so they're skipped.
          if (!imetaByUrl.has(url)) url = cleanUrl(url);

          if (/^wss?:\/\//i.test(url)) {
            const group = parseGroupAddress(url);
            const isEndOfLine = !bracketed && !/^[^\n]*\S/.test(segment.substring(index + fullMatch.length));
            out.push(group ? groupRouteToken(url, group, isEndOfLine) : { type: "relay-link", url });
            lastIndex = index + fullMatch.length;
            continue;
          }

          if (bracketed) {
            const selfTarget = isInviteUrl(url) ? null : parseSelfLink(url);
            out.push(
              selfTarget?.kind === "profile" ? { type: "mention", pubkey: selfTarget.pubkey }
                : selfTarget?.kind === "chat" ? { type: "self-link", url, path: selfTarget.path }
                : { type: "inline-link", url },
            );
            lastIndex = index + fullMatch.length;
            continue;
          }

          // Images by extension or imeta MIME (extension-less/encrypted Blossom URLs).
          const inlineImeta = imetaByUrl.get(url);
          const inlineImetaMime = inlineImeta ? imageMimeFor(inlineImeta) : undefined;
          const isImetaImage = inlineImetaMime?.startsWith("image/") ?? false;
          if (forceImage || IMAGE_URL_REGEX.test(url) || isImetaImage) {
            if (out.length > 0) {
              const prev = out[out.length - 1];
              if (prev.type === "text") {
                prev.value = prev.value.replace(/\s+$/, "");
              }
            }
            out.push({
              type: "image-embed",
              url,
              encryption: inlineImeta?.encryption,
              mime: inlineImetaMime,
              dim: inlineImeta?.dim,
              blurhash: inlineImeta?.blurhash,
              fallbacks: inlineImeta?.fallbacks,
              alt: inlineImeta?.alt,
              spoiler: inlineImeta?.spoiler,
              thumb: previewOf(url, inlineImeta?.thumbnail),
            });
            lastIndex = index + fullMatch.length;
            const leadingWs = segment.substring(lastIndex).match(/^\s+/);
            if (leadingWs) lastIndex += leadingWs[0].length;
            continue;
          }

          // Video/audio by extension or imeta MIME, carrying decryption params.
          const imetaMime = inlineImetaMime ?? imetaMimeByUrl.get(url);
          const isImetaMedia = imetaMime?.startsWith("audio/") || imetaMime?.startsWith("video/");
          // Armada's webxdc URLs end `.xdc`; Vector's are extension-less, known only by
          // imeta MIME or `webxdc` uuid.
          const isInlineWebxdc = isWebxdcMime(imetaMime) || Boolean(inlineImeta?.webxdc);
          if (EMBED_MEDIA_URL_REGEX.test(url) || isImetaMedia || isInlineWebxdc) {
            if (out.length > 0) {
              const prev = out[out.length - 1];
              if (prev.type === "text") {
                prev.value = prev.value.replace(/\s+$/, "");
              }
            }
            out.push({
              type: "media-embed",
              url,
              encryption: inlineImeta?.encryption,
              mime: isInlineWebxdc && !isWebxdcMime(imetaMime) ? WEBXDC_MIME : imetaMime,
              fallbacks: inlineImeta?.fallbacks,
            });
            lastIndex = index + fullMatch.length;
            const leadingWs = segment.substring(lastIndex).match(/^\s+/);
            if (leadingWs) lastIndex += leadingWs[0].length;
            continue;
          }

          // imeta but not image/audio/video: a download card. Plain pasted links stay link cards.
          if (inlineImeta && !inlineImeta.webxdc && !isWebxdcMime(imetaMime)) {
            if (out.length > 0) {
              const prev = out[out.length - 1];
              if (prev.type === "text") {
                prev.value = prev.value.replace(/\s+$/, "");
              }
            }
            out.push({
              type: "file-embed",
              url,
              encryption: inlineImeta.encryption,
              mime: imetaMime ?? inlineImeta.mime,
              name: inlineImeta.name,
              size: inlineImeta.size ? Number(inlineImeta.size) : undefined,
              thumbnail: inlineImeta.thumbnail,
              fallbacks: inlineImeta.fallbacks,
            });
            lastIndex = index + fullMatch.length;
            const leadingWs = segment.substring(lastIndex).match(/^\s+/);
            if (leadingWs) lastIndex += leadingWs[0].length;
            continue;
          }

          // Preview card only when nothing follows the URL on its line.
          const afterUrl = segment.substring(index + fullMatch.length);
          const nextNewline = afterUrl.indexOf("\n");
          const lineSuffix = nextNewline === -1 ? afterUrl : afterUrl.substring(0, nextNewline);
          const isEndOfLine = lineSuffix.trim() === "";

          const isInvite = isInviteUrl(url);
          // Links into this app route internally. Before the njump unfold, which would
          // claim `/dm/npub1…/m/<id>` by its npub. Invites have their own card.
          const selfTarget = isInvite ? null : parseSelfLink(url);
          // Event/naddr URLs unfold to a rich card with a source back-link. Not
          // invites (encrypted content).
          const nostrFromUrl = isInvite || selfTarget ? null : extractNostrFromUrl(url);
          if (selfTarget?.kind === "profile") {
            out.push({ type: "mention", pubkey: selfTarget.pubkey });
          } else if (selfTarget?.kind === "chat" && isEndOfLine) {
            out.push({ type: "self-chat-embed", url, route: selfTarget.route, path: selfTarget.path });
          } else if (selfTarget?.kind === "chat") {
            out.push({ type: "self-link", url, path: selfTarget.path });
          } else if (isEndOfLine && isInvite) {
            cardedInvites.add(url);
            out.push({ type: "invite-embed", url });
          } else if (isInvite) {
            // Never a generic naddr card: an invite's naddr points at encrypted content.
            out.push({ type: "inline-link", url });
            trailingInvites.push(url);
          } else if (isEndOfLine && isBuzzInviteUrl(url)) {
            // Buzz / NIP-29 invite (`/invite/<code>`); never collides with Concord's naddr.
            out.push({ type: "buzz-invite-embed", url });
          } else if (isBuzzInviteUrl(url)) {
            out.push({ type: "inline-link", url });
          } else if (nostrFromUrl?.kind === "addr") {
            out.push({ type: "naddr-embed", addr: nostrFromUrl.addr, relays: nostrFromUrl.relays, url });
          } else if (nostrFromUrl?.kind === "event") {
            out.push({
              type: "nevent-embed",
              eventId: nostrFromUrl.eventId,
              relays: nostrFromUrl.relays,
              author: nostrFromUrl.author,
              sourceUrl: url,
            });
          } else if (isEndOfLine) {
            out.push({ type: "link-embed", url });
          } else {
            out.push({ type: "inline-link", url });
          }
        } else if ((nostrPrefix && nostrData) || (barePrefix && bareData)) {
          const prefix = nostrPrefix || barePrefix;
          const data = nostrData || bareData;
          try {
            const nostrId = `${prefix}${data}`;
            const decoded = nip19.decode(nostrId);

            if (decoded.type === "npub") {
              out.push({ type: "mention", pubkey: decoded.data });
            } else if (decoded.type === "nprofile") {
              out.push({ type: "mention", pubkey: decoded.data.pubkey });
            } else if (decoded.type === "note") {
              out.push({ type: "nevent-embed", eventId: decoded.data as string });
            } else if (decoded.type === "nevent") {
              out.push({
                type: "nevent-embed",
                eventId: decoded.data.id,
                relays: decoded.data.relays,
                author: decoded.data.author,
              });
            } else if (decoded.type === "naddr") {
              const relay = decoded.data.kind === KIND_GROUP_METADATA
                ? normalizeRelayUrl(decoded.data.relays?.[0] ?? "")
                : undefined;
              if (relay) {
                // NIP-29's `?invite=` suffix sits outside the bech32 match.
                const suffix = segment.substring(index + fullMatch.length).match(/^\?invite=([^\s]*?)[.,;:!?)\]]*(?=\s|$)/);
                let inviteCode: string | undefined;
                if (suffix) {
                  try {
                    inviteCode = decodeURIComponent(suffix[1]) || undefined;
                  } catch {
                    inviteCode = suffix[1];
                  }
                  fullMatch += suffix[0].slice(0, "?invite=".length + suffix[1].length);
                  regex.lastIndex = index + fullMatch.length;
                }
                const group = { relay, groupId: decoded.data.identifier, inviteCode };
                out.push(groupRouteToken(fullMatch, group, true));
              } else {
                out.push({ type: "naddr-embed", ...splitAddr(decoded.data) });
              }
            } else {
              out.push({ type: "nostr-link", id: nostrId, raw: fullMatch });
            }
          } catch {
            out.push({ type: "text", value: fullMatch });
          }
        } else if (hashtag) {
          const tag = hashtag.slice(1);
          out.push({ type: "hashtag", tag, raw: hashtag });
        }

        lastIndex = index + fullMatch.length;
      }

      if (lastIndex < segment.length) {
        out.push({ type: "text", value: segment.substring(lastIndex) });
      }
      return out;
    };

    // Extract `inline code` first so code is never linkified. Document mode splits
    // `[text](url)` before URL tokenizing.
    const tokenizeRun = (run: string): ContentToken[] => {
      const out: ContentToken[] = [];
      for (const seg of splitInlineCode(run)) {
        if (seg.code) {
          out.push({ type: "inline-code", code: seg.value });
        } else if (documentMarkdown) {
          for (const part of splitMarkdownLinks(seg.value)) {
            if (part.type === "link") {
              out.push({ type: "md-link", text: part.text, url: cleanUrl(part.url) });
            } else {
              out.push(...tokenizeSegment(part.value));
            }
          }
        } else {
          out.push(...tokenizeSegment(seg.value));
        }
      }
      return out;
    };

    // Markdown block pass first; media inside quotes demotes to plain links.
    const blockTokens = (blocks: MdBlock[]): ContentToken[] => {
      const out: ContentToken[] = [];
      for (const block of blocks) {
        if (block.type === "code") {
          out.push({ type: "code-block", code: block.code, lang: block.lang });
        } else if (block.type === "quote") {
          out.push({ type: "quote", tokens: collapseAroundBlocks(blockTokens(block.blocks)) });
        } else if (block.type === "heading") {
          out.push({ type: "heading", level: block.level, tokens: tokenizeRun(block.text) });
        } else if (block.type === "subtext") {
          out.push({ type: "subtext", tokens: tokenizeRun(block.text) });
        } else if (block.type === "list") {
          out.push({ type: "list", ordered: block.ordered, start: block.start, items: block.items.map(tokenizeRun) });
        } else if (block.type === "rule") {
          out.push({ type: "rule" });
        } else {
          out.push(...tokenizeRun(block.text));
        }
      }
      return out;
    };
    const result = blockTokens(splitMarkdownBlocks(text, documentMarkdown));

    const qTagMap = new Map<string, { relay?: string; author?: string }>();
    for (const tag of event.tags) {
      if (tag[0] === "q" && tag[1]) {
        qTagMap.set(tag[1], { relay: tag[2] || undefined, author: tag[3] || undefined });
      }
    }
    if (qTagMap.size > 0) {
      for (const token of result) {
        if (token.type === "nevent-embed") {
          const qInfo = qTagMap.get(token.eventId);
          if (qInfo) {
            if ((!token.relays || token.relays.length === 0) && qInfo.relay) {
              token.relays = [qInfo.relay];
            }
            if (!token.author && qInfo.author) {
              token.author = qInfo.author;
            }
          }
        }
      }
    }

    // Embeds for imeta media not found inline (Concord/Vector attachments).
    if (isMediaImetaKind) {
      const renderedUrls = new Set(
        result.flatMap((t) =>
          t.type === "media-embed" || t.type === "image-embed" || t.type === "file-embed" ? [t.url] : [],
        ),
      );
      for (const [rawUrl, entry] of imetaByUrl) {
        const url = sanitizeUrl(rawUrl);
        if (!url || renderedUrls.has(url)) continue;
        const mime = imageMimeFor(entry);
        if (mime?.startsWith("image/")) {
          result.push({ type: "image-embed", url, encryption: entry.encryption, mime, dim: entry.dim, blurhash: entry.blurhash, fallbacks: entry.fallbacks, alt: entry.alt, spoiler: entry.spoiler, thumb: previewOf(url, entry.thumbnail) });
          renderedUrls.add(url);
        } else if (mime?.startsWith("audio/") || mime?.startsWith("video/")) {
          result.push({ type: "media-embed", url, encryption: entry.encryption, mime, fallbacks: entry.fallbacks });
          renderedUrls.add(url);
        } else if (isWebxdcMime(mime) || entry.webxdc) {
          // imeta-only webxdc (Vector): becomes an XdcAttachment card via isXdc; MIME
          // normalized for the uuid-only case.
          result.push({
            type: "media-embed",
            url,
            encryption: entry.encryption,
            mime: isWebxdcMime(mime) ? mime : WEBXDC_MIME,
            fallbacks: entry.fallbacks,
          });
          renderedUrls.add(url);
        } else {
          result.push({
            type: "file-embed",
            url,
            encryption: entry.encryption,
            mime: mime ?? entry.mime,
            name: entry.name,
            size: entry.size ? Number(entry.size) : undefined,
            thumbnail: entry.thumbnail,
            fallbacks: entry.fallbacks,
          });
          renderedUrls.add(url);
        }
      }
    }

    for (const url of trailingInvites) {
      if (cardedInvites.has(url)) continue;
      cardedInvites.add(url);
      result.push({ type: "invite-embed", url });
    }

    collapseAroundBlocks(result);

    if (result.length > 0) {
      const first = result[0];
      if (first.type === "text") {
        first.value = first.value.replace(/^\s+/, "");
      }
      const last = result[result.length - 1];
      if (last.type === "text") {
        last.value = last.value.replace(/\s+$/, "");
      }
    }

    return cacheTokens(
      cacheKey,
      text,
      result.filter((t) => !(t.type === "text" && t.value === "")),
    );
  }, [event, contentOverride, documentMarkdown, cleanLinks]);

  // `@name` mentions via `p` tags (Buzz/legacy); NIP-27 is handled by the tokenizer.
  const mentions = useMentionNameMap(event);
  const everyoneTokens = useMemo(
    () => everyoneMention ? applyEveryoneMentions(rawTokens) : rawTokens,
    [rawTokens, everyoneMention],
  );
  const tokens = useMemo(
    () => applyTextMentions(everyoneTokens, mentions),
    [everyoneTokens, mentions],
  );

  // Merge the viewer's emojis so shortcodes render when the event omits the tag.
  const { emojis: viewerEmojis } = useCustomEmojis();
  // `#channel` → local channel, else a Ditto hashtag link.
  const channelNav = useChannelNav();
  // Held media (mediaHold.ts) is never fetched: no sender emoji images, no previews,
  // until the reader loads this message's media.
  const mediaHeld = useMediaHeld(event.pubkey);
  const mediaLoaded = useMessageRevealed(event.id);
  const holdMedia = mediaHeld && !mediaLoaded;
  const loadMedia = useCallback(() => revealMessageMedia(event.id), [event.id]);
  // Per URL: the sender's hold, or a host the viewer doesn't know. Undefined = loads;
  // otherwise the host to name on the card (empty when the SENDER is why).
  const urlHold = useMediaUrlHold(event.pubkey, event.id);
  const heldReason = (url: string): string | undefined => {
    if (!urlHold(url)) return undefined;
    return mediaHeld ? "" : mediaHost(url) ?? url;
  };

  const emojiMap = useMemo(() => {
    const map = holdMedia ? new Map<string, string>() : buildEmojiMap(event.tags);
    for (const e of viewerEmojis) {
      if (!map.has(e.shortcode)) {
        map.set(e.shortcode, e.url);
      }
    }
    return map;
  }, [event.tags, viewerEmojis, holdMedia]);

  const imetaMap = useMemo(() => parseImetaMap(event.tags), [event.tags]);

  const groupedTokens = useMemo(() => {
    const result: ContentToken[] = [];
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token.type === "image-embed") {
        const run: ImageRef[] = [imageRefOf(token)];
        let j = i + 1;
        while (j < tokens.length && tokens[j].type === "image-embed") {
          const t = tokens[j] as Extract<ContentToken, { type: "image-embed" }>;
          run.push(imageRefOf(t));
          j++;
        }
        if (run.length >= 2) {
          result.push({ type: "image-gallery", urls: run });
        } else {
          result.push(token);
        }
        i = j;
      } else {
        result.push(token);
        i++;
      }
    }
    return result;
  }, [tokens]);

  const allImages = useMemo<ImageRef[]>(
    () =>
      groupedTokens.flatMap((t) => {
        if (t.type === "image-embed") return [imageRefOf(t)];
        if (t.type === "image-gallery") return t.urls;
        return [];
      }),
    [groupedTokens],
  );

  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const closeLightbox = useCallback(() => setLightboxIndex(null), []);
  const goNext = useCallback(
    () => setLightboxIndex((p) => (p !== null ? (p + 1) % allImages.length : null)),
    [allImages.length],
  );
  const goPrev = useCallback(
    () => setLightboxIndex((p) => (p !== null ? (p - 1 + allImages.length) % allImages.length : null)),
    [allImages.length],
  );

  const tokenImageIndex = useMemo(() => {
    const map = new Map<number, number>();
    let imgCount = 0;
    groupedTokens.forEach((t, i) => {
      if (t.type === "image-embed") {
        map.set(i, imgCount++);
      } else if (t.type === "image-gallery") {
        map.set(i, imgCount);
        imgCount += t.urls.length;
      }
    });
    return map;
  }, [groupedTokens]);

  // A held message whose only holdable content is previews/embeds has no HeldMedia
  // card to carry Load, so it gets a trailing one.
  const heldPreviewsOnly = useMemo(
    () =>
      !groupedTokens.some((t) => HELD_CARD_TOKENS.has(t.type))
      && groupedTokens.some((t) => HELD_PREVIEW_TOKENS.has(t.type)),
    [groupedTokens],
  );

  const isEmojiOnly = groupedTokens.length === 1
    && groupedTokens[0].type === "text"
    && isOnlyEmojisOrCustom(groupedTokens[0].value, emojiMap);
  const isSingleEmoji = isEmojiOnly
    && groupedTokens[0].type === "text"
    && countEmojiUnits(groupedTokens[0].value) === 1;

  // A line clamp breaks block media, so only for inline-only content.
  const clampSafe = clampLines != null && !isEmojiOnly && groupedTokens.every((t) =>
    t.type === "text" || t.type === "inline-code" || t.type === "quote"
    || t.type === "text-mention" || t.type === "everyone-mention"
    || t.type === "nevent-embed" || t.type === "naddr-embed"
  );
  const clampClass = clampSafe
    ? clampLines === 1 ? "line-clamp-1"
    : clampLines === 2 ? "line-clamp-2"
    : clampLines === 3 ? "line-clamp-3"
    : clampLines === 4 ? "line-clamp-4"
    : clampLines === 5 ? "line-clamp-5"
    : "line-clamp-6"
    : undefined;

  // Also the demoted rendering for media/embeds inside quotes.
  const inlineLink = (key: React.Key, url: string) => {
    const safe = sanitizeUrl(url);
    if (!safe) return <span key={key}>{url}</span>;
    return (
      <a
        key={key}
        href={safe}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>
    );
  };

  /** In-app link via the router, labeled with the shortened path (ids are opaque). */
  const selfLink = (key: React.Key, url: string, path: string) => (
    <Link
      key={key}
      to={path}
      title={url}
      data-copy-url={url}
      className="text-primary hover:underline break-all"
      onClick={(e) => e.stopPropagation()}
    >
      {selfLinkLabel(path)}
    </Link>
  );

  const emojiImgClass = isEmojiOnly
    ? cn("inline object-contain align-text-bottom", isSingleEmoji ? "h-12 w-12" : "h-10 w-10")
    : undefined;
  const renderLeaf = (leaf: string) => highlightText(leaf, highlight, emojiMap, emojiImgClass, event.pubkey);

  /**
   * Render a token list. Runs of spannable tokens are parsed for inline
   * markdown as one, with the non-text tokens as atoms. `top` keys lightbox
   * indexing by position (only the top-level list has one).
   */
  const renderTokens = (tokens: ContentToken[], keyPrefix: string, top: boolean, inQuote = false): ReactNode[] => {
    const out: ReactNode[] = [];
    let i = 0;
    while (i < tokens.length) {
      let j = i;
      while (j < tokens.length && isSpannable(tokens[j])) j++;
      if (j === i) {
        out.push(renderToken(tokens[i], `${keyPrefix}${i}`, top ? i : null, inQuote));
        i++;
      } else if (j === i + 1 && tokens[i].type === "text") {
        out.push(renderToken(tokens[i], `${keyPrefix}${i}`, null, inQuote));
        i = j;
      } else {
        const parts = tokens.slice(i, j).map((t) => (t.type === "text" ? t.value : { atom: t }));
        out.push(
          <Fragment key={`${keyPrefix}${i}`}>
            {renderInlineNodes(
              parseInlineRun(parts),
              renderLeaf,
              `${keyPrefix}${i}-`,
              (atom: ContentToken, key) => renderToken(atom, key, null, inQuote),
            )}
          </Fragment>,
        );
        i = j;
      }
    }
    return out;
  };

  /** `topIndex` drives lightbox indexing (null in quotes, where block tokens demote to links). */
  const renderToken = (token: ContentToken, key: React.Key, topIndex: number | null, inQuote = false): ReactNode => {
    switch (token.type) {
      case "text":
        return (
          <span key={key}>
            {renderInlineMarkdown(token.value, renderLeaf, `${key}-`)}
          </span>
        );
      case "everyone-mention":
        return (
          <span
            key={key}
            className="inline-flex rounded bg-primary/15 px-1 font-medium text-primary"
          >
            {token.raw}
          </span>
        );
      case "code-block":
        return <CodeBlock key={key} code={token.code} lang={token.lang} />;
      case "inline-code":
        return <InlineCode key={key} code={token.code} />;
      case "quote":
        return (
          <blockquote
            key={key}
            className="my-0.5 border-l-[3px] border-border/80 pl-2.5 text-foreground/90"
          >
            {renderTokens(token.tokens, `${key}-q`, false, true)}
          </blockquote>
        );
      case "md-link": {
        const safe = sanitizeUrl(token.url);
        if (!safe) return <span key={key}>{token.text}</span>;
        // Anti-spoof: [github.com/x](https://evil.example) shows the real host.
        const spoofedHost = mdLinkSpoofHost(token.text, safe);
        return (
          <a
            key={key}
            href={safe}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline break-words"
            onClick={(e) => e.stopPropagation()}
          >
            {token.text}
            {spoofedHost && <span className="text-muted-foreground"> ({spoofedHost})</span>}
          </a>
        );
      }
      case "heading":
        return (
          <div
            key={key}
            role="heading"
            aria-level={token.level}
            className={cn(
              "mb-1 mt-3 font-bold leading-snug first:mt-0",
              token.level === 1 ? "text-lg" : token.level === 2 ? "text-base" : "text-sm",
            )}
          >
            {renderTokens(token.tokens, `${key}-h`, false, true)}
          </div>
        );
      case "subtext":
        return (
          <div key={key} className="text-xs leading-snug text-muted-foreground">
            {renderTokens(token.tokens, `${key}-st`, false, true)}
          </div>
        );
      case "list": {
        const items = token.items.map((item, j) => (
          <li key={`${key}-li${j}`}>{renderTokens(item, `${key}-li${j}-`, false, true)}</li>
        ));
        // whitespace-normal: pre-wrap would render markup line breaks between <li>s.
        return token.ordered
          ? <ol key={key} start={token.start} className="my-1 list-decimal space-y-0.5 whitespace-normal pl-5">{items}</ol>
          : <ul key={key} className="my-1 list-disc space-y-0.5 whitespace-normal pl-5">{items}</ul>;
      }
      case "rule":
        return <hr key={key} className="my-2 border-border" />;
      case "image-embed": {
        if (inQuote) return inlineLink(key, token.url);
        const held = heldReason(token.url) ?? (token.thumb ? heldReason(token.thumb) : undefined);
        if (held !== undefined) return <HeldMedia key={key} kind="image" host={held || undefined} onLoad={loadMedia} />;
        const imgIndex = topIndex !== null ? tokenImageIndex.get(topIndex) ?? 0 : 0;
        const image = imageRefOf(token);
        // A spoilered PNG keeps its cover: the card preview would reveal its art.
        if (!image.spoiler && isCharacterCardCandidate(image.url, image.mime)) {
          return (
            <ImageOrCharacterCard
              key={key}
              image={image}
              onOpen={() => setLightboxIndex(imgIndex)}
            />
          );
        }
        return (
          <InlineImage
            key={key}
            image={image}
            onOpen={() => setLightboxIndex(imgIndex)}
          />
        );
      }
      case "image-gallery": {
        const held = token.urls
          .flatMap((u) => [heldReason(u.url), u.thumb ? heldReason(u.thumb) : undefined])
          .find((r) => r !== undefined);
        if (held !== undefined) {
          return <HeldMedia key={key} kind="image" count={token.urls.length} host={held || undefined} onLoad={loadMedia} />;
        }
        const galleryStartIndex = topIndex !== null ? tokenImageIndex.get(topIndex) ?? 0 : 0;
        return (
          <ImageGrid
            key={key}
            images={token.urls}
            onOpen={(idx) => setLightboxIndex(galleryStartIndex + idx)}
          />
        );
      }
      case "link-embed":
        if (inQuote || holdMedia) return inlineLink(key, token.url);
        return <LinkEmbed key={key} url={token.url} className="my-1.5" />;
      case "invite-embed":
        if (inQuote || holdMedia) return inlineLink(key, token.url);
        return <InviteEmbed key={key} url={token.url} className="my-1.5" />;
      case "buzz-invite-embed":
        if (inQuote || holdMedia) return inlineLink(key, token.url);
        return <BuzzInviteEmbed key={key} url={token.url} className="my-1.5" />;
      case "group-invite-embed":
        if (disableNoteEmbeds || inQuote || holdMedia) return selfLink(key, token.url, nip29GroupPath(token.group));
        return <Nip29GroupInviteEmbed key={key} group={token.group} className="my-1.5" />;
      case "self-chat-embed":
        // Demoted in quotes and embedded cards (the preview renders ChatContent: recursion).
        if (disableNoteEmbeds || inQuote) return selfLink(key, token.url, token.path);
        return (
          <ChatRouteEmbed
            key={key}
            url={token.url}
            route={token.route}
            path={token.path}
            className="my-1.5"
          />
        );
      case "self-link":
        return selfLink(key, token.url, token.path);
      case "inline-link":
        return inlineLink(key, token.url);
      case "magnet-link":
        return (
          <a
            key={key}
            href={token.url}
            rel="noopener noreferrer"
            className="text-primary hover:underline break-all"
            onClick={(e) => e.stopPropagation()}
          >
            {token.url}
          </a>
        );
      case "media-embed": {
        if (inQuote) return inlineLink(key, token.url);
        const imeta = imetaMap.get(token.url);
        // Both the decrypted Blob and <source> refuse octet-stream.
        const ext = extOfUrl(token.url);
        const extMime = ext ? usableMime(mimeFromExt(ext)) : undefined;
        const mediaMime = usableMime(token.mime) ?? usableMime(imeta?.mime) ?? extMime;
        const mime = mediaMime ?? "";
        // Fall back to imeta for tokens from extension match.
        const encryption = token.encryption ?? imeta?.encryption;
        const fallbacks = token.fallbacks ?? imeta?.fallbacks;
        const isXdc = isWebxdcMime(mime)
          || /\.xdc([?#][^\s]*)?$/i.test(token.url);
        if (isXdc) {
          return <XdcAttachment key={key} url={token.url} imeta={imeta} messageId={event.id} hideIcon={holdMedia} />;
        }
        const isAudio = mime.startsWith("audio/") || AUDIO_EXT_URL_REGEX.test(token.url);
        if (isAudio) {
          const held = heldReason(token.url);
          if (held !== undefined) return <HeldMedia key={key} kind="audio" host={held || undefined} onLoad={loadMedia} />;
          const waveform = imeta ? getImetaField(event.tags, token.url, "waveform") : undefined;
          const duration = imeta ? getImetaField(event.tags, token.url, "duration") : undefined;
          return (
            <AudioMessage
              key={key}
              src={token.url}
              mime={mediaMime}
              encryption={encryption}
              fallbacks={fallbacks}
              waveform={waveform}
              duration={duration}
            />
          );
        }
        // Undecodable containers (AVI, FLV, WMV) render as download cards.
        if (isUnplayableVideo(token.url, mime)) {
          return (
            <FileAttachment
              key={key}
              url={token.url}
              mime={mediaMime}
              name={imeta?.name ?? filenameFromUrl(token.url, mediaMime)}
              size={imeta?.size ? Number(imeta.size) : undefined}
              encryption={encryption}
              fallbacks={fallbacks}
            />
          );
        }
        const heldVideo = heldReason(token.url);
        if (heldVideo !== undefined) return <HeldMedia key={key} kind="video" host={heldVideo || undefined} onLoad={loadMedia} />;
        return (
          <VideoPlayer
            key={key}
            src={token.url}
            poster={imeta?.thumbnail}
            dim={imeta?.dim}
            blurhash={imeta?.blurhash}
            mime={mediaMime}
            encryption={encryption}
            fallbacks={fallbacks}
            // Tenor/Giphy-style .mp4 is really a GIF.
            gif={isGifLikeUrl(token.url)}
            spoiler={imeta?.spoiler}
            alt={imeta?.alt}
          />
        );
      }
      case "file-embed": {
        if (inQuote) return inlineLink(key, token.url);
        const thumbnail = token.thumbnail ? sanitizeUrl(token.thumbnail) : undefined;
        return (
          <FileAttachment
            key={key}
            url={token.url}
            mime={token.mime}
            name={token.name}
            size={token.size}
            encryption={token.encryption}
            fallbacks={token.fallbacks}
            thumbnail={thumbnail && heldReason(thumbnail) === undefined ? thumbnail : undefined}
          />
        );
      }
      case "nevent-embed": {
        if (disableNoteEmbeds || inQuote || holdMedia) {
          return <TruncatedNostrLink key={key} encode={() =>
            nip19.neventEncode({
              id: token.eventId,
              ...(token.author ? { author: token.author } : {}),
              ...(token.relays?.length ? { relays: token.relays } : {}),
            })}
          />;
        }
        return (
          <EmbeddedNote
            key={key}
            eventId={token.eventId}
            relays={token.relays}
            authorHint={token.author}
            sourceUrl={token.sourceUrl}
            fallbackAuthor={event.pubkey}
          />
        );
      }
      case "naddr-embed": {
        if (disableNoteEmbeds || inQuote || holdMedia) {
          return <TruncatedNostrLink key={key} encode={() => nip19.naddrEncode(token.addr)} />;
        }
        // The emoji-pack card is self-contained, so hide the raw URL.
        const hideUrl = token.addr.kind === 30030;
        return (
          <span key={key}>
            {token.url && !hideUrl && (
              <a
                href={token.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline break-all"
                onClick={(e) => e.stopPropagation()}
              >
                {token.url}
              </a>
            )}
            <EmbeddedNaddr addr={token.addr} relays={token.relays} />
          </span>
        );
      }
      case "mention":
      case "text-mention":
        return <NostrMention key={key} pubkey={token.pubkey} noAtPrefix={noMentionAtPrefix} />;
      case "nostr-link":
        return (
          <a
            key={key}
            href={dittoNip19Url(token.id)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline break-all"
            onClick={(e) => e.stopPropagation()}
          >
            {token.raw.slice(0, 16)}…
          </a>
        );
      case "hashtag": {
        const goToChannel = channelNav?.resolveChannelByName(token.tag) ?? null;
        if (goToChannel) {
          return (
            <button
              key={key}
              type="button"
              className="text-primary font-medium hover:underline"
              onClick={(e) => {
                e.stopPropagation();
                goToChannel();
              }}
            >
              {token.raw}
            </button>
          );
        }
        return (
          <a
            key={key}
            href={dittoHashtagUrl(token.tag)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {token.raw}
          </a>
        );
      }
      case "relay-link":
        return (
          <Link
            key={key}
            to={`/s/${relayToRouteParam(token.url)}`}
            className="text-primary hover:underline break-all"
            onClick={(e) => e.stopPropagation()}
          >
            {token.url}
          </Link>
        );
      case "lightning-invoice":
        return <LightningInvoice key={key} invoice={token.invoice} />;
      case "cashu-token":
        return <CashuToken key={key} raw={token.raw} />;
    }
  };

  const body = (
    <div dir="auto" className={cn("whitespace-pre-wrap break-words overflow-hidden", className, clampClass, isEmojiOnly && (isSingleEmoji ? "text-5xl leading-normal" : "text-4xl leading-tight"))}>
      {renderTokens(groupedTokens, "", true)}
      {holdMedia && heldPreviewsOnly && <HeldPreviews onLoad={loadMedia} />}

      {lightboxIndex !== null && (
        <Lightbox
          media={allImages}
          currentIndex={lightboxIndex}
          onClose={closeLightbox}
          onNext={goNext}
          onPrev={goPrev}
        />
      )}
    </div>
  );

  // Top-level bodies only: nested embeds have their own clamp, and /me renders
  // inline. Gated on raw length, which is cheap.
  const collapsible = !disableNoteEmbeds && contentOverride === undefined
    && (contentOverride ?? event.content).length > COLLAPSE_CHAR_THRESHOLD;

  if (!collapsible) return body;

  return <CollapsibleContent>{body}</CollapsibleContent>;
}

/** Memoized: rows re-render for reasons unrelated to the body. */
export const ChatContent = memo(ChatContentInner);

/** Top-level tokens a held message replaces with a {@link HeldMedia} card. */
const HELD_CARD_TOKENS: ReadonlySet<ContentToken["type"]> = new Set(["image-embed", "image-gallery", "media-embed"]);
/** Top-level tokens a held message demotes to a plain link. */
const HELD_PREVIEW_TOKENS: ReadonlySet<ContentToken["type"]> = new Set([
  "link-embed",
  "invite-embed",
  "buzz-invite-embed",
  "group-invite-embed",
  "nevent-embed",
  "naddr-embed",
]);

/**
 * Clamp with fade + "Read more" when the rendered height overflows (measured,
 * not the char heuristic).
 */
function CollapsibleContent({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(true);
  const innerRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = innerRef.current;
    if (el) setOverflowing(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 1);
  }, []);

  // Re-measure as images/previews resize the content.
  const measureRef = useCallback((el: HTMLDivElement | null) => {
    innerRef.current = el;
    if (el) requestAnimationFrame(measure);
  }, [measure]);

  return (
    <div className="relative">
      <div
        ref={measureRef}
        className={cn("overflow-hidden", !expanded && "transition-[max-height] duration-200")}
        style={{ maxHeight: expanded ? undefined : COLLAPSED_MAX_HEIGHT }}
        onLoad={measure}
      >
        {children}
      </div>
      {!expanded && overflowing && (
        <div className="pointer-events-none absolute inset-x-0 bottom-6 h-10 bg-gradient-to-t from-background to-transparent" />
      )}
      {overflowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="relative mt-1 text-xs touch:text-sm font-semibold text-primary hover:underline touch:py-1.5"
        >
          {expanded ? (
            <FormattedMessage id="chatContent.showLess" defaultMessage="Show less" />
          ) : (
            <FormattedMessage id="chatContent.readMore" defaultMessage="Read more" />
          )}
        </button>
      )}
    </div>
  );
}

/** The real host when a markdown link's TEXT reads as a different URL/domain. */
function mdLinkSpoofHost(text: string, href: string): string | undefined {
  const match = text.trim().toLowerCase().match(/^(?:https?:\/\/)?((?:[\w-]+\.)+[a-z]{2,})(?:[/:?#]|$)/i);
  const textHost = match?.[1]?.replace(/^www\./, "");
  if (!textHost) return undefined;
  try {
    const realHost = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
    return realHost === textHost ? undefined : realHost;
  } catch {
    return undefined;
  }
}

/** In-app link label: the path with opaque segments shortened. Full URL in `title`. */
function selfLinkLabel(path: string): string {
  const [pathname] = path.split(/[?#]/);
  const shortened = pathname
    .split("/")
    .map((seg) => (seg.length > 16 ? `${seg.slice(0, 10)}…` : seg))
    .join("/");
  return shortened || path;
}

function extOfUrl(url: string): string | undefined {
  try {
    const path = new URL(url).pathname;
    const seg = path.split("/").pop() ?? "";
    const dot = seg.lastIndexOf(".");
    if (dot <= 0 || dot === seg.length - 1) return undefined;
    return seg.slice(dot + 1).toLowerCase();
  } catch {
    return undefined;
  }
}

function getImetaField(tags: string[][], url: string, field: string): string | undefined {
  for (const tag of tags) {
    if (tag[0] !== "imeta") continue;
    if (!tag.some((part) => part === `url ${url}`)) continue;
    for (const part of tag) {
      if (part.startsWith(`${field} `)) return part.slice(field.length + 1);
    }
  }
  return undefined;
}

const shareImageLabel = defineMessage({ id: "chatContent.shareImage", defaultMessage: "Share image" });

function saveFailed(): void {
  toast({
    title: t({ id: "chatContent.loadFailedTitle", defaultMessage: "Couldn't load this image" }),
    description: t({ id: "chatContent.loadFailedDescription", defaultMessage: "Please try again." }),
    variant: "destructive",
  });
}

/** Save from the resolved (decrypted) source, mirroring the lightbox's download. */
async function saveImage(src: string, image: ImageRef): Promise<void> {
  try {
    const result = await downloadUrl(src, { nameHint: image.url, mime: image.mime });
    toast(
      result.status === "downloaded"
        ? { title: t({ id: "chatContent.saved", defaultMessage: "Saved" }), description: savedDescription(result.location) }
        : {
            title: t({ id: "chatContent.openedInTab", defaultMessage: "Opened in a new tab" }),
            description: t({ id: "chatContent.openedInTabDescription", defaultMessage: "This image couldn't be saved directly, so it opened instead." }),
          },
    );
  } catch {
    toast({
      title: t({ id: "chatContent.downloadFailed", defaultMessage: "Download failed" }),
      description: t({ id: "chatContent.downloadFailedDescription", defaultMessage: "Could not save this image. Please try again." }),
      variant: "destructive",
    });
  }
}

/** Share the file, never the URL. */
async function shareImage(src: string, image: ImageRef): Promise<void> {
  const shared = await shareFile(src, {
    nameHint: image.url,
    mime: image.mime,
    dialogTitle: t(shareImageLabel),
  });
  if (!shared) {
    toast({
      title: t({ id: "chatContent.shareFailed", defaultMessage: "Couldn't share this image" }),
      description: t({ id: "chatContent.shareFailedDescription", defaultMessage: "Try downloading it instead." }),
      variant: "destructive",
    });
  }
}

async function copyImage(src: string): Promise<void> {
  try {
    await writeClipboardImage(src);
    toast({ title: t(common.copied), description: t({ id: "chatContent.copiedImage", defaultMessage: "The image is on your clipboard." }) });
  } catch {
    toast({
      title: t({ id: "chatContent.copyFailed", defaultMessage: "Couldn't copy this image" }),
      description: t({ id: "chatContent.copyFailedDescription", defaultMessage: "Try saving or sharing it instead." }),
      variant: "destructive",
    });
  }
}

/**
 * Tap opens the lightbox; long-press/right-click opens the MESSAGE menu with
 * this image's actions prepended (via {@link useChatImageMenu}). Save/share
 * need the resolved source.
 */
function useImageMenu(
  image: ImageRef,
  getSrc: (() => Promise<string>) | null,
  onOpen: () => void,
  /** What a plain tap does, when it isn't "Open image". */
  onActivate: () => void = onOpen,
) {
  const menu = useChatImageMenu();
  const intl = useIntl();

  const actions = useMemo<MessageActionItem[]>(() => {
    const list: MessageActionItem[] = [
      { id: "img-open", label: intl.formatMessage({ id: "chatContent.openImage", defaultMessage: "Open image" }), icon: Expand, onSelect: onOpen },
    ];
    if (getSrc) {
      list.push({
        id: "img-save",
        label: intl.formatMessage({ id: "chatContent.saveImage", defaultMessage: "Save image" }),
        icon: Download,
        onSelect: () => void getSrc().then((src) => saveImage(src, image), () => saveFailed()),
      });
      if (canShareFiles()) {
        list.push({
          id: "img-share",
          label: intl.formatMessage(shareImageLabel),
          icon: Share2,
          onSelect: () => void getSrc().then((src) => shareImage(src, image), () => saveFailed()),
        });
      }
      if (canCopyImages()) {
        list.push({
          id: "img-copy",
          label: intl.formatMessage({ id: "chatContent.copyImage", defaultMessage: "Copy image" }),
          icon: Copy,
          onSelect: () => void getSrc().then(copyImage, () => saveFailed()),
        });
      }
    }
    return list;
  }, [image, getSrc, onOpen, intl]);

  // Touch only; the <button> IS the long-press target.
  const longPress = useLongPress(
    menu?.isTouch ? () => menu.openSheet(actions) : undefined,
    { allowInteractive: true },
  );

  return {
    onPointerDown: longPress.onPointerDown,
    onPointerMove: longPress.onPointerMove,
    onPointerUp: longPress.onPointerUp,
    onPointerCancel: longPress.onPointerCancel,
    // Native drag cancels the pointer stream mid-hold.
    onDragStart: (e: React.DragEvent) => e.preventDefault(),
    onClick: (e: React.MouseEvent) => {
      // Swallow the click after a long-press so the lightbox doesn't open.
      longPress.onClick(e);
      if (e.defaultPrevented) return;
      e.stopPropagation();
      onActivate();
    },
    onContextMenu: (e: React.MouseEvent) => {
      longPress.onContextMenu(e);
      if (menu?.isTouch) {
        // Suppress the platform's image callout.
        e.preventDefault();
      } else if (menu) {
        // Desktop: stage actions and let the event bubble to the row's context menu.
        menu.stage(actions);
      }
    },
  };
}

/**
 * The full image on demand, for save/share/copy while a cell shows its
 * preview: routed through the media policy, and decrypted when encrypted.
 */
function useFullImageSrc(image: ImageRef, enabled: boolean): (() => Promise<string>) | null {
  const { sources } = useRoutedCandidates(enabled ? image.url : undefined, image.fallbacks);
  const { url, mime, encryption } = image;
  const encKey = encryption?.algorithm ? `${encryption.key}\n${encryption.nonce}` : "";
  return useMemo(() => {
    if (!enabled || sources.length === 0) return null;
    const enc = encKey && encryption ? encryption : undefined;
    return async () => {
      const primed = peekPrimedAttachment(url, enc);
      if (primed) return primed;
      if (!enc) return sources[0];
      return decryptAttachmentToObjectURL(sources[0], enc, mime, { alternates: sources.slice(1) });
    };
    // `encryption` is keyed by its fields (a fresh object each render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sources, url, mime, encKey]);
}

/**
 * What an inline cell loads: the sender's preview when the image has one, so a
 * chat downloads the full image only in the lightbox. A preview that fails to
 * load falls back to the image. Not for Buzz blobs (their fetch is signed).
 */
function useShownImage(image: ImageRef) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const preview = image.thumb !== undefined && !previewFailed && !isBuzzMediaUrl(image.url);
  const shown: ImageRef = preview ? { ...image, url: image.thumb!, fallbacks: undefined } : image;
  const media = useMediaWithFallback(shown);
  useEffect(() => {
    if (preview && media.failed) setPreviewFailed(true);
  }, [preview, media.failed]);
  const full = useFullImageSrc(image, preview);
  const readySrc = media.resolved.status === "ready" ? media.resolved.src : null;
  const own = useMemo(() => (readySrc ? () => Promise.resolve(readySrc) : null), [readySrc]);
  return { ...media, failed: media.failed && !preview, getSrc: preview ? full : own };
}

/** Covered by a spoiler: no menu handlers and out of tab order; reachable only via reveal. */
const COVERED_IMAGE_PROPS = { tabIndex: -1 } as const;

/** Starts a sniff a little before the image scrolls in, like the browser's own lazy load. */
const CARD_SNIFF_MARGIN = "600px";

/**
 * An image that may secretly be a character card (the PNG `tEXt` payload).
 * The sniff reads the full file, so it waits until the image nears the
 * viewport. A found card frames the art with a footer, and a tap anywhere
 * opens the card; the lightbox stays reachable from the image menu and the
 * card dialog's art.
 */
function ImageOrCharacterCard({ image, onOpen }: { image: ImageRef; onOpen: () => void }) {
  // Buzz blobs need a signed GET the sniffer doesn't do; those stay plain images.
  const sniffable = !isBuzzMediaUrl(image.url);
  const boxRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!sniffable || near) return;
    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: CARD_SNIFF_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [sniffable, near]);
  const { sources } = useRoutedCandidates(sniffable && near ? image.url : undefined, image.fallbacks);
  const [card, setCard] = useState<CharaCard | null>(null);
  const { url, mime, encryption, fallbacks } = image;
  useEffect(() => {
    if (sources.length === 0) return;
    let cancelled = false;
    void sniffCharacterCard({ url, mime, encryption, fallbacks }, sources).then((found) => {
      if (!cancelled && found) setCard(found);
    });
    return () => {
      cancelled = true;
    };
  }, [url, mime, encryption, fallbacks, sources]);
  const [cardOpen, setCardOpen] = useState(false);
  const openCard = useCallback(() => setCardOpen(true), []);
  // One tree either way, so the loaded image isn't remounted when the card lands.
  return (
    <div
      ref={boxRef}
      className={cn(
        "w-fit max-w-full",
        card && "my-1.5 overflow-hidden clip-hairline-lg [--edge:var(--border)/0.5] [--fill:var(--secondary)/0.3] [--fill-hover:var(--secondary)/0.5]",
      )}
    >
      <InlineImage
        image={image}
        onOpen={onOpen}
        onActivate={card ? openCard : undefined}
        className={card ? "my-0 rounded-none [&_*]:!rounded-none" : undefined}
      />
      {card && (
        // Zero intrinsic width: the art sets the card's width, the footer truncates to it.
        <div className="w-0 min-w-full">
          <CharacterCardEmbed card={card} image={image} open={cardOpen} onOpenChange={setCardOpen} />
        </div>
      )}
    </div>
  );
}

function InlineImage({
  image,
  onOpen,
  onActivate,
  className,
}: {
  image: ImageRef;
  onOpen: () => void;
  onActivate?: () => void;
  className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // A size measured by any earlier load, then this one's: the timeline's resize
  // anchoring keeps the reader's place when the box takes the image's shape.
  const [knownDim, setKnownDim] = useState(() => seenImageDim(image.url));
  const { resolved, onError, failed, fallbackProps, getSrc } = useShownImage(image);
  const menu = useImageMenu(image, getSrc, onOpen, onActivate);
  const covered = image.spoiler && !revealed;

  // Block-level: the tokenizer stripped the surrounding newlines expecting a block.
  if (failed) {
    return <MediaFallback {...fallbackProps} kind="image" />;
  }

  // A known `dim` reserves the exact final box; without one the image is fitted
  // inside a fixed box until it loads and its own size is known. Widths are
  // explicit: a button (and the card wrapper) shrink-to-fit, so a percentage
  // width would collapse to the not-yet-loaded content, 0×0.
  const box = fitImageBox(image.dim ?? knownDim) ?? UNSIZED_IMAGE_BOX;
  const fitted = box === UNSIZED_IMAGE_BOX;

  return (
    <button
      type="button"
      className={cn(
        "block max-w-full my-1.5 rounded overflow-hidden cursor-pointer select-none [-webkit-user-select:none] [-webkit-touch-callout:none] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        className,
      )}
      style={{ width: box.maxWidth }}
      {...(covered ? COVERED_IMAGE_PROPS : menu)}
    >
      <div
        className={cn(
          "relative w-full rounded overflow-hidden",
          !loaded && !image.blurhash && "bg-muted",
        )}
        style={{ aspectRatio: box.aspectRatio }}
      >
        {!loaded && image.blurhash && (
          <BlurhashCanvas hash={image.blurhash} className="absolute inset-0" />
        )}
        {covered && <MediaSpoilerCover onReveal={() => setRevealed(true)} />}
        {resolved.status === "ready" && (
          <img
            src={resolved.src}
            alt={covered ? "" : (image.alt ?? "")}
            title={covered ? undefined : image.alt}
            aria-hidden={covered || undefined}
            // Native drag/callout would cancel the long-press.
            draggable={false}
            className={cn(
              "block rounded hover:opacity-90 transition-opacity [-webkit-user-drag:none]",
              // Fitted, not cropped: an unsized image's real shape is unknown.
              fitted ? "w-full h-full object-contain object-left" : "w-full h-full object-cover",
            )}
            loading="lazy"
            decoding="async"
            onLoad={(e) => {
              setLoaded(true);
              captureLoadedMedia(resolved.src);
              const { naturalWidth, naturalHeight } = e.currentTarget;
              rememberImageDim(image.url, naturalWidth, naturalHeight);
              if (fitted && naturalWidth && naturalHeight) setKnownDim(`${naturalWidth}x${naturalHeight}`);
            }}
            onError={onError}
          />
        )}
      </div>
    </button>
  );
}

function ImageGrid({ images, onOpen }: { images: ImageRef[]; onOpen: (index: number) => void }) {
  const visible = images.slice(0, 4);
  const extra = images.length - visible.length;

  return (
    <div className="grid grid-cols-2 gap-1 my-1.5 max-w-sm">
      {visible.map((image, i) => (
        <GridImage
          key={i}
          image={image}
          onOpen={() => onOpen(i)}
          overflow={i === visible.length - 1 && extra > 0 ? extra : undefined}
        />
      ))}
    </div>
  );
}

/** Owns its `<button>` so {@link useImageMenu} has this cell's resolved source. */
function GridImage({
  image,
  onOpen,
  overflow,
}: {
  image: ImageRef;
  onOpen: () => void;
  overflow?: number;
}) {
  const [loaded, setLoaded] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const { resolved, onError, failed, fallbackProps, getSrc } = useShownImage(image);
  const menu = useImageMenu(image, getSrc, onOpen);
  const covered = image.spoiler && !revealed;

  return (
    <button
      type="button"
      className="relative aspect-square rounded overflow-hidden bg-muted cursor-pointer select-none [-webkit-user-select:none] [-webkit-touch-callout:none] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      {...(covered ? COVERED_IMAGE_PROPS : menu)}
    >
      {failed ? (
        <MediaFallback {...fallbackProps} compact />
      ) : (
        <>
          {!loaded && image.blurhash && (
            <BlurhashCanvas hash={image.blurhash} className="absolute inset-0" />
          )}
          {resolved.status === "ready" && (
            <img
              src={resolved.src}
              alt={covered ? "" : (image.alt ?? "")}
              title={covered ? undefined : image.alt}
              aria-hidden={covered || undefined}
              // See InlineImage: native drag/callout would eat the long-press.
              draggable={false}
              loading="lazy"
              decoding="async"
              onLoad={() => {
                setLoaded(true);
                captureLoadedMedia(resolved.src);
              }}
              onError={onError}
              className="absolute inset-0 w-full h-full object-cover hover:opacity-90 transition-opacity [-webkit-user-drag:none]"
            />
          )}
        </>
      )}
      {covered && <MediaSpoilerCover compact onReveal={() => setRevealed(true)} />}
      {overflow !== undefined && (
        <span className="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-lg font-semibold">
          +{overflow}
        </span>
      )}
    </button>
  );
}

/** The fixed box for an image with no `dim` (and none remembered): 4:3 at max-w-xs. */
const UNSIZED_IMAGE_BOX = { aspectRatio: "4 / 3", maxWidth: 320 };

/**
 * Fit a NIP-94 `dim` into the inline caps (max-w-sm × max-h-80) without
 * upscaling: an `aspect-ratio` plus capped `maxWidth`, so portrait images
 * don't resize on load. Undefined for missing/malformed `dim`.
 */
function fitImageBox(
  dim: string | undefined,
): { aspectRatio: string; maxWidth: number } | undefined {
  if (!dim) return undefined;
  const [w, h] = dim.split("x").map(Number);
  if (!w || !h || Number.isNaN(w) || Number.isNaN(h)) return undefined;
  const MAX_W = 384; // max-w-sm
  const MAX_H = 320; // max-h-80
  const scale = Math.min(1, MAX_W / w, MAX_H / h);
  return { aspectRatio: `${w} / ${h}`, maxWidth: Math.round(w * scale) };
}

function NostrMention({ pubkey, noAtPrefix = false }: { pubkey: string; noAtPrefix?: boolean }) {
  const author = useAuthor(pubkey);
  const scopedName = useScopedDisplayName(pubkey, author.data?.metadata);
  const hasRealName = !!(author.data?.metadata?.name || author.data?.metadata?.display_name)
    || scopedName !== getDisplayName(author.data?.metadata, pubkey);
  const displayName = scopedName;

  return (
    <ProfilePreviewCard pubkey={pubkey}>
      <button
        type="button"
        className={cn(
          "font-medium hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded",
          hasRealName ? "text-primary" : "text-muted-foreground",
        )}
        title={pubkey}
        onClick={(e) => e.stopPropagation()}
      >
        {noAtPrefix ? "" : "@"}
        <DisplayName pubkey={pubkey} name={displayName} />
      </button>
    </ProfilePreviewCard>
  );
}

function TruncatedNostrLink({ encode }: { encode: () => string }) {
  const id = useMemo(() => {
    try {
      return encode();
    } catch {
      return null;
    }
  }, [encode]);

  if (!id) return null;

  return (
    <a
      href={dittoNip19Url(id)}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary hover:underline break-all"
      onClick={(e) => e.stopPropagation()}
    >
      {id.slice(0, 16)}…
    </a>
  );
}

function LightningInvoice({ invoice }: { invoice: string }) {
  const [copied, setCopied] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  // Two-tap pay (arm, then confirm with amount shown), auto-disarming. Amountless
  // invoices are never one-tap payable.
  const [armed, setArmed] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(disarmTimer.current), []);
  const { activeConnection, payWithNWC, webln } = useWallet();
  const { toast } = useToast();
  const intl = useIntl();
  const amountSats = useMemo(() => bolt11AmountSats(invoice), [invoice]);
  const canPay = Boolean(activeConnection || webln) && amountSats !== null;

  const handlePay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (paying || paid) return;
    if (!armed) {
      setArmed(true);
      clearTimeout(disarmTimer.current);
      disarmTimer.current = setTimeout(() => setArmed(false), 4000);
      return;
    }
    clearTimeout(disarmTimer.current);
    setArmed(false);
    setPaying(true);
    try {
      if (activeConnection) {
        await payWithNWC(invoice);
      } else {
        await webln!.enable();
        await webln!.sendPayment(invoice);
      }
      setPaid(true);
      toast({ title: t({ id: "chatContent.invoicePaid", defaultMessage: "Invoice paid" }) });
    } catch (err) {
      toast({
        title: t({ id: "chatContent.paymentFailed", defaultMessage: "Payment failed" }),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setPaying(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1 max-w-full my-1">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 min-w-0 px-2.5 py-1 touch:px-3.5 touch:py-2 touch:min-h-11 clip-corner-lg bg-amber-500/15 text-amber-500 text-xs hover:bg-amber-500/25 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          writeClipboardText(invoice).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }, () => undefined);
        }}
        title={intl.formatMessage({ id: "chatContent.copyInvoice", defaultMessage: "Copy lightning invoice" })}
      >
        <span aria-hidden>⚡</span>
        <span className="truncate font-mono">
          {amountSats !== null
            ? intl.formatMessage({ id: "chatContent.sats", defaultMessage: "{amount} sats" }, { amount: formatSats(amountSats) })
            : invoice.slice(0, 24) + "…"}
        </span>
        <span className="shrink-0">{copied ? intl.formatMessage(common.copied) : intl.formatMessage(common.copy)}</span>
      </button>
      {canPay && (
        <button
          type="button"
          className={cn(
            "shrink-0 px-2.5 py-1 touch:px-3.5 touch:py-2 touch:min-h-11 clip-corner-lg text-xs font-medium transition-colors disabled:opacity-60",
            armed
              ? "bg-amber-500 text-amber-950 hover:bg-amber-400"
              : "bg-amber-500/25 text-amber-500 hover:bg-amber-500/35",
          )}
          onClick={handlePay}
          disabled={paying || paid}
          title={intl.formatMessage({ id: "chatContent.payWithWallet", defaultMessage: "Pay with your connected wallet" })}
        >
          {paid
            ? intl.formatMessage({ id: "chatContent.paid", defaultMessage: "Paid ✓" })
            : paying
              ? intl.formatMessage({ id: "chatContent.paying", defaultMessage: "Paying…" })
              : armed
                ? intl.formatMessage({ id: "chatContent.confirmPay", defaultMessage: "Confirm {amount} sats?" }, { amount: formatSats(amountSats!) })
                : intl.formatMessage({ id: "chatContent.pay", defaultMessage: "Pay" })}
        </button>
      )}
    </span>
  );
}
