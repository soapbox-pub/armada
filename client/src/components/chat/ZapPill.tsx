import { Zap } from "lucide-react";
import { useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { getAvatarShape } from "@/lib/avatarShape";
import { formatSats } from "@/lib/zaps";
import { cn } from "@/lib/utils";

import type { ZapEntry, ZapTally } from "@/lib/zaps";

/** One zapper row (avatar + name + amount + comment) inside the detail popover. */
function ZapperRow({ zap }: { zap: ZapEntry }) {
  const author = useAuthor(zap.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(zap.pubkey, metadata);
  return (
    <div className="flex items-start gap-2 px-2 py-1">
      <Avatar shape={getAvatarShape(metadata)} className="size-5 shrink-0 mt-0.5">
        <AvatarImage src={metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-amber-500/20 text-amber-500 text-[9px]">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-xs truncate">{displayName}</span>
          <span className="text-xs font-semibold tabular-nums text-amber-500">
            {formatSats(zap.sats)}
          </span>
        </div>
        {zap.comment && (
          <p className="text-[11px] text-muted-foreground break-words">{zap.comment}</p>
        )}
      </div>
    </div>
  );
}

/**
 * The ⚡ total chip beside a message's reaction pills: amber, total sats,
 * popover listing each zapper with amount + comment, and a zap-again footer.
 */
export function ZapPill({
  tally,
  canZap,
  onZap,
}: {
  tally: ZapTally;
  canZap: boolean;
  onZap: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (tally.count === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm leading-none transition-colors",
            tally.mine
              ? "border-amber-500 bg-amber-500/20 text-amber-500"
              : "border-amber-500/40 bg-amber-500/10 text-amber-500 hover:border-amber-500/70 hover:bg-amber-500/20",
          )}
        >
          {/* Match the reaction pill's leading glyph EXACTLY: a 20px (h-5 w-5)
              box so the pills are the same height and line up, with a 16px
              bolt centered in it so the icon reads the same size as the ~16px
              (text-base) emoji beside it. */}
          <span className="inline-flex h-5 w-5 items-center justify-center">
            <Zap className="size-4 fill-current" />
          </span>
          <span className="tabular-nums font-medium">{formatSats(tally.totalSats)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64 p-0 rounded-xl border-border shadow-lg overflow-hidden"
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <Zap className="size-4 text-amber-500 fill-current" />
          <span className="text-xs text-muted-foreground">
            {formatSats(tally.totalSats)} sats · {tally.count} {tally.count === 1 ? "zap" : "zaps"}
          </span>
        </div>
        <div className="max-h-48 overflow-y-auto py-1">
          {tally.zaps.map((zap) => (
            <ZapperRow key={zap.id} zap={zap} />
          ))}
        </div>
        {canZap && (
          <div className="border-t border-border/60 p-1.5">
            <Button
              size="sm"
              variant="default"
              className="w-full h-7 rounded-lg text-xs"
              onClick={() => {
                setOpen(false);
                onZap();
              }}
            >
              <Zap className="size-3.5" /> Zap
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
