import { nip19 } from "nostr-tools";
import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";

import { BlurhashCanvas } from "@/components/BlurhashCanvas";
import { AudioMessage } from "@/components/chat/AudioMessage";
import { emojify } from "@/components/chat/emojify";
import { EmbeddedNaddr, EmbeddedNote } from "@/components/chat/EmbeddedNote";
import { Lightbox } from "@/components/chat/Lightbox";
import { LinkEmbed } from "@/components/chat/LinkEmbed";
import { CodeBlock, InlineCode } from "@/components/chat/Markdown";
import { renderInlineMarkdown } from "@/components/chat/markdownRender";
import { VideoPlayer } from "@/components/chat/VideoPlayer";
import { XdcAttachment } from "@/components/chat/XdcAttachment";
import { useAuthor } from "@/hooks/useAuthor";
import { useChannelNav } from "@/hooks/useChannelNav";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { buildEmojiMap } from "@/lib/customEmoji";
import { writeClipboardText } from "@/lib/clipboard";
import { dittoHashtagUrl, dittoNip19Url } from "@/lib/dittoUrl";
import { getDisplayName } from "@/lib/getDisplayName";
import { HASHTAG_PATTERN } from "@/lib/hashtag";
import { parseImetaMap } from "@/lib/imeta";
import { splitInlineCode, splitMarkdownBlocks } from "@/lib/markdown";
import { AUDIO_EXTS, EMBED_MEDIA_URL_REGEX, IMAGE_URL_REGEX, mimeFromExt } from "@/lib/mediaUrls";
import { relayToRouteParam } from "@/lib/platform";
import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { useResolvedMediaSrc } from "@/hooks/useResolvedMediaSrc";
import { useToast } from "@/hooks/useToast";
import { useWallet } from "@/hooks/useWallet";

import type { AddrCoords } from "@/hooks/useEvent";
import type { ImetaEncryption, ImetaEntry } from "@/lib/imeta";
import type { EncryptedRef } from "@/hooks/useResolvedMediaSrc";
import type { NostrEvent } from "@nostrify/nostrify";
import type { ReactNode } from "react";

interface ChatContentProps {
  event: NostrEvent;
  className?: string;
  /** When true, nested nostr:nevent/note/naddr embeds render as inline links
   *  instead of cards. Used inside embedded cards to prevent recursion. */
  disableNoteEmbeds?: boolean;
  /** When set, occurrences of this term in plain text are highlighted. */
  highlight?: string;
  /** When set, this text is rendered instead of `event.content` (e.g. a
   *  /me action body with its marker prefix stripped). Tags/imeta still come
   *  from `event`. */
  contentOverride?: string;
  /** When true, mention chips render the bare display name without an `@`
   *  prefix. Used for /me actions, which read as prose ("Alice slaps Bob"). */
  noMentionAtPrefix?: boolean;
}

/** Bech32 charset used by NIP-19 identifiers. */
const BECH32_CHARS = "023456789acdefghjklmnpqrstuvwxyz";

/** Regex to extract an naddr1 identifier from a URL path (e.g. habla links). */
const NADDR_IN_URL_REGEX = new RegExp(`naddr1[${BECH32_CHARS}]{10,}`, "i");

/** Try to extract naddr coordinates from a URL containing an naddr1 identifier. */
function extractNaddrFromUrl(url: string): AddrCoords | null {
  const match = url.match(NADDR_IN_URL_REGEX);
  if (!match) return null;
  try {
    const decoded = nip19.decode(match[0]);
    if (decoded.type === "naddr") {
      return decoded.data as AddrCoords;
    }
  } catch {
    // invalid naddr
  }
  return null;
}

/** A possibly-encrypted image reference for the gallery/lightbox. */
type ImageRef = EncryptedRef;

