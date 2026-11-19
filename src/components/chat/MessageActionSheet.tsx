import { ChevronDown, Shield, SmilePlus } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";

import { ReactionGlyph } from "@/components/chat/ReactionBar";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { useOverlayBack } from "@/hooks/useAndroidBack";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { recordReaction } from "@/hooks/useFrequentReactions";
import { useQuickReactions } from "@/hooks/useQuickReactionList";
import { QUICK_SLOTS_SHEET, toggleInput } from "@/lib/reactionToggle";
import { cn } from "@/lib/utils";
import { FormattedMessage, useIntl } from "@/i18n";

import type { MessageActionItem } from "@/components/chat/messageActions";
import type { ReactInput, ReactionTally } from "@/hooks/useReactions";

/**
 * Window after opening in which an outside-dismiss is refused: the opening
 * press leaves a trailing event read as an outside tap. Refused here so vaul
 * never commits the close and the controlled `open` can't desync.
 */
const OPEN_GUARD_MS = 400;

const LazyEmojiPicker = lazy(() =>
  import("@/components/chat/EmojiPicker").then((m) => ({ default: m.EmojiPicker })),
);

interface MessageActionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: MessageActionItem[];
  reactions?: {
    tallies: ReactionTally[];
    react: (input: ReactInput) => void;
  };
  /** Muted line under the actions: when it was sent, and with which client. */
  details?: string;
}

/**
 * Touch message menu: a bottom sheet with quick reactions over labelled action
 * rows. Replaces the hover toolbar on touch, which can't fit on a phone.
 */
