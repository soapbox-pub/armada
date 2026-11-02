import { Check, ChevronRight, Copy, Download, IdCard, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Lightbox, type LightboxItem } from "@/components/chat/Lightbox";
import { CodeBlock } from "@/components/chat/Markdown";
import { renderInlineMarkdown } from "@/components/chat/markdownRender";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { useBlossomCandidates } from "@/hooks/useBlossomCandidates";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { toast } from "@/hooks/useToast";
import { common, defineMessages, FormattedMessage, t, useIntl, type MessageDescriptor } from "@/i18n";
import type { CharaCard, CharacterCardRef } from "@/lib/characterCard";
import { writeClipboardText } from "@/lib/clipboard";
import { downloadBinaryFile, savedDescription } from "@/lib/downloadFile";
import {
  decryptBuffer,
  fetchCapped,
  MAX_EXPLICIT_DECRYPT_BYTES,
  verifyPlaintextHash,
} from "@/lib/encryptedMedia";
import { safeFilename } from "@/lib/fileBytes";
import { splitMarkdownBlocks, type MdBlock, type MdList } from "@/lib/markdown";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";

/** The card PNG as a decorative image; the id-card glyph until it resolves (or if it fails). */
function CharacterCardArt({
  image,
  imgClassName,
  iconClassName,
  onArtClick,
}: {
  image: CharacterCardRef;
  imgClassName: string;
  iconClassName: string;
  /** Given, a resolved image offers the full-size preview; the fallback glyph doesn't. */
  onArtClick?: () => void;
}) {
  const { resolved, onError, failed } = useMediaWithFallback(image);
  const intl = useIntl();
  if (failed || resolved.status !== "ready") return <IdCard className={iconClassName} />;
  const img = (
    <img
      src={resolved.src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={onError}
      draggable={false}
      className={imgClassName}
    />
  );
  if (!onArtClick) return img;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onArtClick();
      }}
      aria-label={intl.formatMessage({ id: "characterCard.viewArtwork", defaultMessage: "View artwork full size" })}
      title={intl.formatMessage({ id: "characterCard.viewFullSize", defaultMessage: "View full size" })}
      className="block max-w-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      {img}
    </button>
  );
}

/** Frontends hide HTML comments from the reader (they're model-only), an unclosed one included. */
const HTML_COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
/** `mes_example`'s separator between example chats, on a line of its own. */
const START_RE = /^[ \t]*<START>[ \t]*$/im;
const MACRO_RE = /\{\{([^{}\n]{1,40})\}\}/g;

/** The card's prose as a frontend shows it: no comments, `{{char}}` filled in. */
function visibleText(text: string, name: string): string {
  return text.replace(HTML_COMMENT_RE, "").replace(/\{\{char\}\}/gi, name).trim();
}

/** Remaining macros (`{{user}}`, `{{original}}`, …) are filled by the frontend; mark them as such. */
function renderMacros(text: string): ReactNode {
  const parts = text.split(MACRO_RE);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 0 ? part : (
      <span key={i} className="rounded-sm bg-primary/15 px-1 font-mono text-[0.85em] text-primary">
        {part.trim()}
      </span>
    ),
  );
}

function CardList({ list, keyPrefix, depth }: { list: MdList; keyPrefix: string; depth: number }) {
  const items = list.items.map((item, j) => {
    const child = list.children?.[j];
    return (
      <li key={j}>
        {renderInlineMarkdown(item, renderMacros, `${keyPrefix}-${j}`)}
        {child && <CardList list={child} keyPrefix={`${keyPrefix}-${j}-l`} depth={depth + 1} />}
      </li>
    );
  });
  const className = cn("space-y-0.5 pl-5", depth > 0 && "mt-0.5");
  return list.ordered
    ? <ol start={list.start} className={cn("list-decimal", className)}>{items}</ol>
    : <ul className={cn(depth % 2 ? "list-[circle]" : "list-disc", className)}>{items}</ul>;
}