/** A parsed token from message content. */
type ContentToken =
  | { type: "text"; value: string }
  | { type: "image-embed"; url: string; encryption?: ImetaEncryption; mime?: string; dim?: string; blurhash?: string }
  | { type: "image-gallery"; urls: ImageRef[] }
  | { type: "media-embed"; url: string; encryption?: ImetaEncryption; mime?: string }
  | { type: "link-embed"; url: string }
  | { type: "inline-link"; url: string }
  | { type: "mention"; pubkey: string }
  | { type: "nevent-embed"; eventId: string; relays?: string[]; author?: string }
  | { type: "naddr-embed"; addr: AddrCoords; url?: string }
  | { type: "nostr-link"; id: string; raw: string }
  | { type: "hashtag"; tag: string; raw: string }
  | { type: "relay-link"; url: string }
  | { type: "lightning-invoice"; invoice: string }
  | { type: "code-block"; code: string; lang?: string }
  | { type: "inline-code"; code: string }
  | { type: "quote"; tokens: ContentToken[] };

/**
 * Render text with a highlighted search term, after custom-emoji replacement.
 * Splits on case-insensitive occurrences of `term`, emojifies each segment,
 * and wraps the matched segments in a `<mark>`.
 */
function highlightText(
  text: string,
  term: string | undefined,
  emojiMap: Map<string, string>,
  imgClassName?: string,
): ReactNode[] {
  if (!term || !term.trim()) return emojify(text, emojiMap, imgClassName);

  const needle = term.trim().toLowerCase();
  const out: ReactNode[] = [];
  const hay = text.toLowerCase();
  let from = 0;
  let key = 0;

  for (;;) {
    const idx = hay.indexOf(needle, from);
    if (idx === -1) {
      out.push(...emojify(text.slice(from), emojiMap, imgClassName));
      break;
    }
    if (idx > from) out.push(...emojify(text.slice(from, idx), emojiMap, imgClassName));
    out.push(
      <mark key={`hl-${key++}`} className="bg-primary/30 text-foreground rounded-[2px]">
        {emojify(text.slice(idx, idx + needle.length), emojiMap, imgClassName)}
      </mark>,
    );
    from = idx + needle.length;
  }

  return out;
}

/**
 * Regex segment matching a single visual emoji unit (ZWJ sequences, skin
 * tones, flags, keycaps, tag sequences, and basic presentation emojis).
 */
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

/** NIP-30 custom emoji shortcode pattern. */
const CUSTOM_EMOJI_SHORTCODE = ":([a-zA-Z0-9_-]+):";

/** Matches a string of only emoji (unicode and/or custom shortcodes), max 10. */
const EMOJI_OR_CUSTOM_ONLY_REGEX = new RegExp(
  `^\\s*(?:(?:${CUSTOM_EMOJI_SHORTCODE}|${EMOJI_UNIT})\\s*){1,10}$`,
  "u",
);

/** Check if a string contains only emojis / resolvable custom shortcodes. */
function isOnlyEmojisOrCustom(text: string, emojiMap: Map<string, string>): boolean {
  if (!EMOJI_OR_CUSTOM_ONLY_REGEX.test(text)) return false;
  const shortcodeMatches = text.matchAll(/:([a-zA-Z0-9_-]+):/g);
  for (const m of shortcodeMatches) {
    if (!emojiMap.has(m[1])) return false;
  }
  return true;
}

/** Kinds whose imeta tags describe attached media for the content body. */
const MEDIA_IMETA_KINDS = new Set([1, 9, 11, 1111, 1222, 1244, 3300]);

/**
 * Plain-text length (of the raw content, before tokenizing/rendering) past
 * which a message defaults to collapsed with a "Read more" control. Picked to
 * land at roughly one screenful of chat text (~8-10 wrapped lines at typical
 * viewport widths) rather than an exact character budget — the goal is
 * "doesn't blow out the timeline", not a precise cutoff. Well below the
 * composer's MAX_CHARS, so only a minority of longer messages collapse.
 */
const COLLAPSE_CHAR_THRESHOLD = 600;

/** Collapsed height (px) for long messages — enough for ~8-10 lines before the fade. */
const COLLAPSED_MAX_HEIGHT = 224;

/** Matches audio file extensions in a URL (drives AudioMessage vs VideoPlayer). */
const AUDIO_EXT_URL_REGEX = new RegExp(`\\.(${AUDIO_EXTS})(\\?[^\\s]*)?$`, "i");

