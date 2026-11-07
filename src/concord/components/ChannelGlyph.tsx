import { Hash, Lock, MessageSquareText, Volume2 } from "lucide-react";

import { cn } from "@/lib/utils";

import type { ChannelView } from "@/concord/lib/types";

/**
 * Channel glyph for every surface: hashtag, forum mark, or speaker (a voice
 * Channel or a live call). Private text is a padlock; a private forum or voice
 * Channel keeps its mark with a corner padlock.
 */
export function ChannelGlyph({
  isPrivate = false,
  view,
  occupied = false,
  className,
}: {
  isPrivate?: boolean;
  view?: ChannelView;
  occupied?: boolean;
  className?: string;
}) {
  if (occupied || (view === "voice" && !isPrivate)) return <Volume2 className={className} />;
  if (view === "forum" || view === "voice") {
    const Mark = view === "voice" ? Volume2 : MessageSquareText;
    if (!isPrivate) return <Mark className={className} />;
    return (
      <span className={cn("relative inline-flex shrink-0", className)}>
        <Mark className="size-full" />
        <span className="absolute -bottom-1 -right-1 inline-flex size-[62%] items-center justify-center rounded-full bg-background">
          <Lock className="size-[72%]" strokeWidth={2.75} />
        </span>
      </span>
    );
  }
  if (isPrivate) return <Lock className={className} />;
  return <Hash className={className} />;
}
