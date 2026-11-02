import { SmilePlus } from "lucide-react";
import { Fragment, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState } from "react";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { EmojiSourceFooter } from "@/components/chat/EmojiSourceFooter";
import { MediaHoldContext } from "@/components/chat/mediaHold";
import { usePointerOpened } from "@/components/chat/usePointerOpened";
import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { passThroughEscape } from "@/lib/passThroughEscape";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { recordReaction } from "@/hooks/useFrequentReactions";
import { useQuickReactions } from "@/hooks/useQuickReactionList";
import { useIsTouch } from "@/hooks/useIsMobile";
import { getAvatarShape } from "@/lib/avatarShape";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { isRenderableReactionKey } from "@/lib/customEmoji";
import { QUICK_SLOTS_POINTER, toggleInput } from "@/lib/reactionToggle";
import { cn } from "@/lib/utils";
import { FormattedMessage, useIntl } from "@/i18n";

import type { ReactInput, ReactionTally } from "@/hooks/useReactions";
import { AvatarInitial } from "@/components/AvatarInitial";

/** Lazy: keeps emoji-mart + its data out of the main bundle. */
const LazyEmojiPicker = lazy(() =>
  import("@/components/chat/EmojiPicker").then((m) => ({ default: m.EmojiPicker })),
);

/** Hover dwell before a pill's detail popover opens, and the grace on leave. */
const HOVER_OPEN_MS = 350;
const HOVER_CLOSE_MS = 120;

/** Press-and-hold duration that opens the detail popover on touch. */
const LONG_PRESS_MS = 450;

/** How far a finger may drift during a hold before it counts as a scroll. */
const LONG_PRESS_SLOP_PX = 10;

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Tabbable elements in DOM order (positive tabindex isn't used here). */
function tabbablesIn(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && el.getClientRects().length > 0,
  );
}

function focusAfter(from: HTMLElement, skip: HTMLElement) {
  // By document position: `from` may not be tabbable itself.
  const next = tabbablesIn(document).find(
    (el) =>
      !skip.contains(el) &&
      !from.contains(el) &&
      (from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
  );
  if (next) next.focus();
  else from.focus();
}

export function ReactionGlyph({
  emojiKey,
  url,
  className,
}: {
  emojiKey: string;
  url?: string;
  className?: string;
}) {
  // Junk keys (e.g. a raw URL) render as a placeholder, not a line of text.
  const shortcode = emojiKey.startsWith(":") && emojiKey.endsWith(":");
  const label = isRenderableReactionKey(emojiKey) || shortcode ? emojiKey : "❓";
  const glyphText = (
    <span className={cn("inline-flex items-center justify-center leading-none -translate-y-px", className ?? "text-base")}>
      {label}
    </span>
  );
  if (url) {
    return (
      <CustomEmojiImg
        name={shortcode ? emojiKey.slice(1, -1) : emojiKey}
        url={url}
        className={cn("inline object-contain", className ?? "h-5 w-5")}
        fallback={glyphText}
      />
    );
  }
  return glyphText;
}

/**
 * The custom-emoji image to show for a tally, and whose reaction named it. Under a
 * media hold (`mediaHold.ts`) only an unheld reactor's image counts, so a stranger
 * can't paint a shortcode regulars use; none left = the `:shortcode:` text.
 */
function useShownEmoji(tally: ReactionTally): { url?: string; source?: string } {
  const hold = useContext(MediaHoldContext);
  if (!hold) return { url: tally.url, source: tally.pubkeys[0] };
  if (!tally.urls) {
    return tally.url && tally.pubkeys.some((pk) => !hold.media(pk)) ? { url: tally.url, source: tally.pubkeys[0] } : {};
  }
  for (let i = 0; i < tally.pubkeys.length; i++) {
    const url = tally.urls[i];
    if (url && !hold.media(tally.pubkeys[i])) return { url, source: tally.pubkeys[i] };
  }
  return {};
}

function ReactorRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(pubkey, metadata);
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <Avatar shape={getAvatarShape(metadata)} className="size-5 shrink-0">
        <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-monogram">
          <AvatarInitial name={displayName} />
        </AvatarFallback>
      </Avatar>
      <span className="text-xs truncate">
        <DisplayName pubkey={pubkey} name={displayName} />
      </span>
    </div>
  );
}