/**
 * Treat `application/octet-stream` (and empty) as "no MIME info": Blossom
 * servers commonly report it for ciphertext/unknown blobs, and passing it
 * through breaks playback — `<source type="application/octet-stream">` is
 * rejected outright, and a decrypted Blob typed octet-stream won't play as a
 * media src in Firefox. Callers fall back to extension-derived MIME instead.
 */
function usableMime(m: string | undefined): string | undefined {
  if (!m || m.startsWith("application/octet-stream")) return undefined;
  return m;
}

/**
 * Rich message content renderer. Tokenizes the event content and renders:
 * URLs (inline images/galleries, video and audio players, link preview
 * cards), nostr: URIs (mentions, embedded note/naddr cards), hashtags,
 * NIP-30 custom emoji, and lightning invoices.
 */
export function ChatContent({ event, className, disableNoteEmbeds = false, highlight, contentOverride, noMentionAtPrefix = false }: ChatContentProps) {
  const tokens = useMemo(() => {
    const text = contentOverride ?? event.content;

    // Parse imeta tags for media URLs declared out-of-band. Vector/0xChat send
    // chat attachments by uploading AES-GCM ciphertext to Blossom and putting
    // the (often extension-less) URL + decryption key/nonce inside an `imeta`
    // tag — for Concord (kind 3300) the URL is ONLY in the imeta, not in the
    // content body. We use these to (a) classify extension-less URLs as media
    // and (b) emit embeds for imeta media not present inline.
    const isMediaImetaKind = MEDIA_IMETA_KINDS.has(event.kind);
    const imetaByUrl = isMediaImetaKind
      ? parseImetaMap(event.tags)
      : new Map<string, ImetaEntry>();
    const imetaMimeByUrl = new Map<string, string>();
    for (const [u, entry] of imetaByUrl) {
      const safe = sanitizeUrl(u);
      const mime = usableMime(entry.mime);
      if (safe && mime) imetaMimeByUrl.set(safe, mime);
    }

    // Resolve the effective MIME for an imeta URL: explicit `m`, else inferred
    // from the URL extension, else the `name` field's extension. An
    // uninformative `m` (application/octet-stream) is skipped so the
    // extension can win — see usableMime.
    const imageMimeFor = (entry: { mime?: string; url: string; name?: string }): string | undefined => {
      const explicit = usableMime(entry.mime);
      if (explicit) return explicit;
      const fromUrl = extOfUrl(entry.url);
      const urlMime = fromUrl ? usableMime(mimeFromExt(fromUrl)) : undefined;
      if (urlMime) return urlMime;
      const fromName = entry.name ? entry.name.split(".").pop()?.toLowerCase() : undefined;
      return fromName ? usableMime(mimeFromExt(fromName)) : undefined;
    };

    // Tokenize one plain-text segment (already free of markdown code spans):
    // BOLT11 invoices | URLs | nostr:-prefixed NIP-19 ids | @-prefixed or
    // bare NIP-19 ids | hashtags.
    const tokenizeSegment = (segment: string): ContentToken[] => {
      const regex = new RegExp(
        "(?:lightning:)?(ln(?:bc|tb|bcrt|tbs)\\d*[munp]?1[023456789acdefghjklmnpqrstuvwxyz]+)" +
        "|((?:https?|wss?):\\/\\/[^\\s]+)" +
        "|nostr:(npub1|note1|nprofile1|nevent1|naddr1)([023456789acdefghjklmnpqrstuvwxyz]+)" +
        "|@?(npub1|note1|nprofile1|nevent1|naddr1)([023456789acdefghjklmnpqrstuvwxyz]+)" +
        `|(${HASHTAG_PATTERN})`,
        "giu",
      );

      const out: ContentToken[] = [];
      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(segment)) !== null) {
        let [fullMatch] = match;
        const bolt11 = match[1];
        let url = match[2];
        const hashtag = match[7];
        const { 3: nostrPrefix, 4: nostrData, 5: barePrefix, 6: bareData } = match;
        const index = match.index;

        // Add text before this match
        if (index > lastIndex) {
          out.push({ type: "text", value: segment.substring(lastIndex, index) });
        }

        if (bolt11) {
          out.push({ type: "lightning-invoice", invoice: bolt11.toLowerCase() });
        } else if (url) {
          // Strip common trailing punctuation that's likely not part of the URL
          const trailingPunctMatch = url.match(/^(.*?)([.,;:!?)\]]+)$/);
          if (trailingPunctMatch) {
            const [, urlWithoutPunct] = trailingPunctMatch;
            if (urlWithoutPunct && urlWithoutPunct.length > 10) {
              url = urlWithoutPunct;
              fullMatch = urlWithoutPunct;
            }
          }

          // WebSocket relay URLs → internal server page link
          if (/^wss?:\/\//i.test(url)) {
            out.push({ type: "relay-link", url });
            lastIndex = index + fullMatch.length;
            continue;
          }

          // Image URLs → render inline at their position in the text. Match by
          // extension, or by an imeta entry declaring an image MIME (covers
          // extension-less / encrypted Blossom URLs). Encrypted attachments carry
          // their decryption key/nonce so the embed can fetch+decrypt the blob.
          const inlineImeta = imetaByUrl.get(url);
          const inlineImetaMime = inlineImeta ? imageMimeFor(inlineImeta) : undefined;
          const isImetaImage = inlineImetaMime?.startsWith("image/") ?? false;
          if (IMAGE_URL_REGEX.test(url) || isImetaImage) {
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
            });
            lastIndex = index + fullMatch.length;
            const leadingWs = segment.substring(lastIndex).match(/^\s+/);
            if (leadingWs) lastIndex += leadingWs[0].length;
            continue;
          }

          // Non-image media URLs (video, audio) — render inline at their position.
          // Match by extension, or by an imeta-declared audio/video MIME (covers
          // extension-less upload URLs like blossom sha256 filenames). Like
          // image-embed, the token carries the imeta decryption params + MIME so
          // encrypted (Concord/Vector) blobs decrypt before playback.
          const imetaMime = inlineImetaMime ?? imetaMimeByUrl.get(url);
          const isImetaMedia = imetaMime?.startsWith("audio/") || imetaMime?.startsWith("video/");
          if (EMBED_MEDIA_URL_REGEX.test(url) || isImetaMedia) {
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
              mime: imetaMime,
            });
            lastIndex = index + fullMatch.length;
            const leadingWs = segment.substring(lastIndex).match(/^\s+/);
            if (leadingWs) lastIndex += leadingWs[0].length;
            continue;
          }

          // A URL gets a preview card when nothing meaningful follows it on
          // the same line; mid-sentence URLs stay plain links.
          const afterUrl = segment.substring(index + fullMatch.length);
          const nextNewline = afterUrl.indexOf("\n");
          const lineSuffix = nextNewline === -1 ? afterUrl : afterUrl.substring(0, nextNewline);
          const isEndOfLine = lineSuffix.trim() === "";

          const naddrFromUrl = extractNaddrFromUrl(url);
          if (naddrFromUrl) {
            out.push({ type: "naddr-embed", addr: naddrFromUrl, url });
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
              out.push({ type: "naddr-embed", addr: decoded.data as AddrCoords });
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

      // Add any remaining text
      if (lastIndex < segment.length) {
        out.push({ type: "text", value: segment.substring(lastIndex) });
      }
      return out;
    };

    // A text run may still contain `inline code` spans — extract those first
    // so code never gets linkified/emojified.
    const tokenizeRun = (run: string): ContentToken[] => {
      const out: ContentToken[] = [];
      for (const seg of splitInlineCode(run)) {
        if (seg.code) out.push({ type: "inline-code", code: seg.value });
        else out.push(...tokenizeSegment(seg.value));
      }
      return out;
    };

    // Markdown block pass first (fenced ``` code, > quotes), then tokenize
    // each non-code run. Quote blocks carry their own token list and render
    // inside a <blockquote> (media inside quotes demotes to plain links).
    const result: ContentToken[] = [];
    for (const block of splitMarkdownBlocks(text)) {
      if (block.type === "code") {
        result.push({ type: "code-block", code: block.code, lang: block.lang });
      } else if (block.type === "quote") {
        result.push({ type: "quote", tokens: tokenizeRun(block.text) });
      } else {
        result.push(...tokenizeRun(block.text));
      }
    }

    // Enrich nevent-embed tokens with relay/author hints from `q` tags.
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

    // Append embeds for imeta-declared media URLs not found inline in the
    // content (NIP-92 attachments without an inline URL — the Concord/Vector
    // case, where the Blossom URL lives ONLY in the imeta tag). Images become
    // image-embeds (decrypted on display if encrypted); audio/video become
    // media-embeds.
    if (isMediaImetaKind) {
      const renderedUrls = new Set(
        result.flatMap((t) =>
          t.type === "media-embed" || t.type === "image-embed" ? [t.url] : [],
        ),
      );
      for (const [rawUrl, entry] of imetaByUrl) {
        const url = sanitizeUrl(rawUrl);
        if (!url || renderedUrls.has(url)) continue;
        const mime = imageMimeFor(entry);
        if (mime?.startsWith("image/")) {
          result.push({ type: "image-embed", url, encryption: entry.encryption, mime, dim: entry.dim, blurhash: entry.blurhash });
          renderedUrls.add(url);
        } else if (mime?.startsWith("audio/") || mime?.startsWith("video/")) {
          result.push({ type: "media-embed", url, encryption: entry.encryption, mime });
          renderedUrls.add(url);
        }
      }
    }

    // Collapse excessive whitespace around block-level tokens. `link-embed` is
    // deliberately excluded: it doesn't always render as a block (it becomes an
    // inline link inside quotes, and falls back to an inline <a> when no preview
    // data is available), so stripping the surrounding space would glue the URL
    // onto adjacent text (e.g. "new apk https://…" → "new apkhttps://…"). When
    // it does render as a preview card, the card is block-level, so a leftover
    // space in the preceding text is invisible anyway.
    for (let i = 0; i < result.length; i++) {
      const token = result[i];
      const isBlock = token.type === "image-embed" || token.type === "media-embed"
        || token.type === "nevent-embed"
        || (token.type === "naddr-embed" && !token.url) || token.type === "lightning-invoice"
        || token.type === "code-block" || token.type === "quote";

      if (isBlock) {
        if (i > 0) {
          const prev = result[i - 1];
          if (prev.type === "text") {
            prev.value = prev.value.replace(/\s+$/, "");
          }
        }
        if (i < result.length - 1) {
          const next = result[i + 1];
          if (next.type === "text") {
            next.value = next.value.replace(/^\s+/, "");
          }
        }
      }
    }

    // Trim leading/trailing whitespace from edge text tokens.
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

    // Filter out empty text tokens
    return result.filter((t) => !(t.type === "text" && t.value === ""));
  }, [event, contentOverride]);

  // Build emoji map for NIP-30 custom emoji rendering. Merge the event's own
  // emoji tags with the viewer's collection so shortcodes still render when
  // the published event omitted the tag.
  const { emojis: viewerEmojis } = useCustomEmojis();
  // Resolves `#channel` hashtags to local-channel navigation for the current
  // server/community (falls back to a Ditto hashtag link when unmatched).
  const channelNav = useChannelNav();
  const emojiMap = useMemo(() => {
    const map = buildEmojiMap(event.tags);
    for (const e of viewerEmojis) {
      if (!map.has(e.shortcode)) {
        map.set(e.shortcode, e.url);
      }
    }
    return map;
  }, [event.tags, viewerEmojis]);

  // Parse imeta tags — used for media poster/dim/waveform metadata
  const imetaMap = useMemo(() => parseImetaMap(event.tags), [event.tags]);

  // Group consecutive image-embed tokens (≥2) into image-gallery tokens
  const groupedTokens = useMemo(() => {
    const result: ContentToken[] = [];
    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];
      if (token.type === "image-embed") {
        const run: ImageRef[] = [{ url: token.url, encryption: token.encryption, mime: token.mime, dim: token.dim, blurhash: token.blurhash }];
        let j = i + 1;
        while (j < tokens.length && tokens[j].type === "image-embed") {
          const t = tokens[j] as Extract<ContentToken, { type: "image-embed" }>;
          run.push({ url: t.url, encryption: t.encryption, mime: t.mime, dim: t.dim, blurhash: t.blurhash });
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

  // Collect all inline image refs (in order) for the shared lightbox
  const allImages = useMemo<ImageRef[]>(
    () =>
      groupedTokens.flatMap((t) => {
        if (t.type === "image-embed") return [{ url: t.url, encryption: t.encryption, mime: t.mime, dim: t.dim, blurhash: t.blurhash }];
        if (t.type === "image-gallery") return t.urls;
        return [];
      }),
    [groupedTokens],
  );

  // Shared lightbox state for inline images
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

  // Map from grouped token index → starting image list index
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

  // Emoji-only messages render extra large
  const isEmojiOnly = groupedTokens.length === 1
    && groupedTokens[0].type === "text"
    && isOnlyEmojisOrCustom(groupedTokens[0].value, emojiMap);

  // Plain <a> for a URL (also the demoted rendering for media/embeds inside
  // quote blocks, where cards would be visually wrong).
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

  /**
   * Render one token. `topIndex` is the token's index in `groupedTokens`
   * (drives lightbox image indexing; null inside quotes). Inside quotes,
   * block-level media/embed tokens demote to inline links.
   */
  const renderToken = (token: ContentToken, key: React.Key, topIndex: number | null, inQuote = false): ReactNode => {
    switch (token.type) {
      case "text": {
        const imgClass = isEmojiOnly ? "inline h-10 w-10 object-contain align-text-bottom" : undefined;
        return (
          <span key={key}>
            {renderInlineMarkdown(
              token.value,
              (leaf) => highlightText(leaf, highlight, emojiMap, imgClass),
              `${key}-`,
            )}
          </span>
        );
      }
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
            {token.tokens.map((t, j) => renderToken(t, `${key}-q${j}`, null, true))}
          </blockquote>
        );
      case "image-embed": {
        if (inQuote) return inlineLink(key, token.url);
        const imgIndex = topIndex !== null ? tokenImageIndex.get(topIndex) ?? 0 : 0;
        return (
          <InlineImage
            key={key}
            image={{ url: token.url, encryption: token.encryption, mime: token.mime, dim: token.dim, blurhash: token.blurhash }}
            onClick={(e) => {
              e.stopPropagation();
              setLightboxIndex(imgIndex);
            }}
          />
        );
      }
      case "image-gallery": {
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
        if (inQuote) return inlineLink(key, token.url);
        return <LinkEmbed key={key} url={token.url} className="my-1.5" />;
      case "inline-link":
        return inlineLink(key, token.url);
      case "media-embed": {
        if (inQuote) return inlineLink(key, token.url);
        const imeta = imetaMap.get(token.url);
        // Effective MIME: token/imeta `m` (ignoring uninformative
        // octet-stream), else derived from the URL extension. This types the
        // decrypted Blob and the <source>, both of which refuse to play as
        // application/octet-stream.
        const ext = extOfUrl(token.url);
        const extMime = ext ? usableMime(mimeFromExt(ext)) : undefined;
        const mediaMime = usableMime(token.mime) ?? usableMime(imeta?.mime) ?? extMime;
        const mime = mediaMime ?? "";
        // Encrypted (Concord/Vector) attachments must be fetched + decrypted
        // before the <audio>/<video> element can play them. Fall back to the
        // imeta entry for tokens created by pure extension match.
        const encryption = token.encryption ?? imeta?.encryption;
        const isXdc = mime === "application/x-webxdc"
          || /\.xdc(\?[^\s]*)?$/i.test(token.url);
        if (isXdc) {
          return <XdcAttachment key={key} url={token.url} imeta={imeta} />;
        }
        const isAudio = mime.startsWith("audio/") || AUDIO_EXT_URL_REGEX.test(token.url);
        if (isAudio) {
          const waveform = imeta ? getImetaField(event.tags, token.url, "waveform") : undefined;
          const duration = imeta ? getImetaField(event.tags, token.url, "duration") : undefined;
          return (
            <AudioMessage
              key={key}
              src={token.url}
              mime={mediaMime}
              encryption={encryption}
              waveform={waveform}
              duration={duration}
            />
          );
        }
        return (
          <VideoPlayer
            key={key}
            src={token.url}
            poster={imeta?.thumbnail}
            dim={imeta?.dim}
            mime={mediaMime}
            encryption={encryption}
          />
        );
      }
      case "nevent-embed": {
        if (disableNoteEmbeds || inQuote) {
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
          />
        );
      }
      case "naddr-embed": {
        if (disableNoteEmbeds || inQuote) {
          return <TruncatedNostrLink key={key} encode={() => nip19.naddrEncode(token.addr)} />;
        }
        return (
          <span key={key}>
            {token.url && (
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
            <EmbeddedNaddr addr={token.addr} />
          </span>
        );
      }
      case "mention":
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
        // A hashtag that names a channel in the current server/community
        // navigates to that local channel; otherwise it links out to Ditto's
        // global hashtag feed.
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
    }
  };

  const body = (
    <div dir="auto" className={cn("whitespace-pre-wrap break-words overflow-hidden", className, isEmojiOnly && "text-4xl leading-tight")}>
      {groupedTokens.map((token, i) => renderToken(token, i, i))}

      {lightboxIndex !== null && (
        <Lightbox
          images={allImages}
          currentIndex={lightboxIndex}
          onClose={closeLightbox}
          onNext={goNext}
          onPrev={goPrev}
        />
      )}
    </div>
  );

  // Long-message collapse ("Read more"): only for top-level message bodies —
  // nested embeds (disableNoteEmbeds, quoted notes) already get their own
  // fixed-height clamp from the embedding card, and /me action overrides
  // render inline (a wrapping block div here would break that flow). Gated on
  // the raw content length rather than the tokenized/rendered output, so it's
  // cheap to check before doing any of the render work above.
  const collapsible = !disableNoteEmbeds && contentOverride === undefined
    && (contentOverride ?? event.content).length > COLLAPSE_CHAR_THRESHOLD;

  if (!collapsible) return body;

  return <CollapsibleContent>{body}</CollapsibleContent>;
}

/**
 * Wraps a rendered message body, clamping it to a fixed height with a
 * fade-out + "Read more" toggle when it overflows. Measures the actual
 * rendered height (rather than trusting the character-count heuristic that
 * gated this wrapper) so short-but-tall content (many short lines, a big
 * embed) still collapses, and long-but-short content (one giant URL) doesn't
 * show a pointless toggle.
 */
function CollapsibleContent({ children }: { children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(true);
  const innerRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = innerRef.current;
    if (el) setOverflowing(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 1);
  }, []);

  // Re-measure after mount/layout (images, link previews, etc. can resize the
  // content asynchronously as they load, which changes whether it overflows).
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
          className="relative mt-1 text-xs font-semibold text-primary hover:underline"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}

/** Extract the lowercase file extension from a URL's path, or undefined when there is none. */
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

/** Read a named field (e.g. `waveform`, `duration`) from the imeta tag for a URL. */
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

/** Inline image thumbnail that opens the shared lightbox on click. */
function InlineImage({ image, onClick }: { image: ImageRef; onClick: (e: React.MouseEvent) => void }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const resolved = useResolvedMediaSrc(image);

  if (failed || resolved.status === "error") {
    return (
      <a
        href={image.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {image.url}
      </a>
    );
  }

  const aspectRatio = parseDimAspectRatio(image.dim);

  return (
    <button
      type="button"
      className="block my-1.5 rounded-lg overflow-hidden max-w-sm cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onClick={onClick}
    >
      <div
        className={cn("relative rounded-lg overflow-hidden", !loaded && !image.blurhash && "bg-muted")}
        style={
          !loaded
            ? { aspectRatio, minHeight: aspectRatio ? undefined : 120, minWidth: 160 }
            : undefined
        }
      >
        {!loaded && image.blurhash && (
          <BlurhashCanvas hash={image.blurhash} className="absolute inset-0" />
        )}
        {resolved.status === "ready" && (
          <img
            src={resolved.src}
            alt=""
            className={cn(
              "block max-w-full max-h-80 h-auto rounded-lg hover:opacity-90 transition-opacity",
              !loaded && aspectRatio && "absolute inset-0 w-full h-full object-cover",
            )}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </button>
  );
}

/** Compact grid for multiple consecutive images, sharing the lightbox. */
function ImageGrid({ images, onOpen }: { images: ImageRef[]; onOpen: (index: number) => void }) {
  const visible = images.slice(0, 4);
  const extra = images.length - visible.length;

  return (
    <div className="grid grid-cols-2 gap-1 my-1.5 max-w-sm">
      {visible.map((image, i) => (
        <button
          key={i}
          type="button"
          className="relative aspect-square rounded-lg overflow-hidden bg-muted cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(i);
          }}
        >
          <GridImage image={image} />
          {i === visible.length - 1 && extra > 0 && (
            <span className="absolute inset-0 bg-black/60 flex items-center justify-center text-white text-lg font-semibold">
              +{extra}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/** A single grid cell image, decrypting on display when encrypted. */
function GridImage({ image }: { image: ImageRef }) {
  const [loaded, setLoaded] = useState(false);
  const resolved = useResolvedMediaSrc(image);
  return (
    <>
      {!loaded && image.blurhash && (
        <BlurhashCanvas hash={image.blurhash} className="absolute inset-0" />
      )}
      {resolved.status === "ready" && (
        <img
          src={resolved.src}
          alt=""
          loading="lazy"
          onLoad={() => setLoaded(true)}
          className="absolute inset-0 w-full h-full object-cover hover:opacity-90 transition-opacity"
        />
      )}
    </>
  );
}

/** Parses a NIP-94 `dim` string ("WxH") into a CSS `aspect-ratio` value. */
function parseDimAspectRatio(dim: string | undefined): string | undefined {
  if (!dim) return undefined;
  const [w, h] = dim.split("x").map(Number);
  if (!w || !h || Number.isNaN(w) || Number.isNaN(h)) return undefined;
  return `${w} / ${h}`;
}

/** Mention chip resolving the profile's display name. */
function NostrMention({ pubkey, noAtPrefix = false }: { pubkey: string; noAtPrefix?: boolean }) {
  const author = useAuthor(pubkey);
  const scopedName = useScopedDisplayName(pubkey, author.data?.metadata);
  const hasRealName = !!(author.data?.metadata?.name || author.data?.metadata?.display_name)
    || scopedName !== getDisplayName(author.data?.metadata, pubkey);
  const displayName = scopedName;

  return (
    <span
      className={cn(
        "font-medium",
        hasRealName ? "text-primary" : "text-muted-foreground",
      )}
      title={pubkey}
    >
      {noAtPrefix ? "" : "@"}{displayName}
    </span>
  );
}

/** Truncated external link for nested nostr references inside embedded cards. */
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

/** Compact copyable chip for BOLT11 lightning invoices. */
function LightningInvoice({ invoice }: { invoice: string }) {
  const [copied, setCopied] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  const { activeConnection, payWithNWC, webln } = useWallet();
  const { toast } = useToast();
  const canPay = Boolean(activeConnection || webln);

  const handlePay = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (paying || paid) return;
    setPaying(true);
    try {
      if (activeConnection) {
        await payWithNWC(invoice);
      } else {
        await webln!.enable();
        await webln!.sendPayment(invoice);
      }
      setPaid(true);
      toast({ title: "Invoice paid ⚡" });
    } catch (err) {
      toast({
        title: "Payment failed",
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
        className="inline-flex items-center gap-1.5 min-w-0 px-2.5 py-1 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-500 text-xs hover:bg-amber-500/20 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          writeClipboardText(invoice).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }, () => undefined);
        }}
        title="Copy lightning invoice"
      >
        <span aria-hidden>⚡</span>
        <span className="truncate font-mono">{invoice.slice(0, 24)}…</span>
        <span className="shrink-0">{copied ? "Copied!" : "Copy"}</span>
      </button>
      {canPay && (
        <button
          type="button"
          className="shrink-0 px-2.5 py-1 rounded-full border border-amber-500 bg-amber-500/20 text-amber-500 text-xs font-medium hover:bg-amber-500/30 transition-colors disabled:opacity-60"
          onClick={handlePay}
          disabled={paying || paid}
          title="Pay with your connected wallet"
        >
          {paid ? "Paid ✓" : paying ? "Paying…" : "Pay"}
        </button>
      )}
    </span>
  );
}
