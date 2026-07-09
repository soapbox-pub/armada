import { SmilePlus } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCustomEmojis } from "@/hooks/useCustomEmojis";
import { getAvatarShape } from "@/lib/avatarShape";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { cn } from "@/lib/utils";

import type { ReactInput, ReactionTally } from "@/hooks/useReactions";

/** Lazy-loaded EmojiPicker — keeps emoji-mart + its data out of the main bundle. */
const LazyEmojiPicker = lazy(() =>
  import("@/components/chat/EmojiPicker").then((m) => ({ default: m.EmojiPicker })),
);

interface ReactionBarProps {
  tallies: ReactionTally[];
  /** Whether the current user may toggle reactions (group membership). */
  canReact: boolean;
  onReact: (input: ReactInput) => void;
  /**
   * Optional node rendered first in the pill row (the zap total chip), so it
   * sits inline with the reaction pills instead of on its own line.
   */
  leading?: React.ReactNode;
}

/** Renders the visual content of a reaction key (custom image or emoji glyph). */
function ReactionGlyph({ tally, className }: { tally: ReactionTally; className?: string }) {
  const isCustom = tally.url && tally.key.startsWith(":") && tally.key.endsWith(":");
  if (isCustom) {
    return (
      <CustomEmojiImg
        name={tally.key.slice(1, -1)}
        url={tally.url!}
        className={cn("inline object-contain", className ?? "h-5 w-5")}
      />
    );
  }
  return (
    <span className={cn("inline-flex items-center justify-center leading-none -translate-y-px", className ?? "text-base")}>
      {tally.key}
    </span>
  );
}

/** A single reactor row (avatar + display name) inside the detail popover. */
function ReactorRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(pubkey, metadata);
  return (
    <div className="flex items-center gap-2 px-2 py-1">
      <Avatar shape={getAvatarShape(metadata)} className="size-5 shrink-0">
        <AvatarImage src={metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-[9px]">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="text-xs truncate">{displayName}</span>
    </div>
  );
}

/** A reaction pill that opens a popover listing reactors with a toggle button. */
function ReactionPill({
  tally,
  canReact,
  onReact,
}: {
  tally: ReactionTally;
  canReact: boolean;
  onReact: (input: ReactInput) => void;
}) {
  const [open, setOpen] = useState(false);

  const toggle = () =>
    onReact({
      key: tally.key,
      content: tally.key === "👍" ? "+" : tally.key,
      emojiUrl: tally.url,
    });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm leading-none transition-colors",
            tally.mine
              ? "border-primary bg-primary/15 text-primary"
              : "border-border/60 bg-secondary/40 text-foreground hover:border-foreground/40 hover:bg-secondary/70",
          )}
        >
          <ReactionGlyph tally={tally} className="h-5 w-5 text-base" />
          <span className="tabular-nums font-medium">{tally.count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-56 p-0 rounded-xl border-border shadow-lg overflow-hidden"
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <ReactionGlyph tally={tally} className="h-6 w-6 text-xl" />
          <span className="text-xs text-muted-foreground">
            {tally.count} {tally.count === 1 ? "reaction" : "reactions"}
          </span>
        </div>
        <div className="max-h-48 overflow-y-auto py-1">
          {tally.pubkeys.map((pubkey) => (
            <ReactorRow key={pubkey} pubkey={pubkey} />
          ))}
        </div>
        {canReact && (
          <div className="border-t border-border/60 p-1.5">
            <Button
              size="sm"
              variant={tally.mine ? "secondary" : "default"}
              className="w-full h-7 rounded-lg text-xs"
              onClick={() => {
                toggle();
                setOpen(false);
              }}
            >
              {tally.mine ? "Remove reaction" : "+1"}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Renders the NIP-25 reaction tally pills beneath a message. Each pill opens a
 * popover listing who reacted, with a button to add or remove the current
 * user's own reaction.
 */
export function ReactionBar({ tallies, canReact, onReact, leading }: ReactionBarProps) {
  if (tallies.length === 0 && !leading) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      {leading}
      {tallies.map((tally) => (
        <ReactionPill key={tally.key} tally={tally} canReact={canReact} onReact={onReact} />
      ))}
    </div>
  );
}

interface ReactionPickerProps {
  onReact: (input: ReactInput) => void;
}

/**
 * The "add reaction" trigger for a message's hover/tap action menu. Opens an
 * emoji picker popover (native + NIP-30 custom emoji) and publishes the
 * selected reaction.
 */
export function ReactionPicker({ onReact }: ReactionPickerProps) {
  const { emojis: customEmojis } = useCustomEmojis();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Add reaction"
              className="size-9 md:size-7 text-muted-foreground hover:text-primary"
            >
              <SmilePlus className="size-[18px] md:size-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Add reaction</TooltipContent>
      </Tooltip>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="flex w-[min(20rem,90vw)] h-[min(360px,55dvh)] max-h-[var(--radix-popover-content-available-height)] p-0 rounded-xl border-border shadow-lg overflow-hidden"
      >
        <Suspense fallback={<div className="w-full" />}>
          <LazyEmojiPicker
            customEmojis={customEmojis}
            onSelect={(selection) => {
              if (selection.type === "native") {
                onReact({ key: selection.emoji, content: selection.emoji });
              } else {
                onReact({
                  key: `:${selection.shortcode}:`,
                  content: `:${selection.shortcode}:`,
                  emojiUrl: selection.url,
                });
              }
              setOpen(false);
            }}
          />
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