function ReactionDetail({ tally }: { tally: ReactionTally }) {
  const shown = useShownEmoji(tally);
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <ReactionGlyph emojiKey={tally.key} url={shown.url} className="h-6 w-6 text-xl" />
        <span className="text-xs text-muted-foreground">
          <FormattedMessage
            id="reactionBar.count"
            defaultMessage="{count, plural, one {# reaction} other {# reactions}}"
            values={{ count: tally.count }}
          />
        </span>
      </div>
      <div className="max-h-48 overflow-y-auto py-1">
        {tally.pubkeys.map((pubkey) => (
          <ReactorRow key={pubkey} pubkey={pubkey} />
        ))}
      </div>
      {shown.url && <EmojiSourceFooter url={shown.url} authorPubkey={shown.source} />}
    </>
  );
}

/**
 * Click TOGGLES the reaction; the reactor list opens on hover dwell or touch
 * press-and-hold.
 */
function ReactionPill({
  tally,
  canReact,
  onReact,
}: {
  tally: ReactionTally;
  canReact: boolean;
  onReact: (input: ReactInput) => void;
}) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const isTouch = useIsTouch();
  const [open, setOpen] = useState(false);
  const shown = useShownEmoji(tally);

  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);
  // Keeps the click ending a long-press from also toggling.
  const longPressed = useRef(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Escape returns focus to the pill (an Anchor, so Radix has nothing to restore).
  const restoreFocus = useRef(false);
  const suppressFocusOpen = useRef(false);

  const clearTimer = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = null;
  };

  const scheduleOpen = () => {
    clearTimer(closeTimer);
    clearTimer(openTimer);
    openTimer.current = setTimeout(() => {
      setOpen(true);
    }, HOVER_OPEN_MS);
  };
  const scheduleClose = () => {
    clearTimer(openTimer);
    clearTimer(closeTimer);
    closeTimer.current = setTimeout(() => setOpen(false), HOVER_CLOSE_MS);
  };

  // Rows can unmount mid-gesture; clear pending timers.
  useEffect(
    () => () => {
      for (const ref of [openTimer, closeTimer, pressTimer]) {
        if (ref.current) clearTimeout(ref.current);
      }
    },
    [],
  );

  const toggle = () => {
    if (!canReact) return;
    // The shown image, so joining a pill never re-signs a held reactor's URL.
    const input = { ...toggleInput(tally.key, shown.url, [tally]), emojiUrl: shown.url };
    if (!input.mineEventId) recordReaction(user?.pubkey, input.key, input.emojiUrl);
    onReact(input);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* ANCHOR, not Trigger: a Trigger would open the popover on every toggle click. */}
      <PopoverAnchor asChild>
        <button
          type="button"
          aria-pressed={tally.mine}
          aria-label={intl.formatMessage(
            {
              id: "reactionBar.pillLabel",
              defaultMessage: "{emoji}, {count, plural, one {# reaction} other {# reactions}}",
            },
            { emoji: tally.key, count: tally.count },
          )}
          className={cn(
            // Keep the button as the pointer target: native selection/drag on the nested
            // glyph fires `pointercancel` and kills the long-press.
            "select-none [-webkit-touch-callout:none] [&_*]:pointer-events-none",
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 touch:px-3.5 touch:py-2.5 text-sm leading-none transition-colors",
            tally.mine
              ? "border-primary bg-primary/15 text-primary"
              : "border-border/60 bg-secondary/40 text-foreground hover:border-foreground/40 hover:bg-secondary/70",
            !canReact && "cursor-default",
          )}
          onClick={() => {
            if (longPressed.current) {
              longPressed.current = false;
              return;
            }
            toggle();
          }}
          onPointerEnter={(e) => {
            if (isTouch || e.pointerType === "touch") return;
            scheduleOpen();
          }}
          onPointerLeave={(e) => {
            if (isTouch || e.pointerType === "touch") return;
            scheduleClose();
          }}
          onPointerDown={(e) => {
            if (e.pointerType !== "touch") return;
            // The row's ContextMenu long-press and swipe-to-reply would fight this gesture.
            e.stopPropagation();
            longPressed.current = false;
            pressOrigin.current = { x: e.clientX, y: e.clientY };
            clearTimer(pressTimer);
            pressTimer.current = setTimeout(() => {
              longPressed.current = true;
              setOpen(true);
            }, LONG_PRESS_MS);
          }}
          onPointerUp={() => clearTimer(pressTimer)}
          onPointerCancel={() => clearTimer(pressTimer)}
          onPointerMove={(e) => {
            // Only a real drag cancels the hold (fingers never stay perfectly still).
            if (e.pointerType !== "touch" || !pressTimer.current) return;
            const origin = pressOrigin.current;
            if (!origin) return;
            if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > LONG_PRESS_SLOP_PX) {
              clearTimer(pressTimer);
            }
          }}
          onFocus={(e) => {
            // Keyboard focus opens like hover; a click's focus doesn't.
            if (suppressFocusOpen.current) return;
            try {
              if (!e.currentTarget.matches(":focus-visible")) return;
            } catch {
              return; // :focus-visible unsupported — skip the keyboard affordance
            }
            setOpen(true);
          }}
          onBlur={(e) => {
            if (!contentRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
          }}
          onKeyDown={(e) => {
            // The popover is portalled to <body>, so Tab steps into it explicitly.
            if (!open || e.key !== "Tab" || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
            const first = contentRef.current ? tabbablesIn(contentRef.current)[0] : undefined;
            if (!first) return;
            e.preventDefault();
            first.focus();
          }}
          ref={pillRef}
        >
          <ReactionGlyph emojiKey={tally.key} url={shown.url} className="h-5 w-5 text-base" />
          <span className="tabular-nums font-medium">{tally.count}</span>
        </button>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        ref={contentRef}
        // Never takes focus: it would scroll the timeline or steal the composer caret,
        // and an empty FocusScope swallows Tab.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          // Only when focus was on the pill or popover; don't steal the composer's caret.
          const active = document.activeElement;
          restoreFocus.current =
            !!active && (active === pillRef.current || !!contentRef.current?.contains(active));
          if (restoreFocus.current) return;
          // Let the same Escape still reach the composer (dropping a reply target).
          passThroughEscape(e);
          clearTimer(openTimer);
          clearTimer(closeTimer);
          setOpen(false);
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!restoreFocus.current) return;
          restoreFocus.current = false;
          if (document.activeElement === pillRef.current) return;
          suppressFocusOpen.current = true;
          pillRef.current?.focus();
          suppressFocusOpen.current = false;
        }}
        onFocusOutside={(e) => {
          if (e.target === pillRef.current) e.preventDefault();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
          const pill = pillRef.current;
          const items = tabbablesIn(e.currentTarget);
          if (!pill || items.length === 0) return;
          if (e.shiftKey && document.activeElement === items[0]) {
            e.preventDefault();
            pill.focus();
          } else if (!e.shiftKey && document.activeElement === items[items.length - 1]) {
            e.preventDefault();
            focusAfter(pill, e.currentTarget);
          }
        }}
        onPointerEnter={() => clearTimer(closeTimer)}
        onPointerLeave={() => {
          if (!isTouch) scheduleClose();
        }}
        className="w-56 p-0 overflow-hidden"
      >
        <ReactionDetail tally={tally} />
      </PopoverContent>
    </Popover>
  );
}