function CardBlocks({ blocks, keyPrefix }: { blocks: MdBlock[]; keyPrefix: string }) {
  return blocks.map((block, i) => {
    const key = `${keyPrefix}${i}`;
    switch (block.type) {
      case "code":
        return <CodeBlock key={key} code={block.code.replace(/\n$/, "")} lang={block.lang} />;
      case "quote":
        return (
          <div key={key} className="border-l-2 border-border pl-2.5 text-muted-foreground">
            <CardBlocks blocks={block.blocks} keyPrefix={`${key}-`} />
          </div>
        );
      case "heading":
        return <p key={key} className="font-semibold">{renderInlineMarkdown(block.text, renderMacros, key)}</p>;
      case "subtext":
        return <p key={key} className="text-xs text-muted-foreground">{renderInlineMarkdown(block.text, renderMacros, key)}</p>;
      case "list":
        return <CardList key={key} list={block} keyPrefix={key} depth={0} />;
      case "rule":
        return <hr key={key} className="my-2 border-border" />;
      case "text": {
        const text = block.text.replace(/^\n+|\n+$/g, "");
        if (!text) return null;
        return <p key={key} className="whitespace-pre-wrap">{renderInlineMarkdown(text, renderMacros, key)}</p>;
      }
    }
  });
}

/** Card prose rendered as chat markdown; `<START>` example chats are split by a rule. */
function CardProse({ text, name }: { text: string; name: string }) {
  const chats = visibleText(text, name).split(START_RE).map((chat) => chat.trim()).filter(Boolean);
  return chats.map((chat, i) => (
    <div key={i} className={cn("space-y-1.5", i > 0 && "mt-2 border-t border-border/60 pt-2")}>
      <CardBlocks blocks={splitMarkdownBlocks(chat)} keyPrefix={`${i}-`} />
    </div>
  ));
}