export function MessageActionSheet({
  open,
  onOpenChange,
  actions,
  reactions,
  details,
}: MessageActionSheetProps) {
  // The picker takes over the sheet rather than nesting an overlay (like Discord).
  const [pickerOpen, setPickerOpen] = useState(false);
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { emojis: customEmojis } = useCustomEmojis();
  const frequent = useQuickReactions(user?.pubkey, QUICK_SLOTS_SHEET);
  const [moderationOpen, setModerationOpen] = useState(false);
  const main = actions.filter((a) => !a.moderation);
  const moderation = actions.filter((a) => a.moderation);
  // The sheet stays mounted between opens; each opening starts collapsed.
  useEffect(() => {
    if (!open) setModerationOpen(false);
  }, [open]);

  // Back closes only the sheet. Needed because SwipeReveal's handler would
  // otherwise slide the pane away with the (body-portalled) menu still up.
  useOverlayBack(() => {
    onOpenChange(false);
    return true;
  }, open);

  const openedAt = useRef(0);

  // Stamped during the opening render, NOT in an effect: an effect runs after
  // the layer is listening and would compare against the previous open's stale time.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) openedAt.current = Date.now();
    // Always reopen on the actions page.
    else setPickerOpen(false);
  }

  const react = useCallback(
    (key: string, url?: string, recorded = false) => {
      if (!reactions) return;
      const input = toggleInput(key, url, reactions.tallies);
      if (!input.mineEventId && !recorded) recordReaction(user?.pubkey, input.key, input.emojiUrl);
      reactions.react(input);
      onOpenChange(false);
    },
    [reactions, user?.pubkey, onOpenChange],
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        className="max-h-[85dvh]"
        // Refuse the opening gesture's trailing event so `open` stays in sync.
        onPointerDownOutside={(e) => {
          if (Date.now() - openedAt.current < OPEN_GUARD_MS) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (Date.now() - openedAt.current < OPEN_GUARD_MS) e.preventDefault();
        }}
      >
        <DrawerTitle className="sr-only">
          <FormattedMessage id="messageActionSheet.title" defaultMessage="Message actions" />
        </DrawerTitle>

        {pickerOpen ? (
          <div className="flex w-full flex-col pt-2 pb-[var(--safe-area-pad-bottom,0.75rem)]">
            <Suspense fallback={<div className="w-full" />}>
              <LazyEmojiPicker
                customEmojis={customEmojis}
                onBrowsePacks={() => onOpenChange(false)}
                onSelect={(selection) => {
                  // The picker has already counted it toward the frequent reactions.
                  if (selection.type === "native") react(selection.emoji, undefined, true);
                  else react(`:${selection.shortcode}:`, selection.url, true);
                }}
              />
            </Suspense>
          </div>
        ) : (
          <div className="overflow-y-auto overscroll-contain pt-2 pb-[var(--safe-area-pad-bottom,0.75rem)]">
            {reactions && (
              <div className="flex items-center gap-2 px-3 pb-2">
                <div className="flex flex-1 items-center gap-0.5 clip-corner-lg bg-muted/60 p-1">
                  {frequent.map((f) => {
                    const mine = reactions.tallies.find((t) => t.key === f.key)?.mine ?? false;
                    return (
                      <button
                        key={f.key}
                        type="button"
                        aria-label={mine
                          ? intl.formatMessage({ id: "messageActionSheet.removeReaction", defaultMessage: "Remove {emoji} reaction" }, { emoji: f.key })
                          : intl.formatMessage({ id: "messageActionSheet.reactWith", defaultMessage: "React with {emoji}" }, { emoji: f.key })}
                        aria-pressed={mine}
                        className={cn(
                          "flex size-11 flex-1 items-center justify-center clip-corner-lg transition-colors",
                          mine ? "bg-primary/20" : "active:bg-background",
                        )}
                        onClick={() => react(f.key, f.url)}
                      >
                        <ReactionGlyph
                          emojiKey={f.key}
                          url={f.url}
                          className="size-7 text-2xl"
                        />
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  aria-label={intl.formatMessage({ id: "messageActionSheet.addReaction", defaultMessage: "Add reaction" })}
                  className="flex size-12 shrink-0 items-center justify-center clip-corner-lg bg-muted/60 text-muted-foreground active:bg-secondary"
                  onClick={() => setPickerOpen(true)}
                >
                  <SmilePlus className="size-6" />
                </button>
              </div>
            )}

            <div className="px-2 pb-1">
              {main.map((action) => (
                <div key={action.id}>
                  {action.groupStart && <div className="mx-3 my-1.5 h-px bg-foreground/10" />}
                  <SheetActionRow action={action} onDone={() => onOpenChange(false)} />
                </div>
              ))}
              {moderation.length > 0 && (
                <>
                  {main.length > 0 && <div className="mx-3 my-1.5 h-px bg-foreground/10" />}
                  {/* One tap away from the everyday rows, so a slip can't hide, block or ban. */}
                  <button
                    type="button"
                    aria-expanded={moderationOpen}
                    className="flex min-h-11 w-full items-center gap-3 clip-corner px-3 py-2.5 text-left text-chat font-medium text-foreground active:bg-secondary"
                    onClick={() => setModerationOpen((o) => !o)}
                  >
                    <span className="flex size-10 shrink-0 items-center justify-center clip-corner-lg bg-secondary">
                      <Shield className="size-5 text-muted-foreground" />
                    </span>
                    <FormattedMessage id="messageActionSheet.moderation" defaultMessage="Moderation" />
                    <ChevronDown className={cn("ml-auto size-5 text-muted-foreground transition-transform", moderationOpen && "rotate-180")} />
                  </button>
                  {moderationOpen && (
                    <div className="ml-8 border-l border-foreground/10 pl-1">
                      {moderation.map((action) => (
                        <SheetActionRow key={action.id} action={action} onDone={() => onOpenChange(false)} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
            {details && (
              <p className="px-5 pt-1 pb-1 text-center text-2xs text-muted-foreground/70 tabular-nums select-text">
                {details}
              </p>
            )}
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

function SheetActionRow({ action, onDone }: { action: MessageActionItem; onDone: () => void }) {
  return (
    <button
      type="button"
      disabled={action.disabled}
      className={cn(
        "flex min-h-11 w-full items-center gap-3 clip-corner px-3 py-2.5 text-left text-chat font-medium active:bg-secondary disabled:opacity-50",
        action.destructive ? "text-destructive" : "text-foreground",
      )}
      onClick={() => {
        onDone();
        action.onSelect();
      }}
    >
      <span className="flex size-10 shrink-0 items-center justify-center clip-corner-lg bg-secondary">
        <action.icon className={cn("size-5", !action.destructive && "text-muted-foreground")} />
      </span>
      {action.label}
    </button>
  );
}