interface ReactionBarProps {
  tallies: ReactionTally[];
  canReact: boolean;
  onReact: (input: ReactInput) => void;
  /** Rendered first in the pill row (the zap total chip). */
  leading?: React.ReactNode;
}

/** NIP-25 tally pills; click toggles, hover/press-and-hold reveals who reacted. */
export function ReactionBar({ tallies, canReact, onReact, leading }: ReactionBarProps) {
  if (tallies.length === 0 && !leading) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 touch:gap-2 mt-1.5">
      {leading}
      {tallies.map((tally) => (
        <ReactionPill key={tally.key} tally={tally} canReact={canReact} onReact={onReact} />
      ))}
    </div>
  );
}

interface ReactionActionsProps {
  onReact: (input: ReactInput) => void;
  /** Current tallies, so repeating an existing reaction retracts it. */
  tallies?: ReactionTally[];
  /** Quick reactions before the picker; 0 in cramped surfaces (thread panel). */
  quickSlots?: number;
}

const NO_TALLIES: ReactionTally[] = [];

/**
 * Toggle-react with `key`, counting it toward the frequent reactions. Pass
 * `recorded` for a picker selection: the picker has already counted it.
 */
export function useToggleReact(onReact: (input: ReactInput) => void, tallies: ReactionTally[]) {
  const { user } = useCurrentUser();
  return useCallback(
    (key: string, url?: string, recorded = false) => {
      const input = toggleInput(key, url, tallies);
      if (!input.mineEventId && !recorded) recordReaction(user?.pubkey, input.key, input.emojiUrl);
      onReact(input);
    },
    [onReact, tallies, user?.pubkey],
  );
}