/** Copies a field's raw text, macros and comments intact, as a frontend would import it. */
function CopyFieldButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const intl = useIntl();
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(resetTimer.current), []);
  return (
    <button
      type="button"
      aria-label={label}
      title={intl.formatMessage(common.copy)}
      onClick={() => {
        writeClipboardText(text).then(
          () => {
            setCopied(true);
            clearTimeout(resetTimer.current);
            resetTimer.current = setTimeout(() => setCopied(false), 1500);
          },
          () => toast({ title: t({ id: "characterCard.copyFailed", defaultMessage: "Couldn't copy" }), variant: "destructive" }),
        );
      }}
      className="grid size-6 shrink-0 place-items-center clip-corner text-muted-foreground transition-colors hover:bg-secondary hover:text-primary touch:size-9"
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

interface SectionLabels {
  title: MessageDescriptor;
  /** The copy button's accessible name. */
  copy: MessageDescriptor;
}

const SECTIONS = {
  description: defineMessages({
    title: { id: "characterCard.description", defaultMessage: "Description" },
    copy: { id: "characterCard.copyDescription", defaultMessage: "Copy description" },
  }),
  personality: defineMessages({
    title: { id: "characterCard.personality", defaultMessage: "Personality" },
    copy: { id: "characterCard.copyPersonality", defaultMessage: "Copy personality" },
  }),
  scenario: defineMessages({
    title: { id: "characterCard.scenario", defaultMessage: "Scenario" },
    copy: { id: "characterCard.copyScenario", defaultMessage: "Copy scenario" },
  }),
  firstMessage: defineMessages({
    title: { id: "characterCard.firstMessage", defaultMessage: "First message" },
    copy: { id: "characterCard.copyFirstMessage", defaultMessage: "Copy first message" },
  }),
  examples: defineMessages({
    title: { id: "characterCard.examples", defaultMessage: "Example messages" },
    copy: { id: "characterCard.copyExamples", defaultMessage: "Copy example messages" },
  }),
  systemPrompt: defineMessages({
    title: { id: "characterCard.systemPrompt", defaultMessage: "System prompt" },
    copy: { id: "characterCard.copySystemPrompt", defaultMessage: "Copy system prompt" },
  }),
  postHistory: defineMessages({
    title: { id: "characterCard.postHistory", defaultMessage: "Post-history instructions" },
    copy: { id: "characterCard.copyPostHistory", defaultMessage: "Copy post-history instructions" },
  }),
  creatorNotes: defineMessages({
    title: { id: "characterCard.creatorNotes", defaultMessage: "Creator notes" },
    copy: { id: "characterCard.copyCreatorNotes", defaultMessage: "Copy creator notes" },
  }),
} satisfies Record<string, SectionLabels>;

const PROSE_BOX = "overflow-y-auto break-words clip-corner bg-secondary/30 px-3 py-2 text-sm leading-relaxed text-foreground/90";

/** One titled card field; empty fields don't render. Long bodies scroll inside their box. */
function CardSection({ section, text, name }: { section: SectionLabels; text?: string; name: string }) {
  const intl = useIntl();
  if (!text || !visibleText(text, name)) return null;
  return (
    <section className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          <FormattedMessage {...section.title} />
        </h3>
        <CopyFieldButton text={text} label={intl.formatMessage(section.copy)} />
      </div>
      <div className={cn("max-h-44", PROSE_BOX)}>
        <CardProse text={text} name={name} />
      </div>
    </section>
  );
}

function useCardDownload(card: CharaCard, image: CharacterCardRef) {
  // Deliberate open: fetched directly (never through the passive-display proxy).
  const candidates = useBlossomCandidates(image.url, image.fallbacks);
  const [busy, setBusy] = useState(false);
  const encryption = image.encryption;

  const download = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // The sender's PNG itself is the portable card (bytes carry the payload).
      const raw = await fetchCapped(candidates, { maxBytes: MAX_EXPLICIT_DECRYPT_BYTES });
      const bytes = encryption
        ? new Uint8Array(await decryptBuffer(raw, encryption.key, encryption.nonce))
        : new Uint8Array(raw);
      if (encryption) await verifyPlaintextHash(bytes, encryption.ox);
      const location = await downloadBinaryFile(`${safeFilename(card.name)}.png`, bytes);
      if (location) toast({ title: t({ id: "characterCard.saved", defaultMessage: "Saved" }), description: savedDescription(location) });
    } catch {
      toast({ title: t({ id: "characterCard.downloadFailed", defaultMessage: "Download failed" }), description: card.name, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }, [busy, candidates, encryption, card.name]);

  return { download, busy };
}

const SPEC_LABELS: Record<CharaCard["spec"], MessageDescriptor> = defineMessages({
  v1: { id: "characterCard.specV1", defaultMessage: "Spec v1" },
  v2: { id: "characterCard.specV2", defaultMessage: "Spec v2" },
  v3: { id: "characterCard.specV3", defaultMessage: "Spec v3" },
});

const NOOP_NAV = () => { /* single image: nothing to navigate to */ };

function CharacterCardDialog({ card, image, onClose }: { card: CharaCard; image: CharacterCardRef; onClose: () => void }) {
  const { download, busy } = useCardDownload(card, image);
  const creator = card.creator?.trim();
  const intl = useIntl();
  const description = [
    intl.formatMessage(SPEC_LABELS[card.spec]),
    creator ? intl.formatMessage({ id: "characterCard.byCreator", defaultMessage: "by {creator}" }, { creator }) : undefined,
    card.character_version
      ? intl.formatMessage({ id: "characterCard.version", defaultMessage: "version {version}" }, { version: card.character_version })
      : undefined,
  ].filter(Boolean).join(" · ");
  const book = card.character_book;

  // Full-size art preview. Close requests aimed at the dialog (Esc / outside
  // pointer-down both fire from below the lightbox) are ignored while it is
  // up, so only the lightbox closes.
  const [viewArt, setViewArt] = useState(false);
  const closeArt = useCallback(() => setViewArt(false), []);
  const { url, mime, encryption, fallbacks } = image;
  const artMedia = useMemo<LightboxItem[]>(
    () => [{ url, mime, encryption, fallbacks }],
    [url, mime, encryption, fallbacks],
  );

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !viewArt) onClose(); }}>
      <ChromeDialogContent title={intl.formatMessage({ id: "characterCard.dialogTitle", defaultMessage: "Character card: {name}" }, { name: card.name })} className="sm:max-w-xl">
        <ChromeDialogHeader icon={IdCard} title={<span className="normal-case">{card.name}</span>} description={description} />

        <div className="mt-4 flex justify-center">
          <CharacterCardArt
            image={image}
            imgClassName="max-h-52 rounded-lg object-contain transition-opacity hover:opacity-90"
            iconClassName="size-10 text-muted-foreground/40"
            onArtClick={() => setViewArt(true)}
          />
        </div>

        {viewArt && (
          <Lightbox
            media={artMedia}
            currentIndex={0}
            onClose={closeArt}
            onNext={NOOP_NAV}
            onPrev={NOOP_NAV}
            // z above dialogs (z-250), and pointer-events re-enabled: the modal
            // dialog sets `pointer-events: none` on body, which the portaled
            // lightbox would otherwise inherit with dead buttons.
            className="z-[300] pointer-events-auto"
          />
        )}

        {card.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {card.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-2xs font-medium">{tag}</Badge>
            ))}
          </div>
        )}

        <div className="mt-4 space-y-3 min-w-0">
          <CardSection section={SECTIONS.description} text={card.description} name={card.name} />
          <CardSection section={SECTIONS.personality} text={card.personality} name={card.name} />
          <CardSection section={SECTIONS.scenario} text={card.scenario} name={card.name} />
          <CardSection section={SECTIONS.firstMessage} text={card.first_mes} name={card.name} />

          {card.alternate_greetings.length > 0 && (
            <section className="space-y-1">
              <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                <FormattedMessage
                  id="characterCard.alternateGreetings"
                  defaultMessage="Alternate greetings · {count}"
                  values={{ count: card.alternate_greetings.length }}
                />
              </h3>
              <ol className="space-y-1.5">
                {card.alternate_greetings.map((greeting, i) => (
                  <li key={i} className={cn("relative max-h-44 pr-9 touch:pr-11", PROSE_BOX)}>
                    <span className="text-2xs font-semibold text-muted-foreground tabular-nums">#{i + 1}</span>
                    <CardProse text={greeting} name={card.name} />
                    <div className="absolute right-1 top-1">
                      <CopyFieldButton
                        text={greeting}
                        label={intl.formatMessage({ id: "characterCard.copyGreeting", defaultMessage: "Copy greeting {number}" }, { number: i + 1 })}
                      />
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          )}

          <CardSection section={SECTIONS.examples} text={card.mes_example} name={card.name} />
          <CardSection section={SECTIONS.systemPrompt} text={card.system_prompt} name={card.name} />
          <CardSection section={SECTIONS.postHistory} text={card.post_history_instructions} name={card.name} />
          <CardSection section={SECTIONS.creatorNotes} text={card.creator_notes} name={card.name} />

          {book && book.entries.length > 0 && (
            <section className="space-y-1">
              <h3 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                <FormattedMessage
                  id="characterCard.characterBook"
                  defaultMessage="Character book · {count} {count, plural, one {entry} other {entries}}"
                  values={{ count: book.entries.length }}
                />
              </h3>
              <ul className="space-y-1.5">
                {book.entries.slice(0, 10).map((entry, i) => (
                  <li key={i} className="clip-corner bg-secondary/30 px-3 py-2">
                    <p className="truncate text-xs font-medium text-foreground">
                      {entry.name ||
                        entry.keys.join(", ") ||
                        intl.formatMessage({ id: "characterCard.entryNumber", defaultMessage: "Entry {number}" }, { number: i + 1 })}
                      {!entry.enabled && (
                        <span className="ml-1.5 text-muted-foreground">
                          <FormattedMessage id="characterCard.disabled" defaultMessage="(disabled)" />
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground line-clamp-3">
                      {renderMacros(visibleText(entry.content, card.name))}
                    </p>
                  </li>
                ))}
              </ul>
              {book.entries.length > 10 && (
                <p className="text-xs text-muted-foreground">
                  <FormattedMessage
                    id="characterCard.moreEntries"
                    defaultMessage="…and {count} more in the download."
                    values={{ count: book.entries.length - 10 }}
                  />
                </p>
              )}
            </section>
          )}
        </div>

        <ChromeDialogFooter className="mt-5">
          <Button type="button" onClick={() => void download()} disabled={busy} className="gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            <FormattedMessage id="characterCard.download" defaultMessage="Download card" />
          </Button>
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}

/**
 * The footer row of an in-chat character card: names the card and opens the
 * full explorer. The parent frames it under the card's art; pass `open` /
 * `onOpenChange` when the art should open the same explorer.
 */
export function CharacterCardEmbed({
  card,
  image,
  open: openProp,
  onOpenChange,
  className,
}: {
  card: CharaCard;
  image: CharacterCardRef;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const creator = card.creator?.trim();
  const intl = useIntl();

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={intl.formatMessage({ id: "characterCard.view", defaultMessage: "View character card: {name}" }, { name: card.name })}
        className={cn(
          "group flex w-full items-center gap-2.5 px-3 py-2 text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
          className,
        )}
      >
        <IdCard className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold leading-tight">{card.name}</span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {creator ? (
              <FormattedMessage id="characterCard.embedByCreator" defaultMessage="Character card · by {creator}" values={{ creator }} />
            ) : (
              <FormattedMessage id="characterCard.embed" defaultMessage="Character card" />
            )}
          </span>
        </span>
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
          aria-hidden
        />
      </button>
      {open && <CharacterCardDialog card={card} image={image} onClose={() => setOpen(false)} />}
    </>
  );
}