/** The emoji picker as a reaction chooser; `onPick` gets what the picker already counted. */
export function ReactionPickerPanel({
  onPick,
  onBrowsePacks,
  recordUsage,
}: {
  onPick: (key: string, url?: string) => void;
  onBrowsePacks: () => void;
  recordUsage?: boolean;
}) {
  const { emojis: customEmojis } = useCustomEmojis();
  return (
    <Suspense fallback={<div className="w-full" />}>
      <LazyEmojiPicker
        customEmojis={customEmojis}
        onBrowsePacks={onBrowsePacks}
        recordUsage={recordUsage}
        onSelect={(selection) => {
          if (selection.type === "native") onPick(selection.emoji);
          else onPick(`:${selection.shortcode}:`, selection.url);
        }}
      />
    </Suspense>
  );
}

/** Sizing shared by every popover that hosts {@link ReactionPickerPanel}. */
export const REACTION_PICKER_CLASS =
  "flex w-[min(20rem,90vw)] h-[min(360px,55dvh)] max-h-[var(--radix-popover-content-available-height)] p-0 overflow-hidden";

/** Toolbar reaction controls: most-used emoji for one-click reacting, then the picker. */
export function ReactionActions({
  onReact,
  tallies = NO_TALLIES,
  quickSlots = QUICK_SLOTS_POINTER,
}: ReactionActionsProps) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const pointerOpened = usePointerOpened();

  const frequent = useQuickReactions(user?.pubkey, quickSlots);
  const react = useToggleReact(onReact, tallies);

  return (
    <>
      {frequent.map((f) => {
        const mine = tallies.find((t) => t.key === f.key)?.mine ?? false;
        const button = (
          <Button
            variant="ghost"
            size="icon"
            aria-label={mine
              ? intl.formatMessage({ id: "reactionBar.removeReaction", defaultMessage: "Remove {emoji} reaction" }, { emoji: f.key })
              : intl.formatMessage({ id: "reactionBar.reactWith", defaultMessage: "React with {emoji}" }, { emoji: f.key })}
            aria-pressed={mine}
            className={cn(
              "size-9 md:size-7 touch:size-11 touch:md:size-11",
              mine ? "text-primary bg-primary/10" : "hover:bg-secondary",
            )}
            onClick={() => react(f.key, f.url)}
          >
            <ReactionGlyph
              emojiKey={f.key}
              url={f.url}
              className="h-[18px] w-[18px] md:h-4 md:w-4 text-base md:text-sm"
            />
          </Button>
        );
        // A native emoji is its own label; only a custom one needs its shortcode named.
        if (!f.url) return <Fragment key={f.key}>{button}</Fragment>;
        return (
          <Tooltip key={f.key}>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent>
              {mine
                ? intl.formatMessage({ id: "reactionBar.remove", defaultMessage: "Remove {emoji}" }, { emoji: f.key })
                : f.key}
            </TooltipContent>
          </Tooltip>
        );
      })}
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={intl.formatMessage({ id: "reactionBar.addReaction", defaultMessage: "Add reaction" })}
                className="size-9 md:size-7 touch:size-11 touch:md:size-11 text-muted-foreground hover:text-primary"
                {...pointerOpened.triggerProps}
              >
                <SmilePlus className="size-[18px] md:size-3.5" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{intl.formatMessage({ id: "reactionBar.addReaction", defaultMessage: "Add reaction" })}</TooltipContent>
        </Tooltip>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          className={REACTION_PICKER_CLASS}
          onCloseAutoFocus={pointerOpened.onCloseAutoFocus}
        >
          <ReactionPickerPanel
            onBrowsePacks={() => setOpen(false)}
            onPick={(key, url) => {
              react(key, url, true);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}
