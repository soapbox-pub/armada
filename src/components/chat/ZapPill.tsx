import { Zap } from "lucide-react";
import { useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { getAvatarShape } from "@/lib/avatarShape";
import { formatSats } from "@/lib/zaps";
import { cn } from "@/lib/utils";
import { FormattedMessage } from "@/i18n";

import type { ZapEntry, ZapRail, ZapTally } from "@/lib/zaps";
import { AvatarInitial } from "@/components/AvatarInitial";

function RailIcon({ rail }: { rail: ZapRail }) {
  if (rail === "onchain") {
    return <span className="text-[13px] leading-none text-orange-500 font-bold">₿</span>;
  }
  return <Zap className="size-3.5 fill-current text-amber-500" />;
}

function ZapperRow({ zap }: { zap: ZapEntry }) {
  const author = useAuthor(zap.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(zap.pubkey, metadata);
  return (
    <div className="flex items-start gap-2.5 px-3 py-1.5">
      <Avatar shape={getAvatarShape(metadata)} className="size-5 shrink-0 mt-0.5">
        <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
        <AvatarFallback className="bg-amber-500/20 text-amber-500 text-monogram">
          <AvatarInitial name={displayName} />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs truncate">
            <DisplayName pubkey={zap.pubkey} name={displayName} />
          </span>
          <span className="text-xs font-semibold tabular-nums text-amber-500">
            {formatSats(zap.sats)}
          </span>
          <RailIcon rail={zap.rail} />
        </div>
        {zap.comment && (
          <p className="text-2xs text-muted-foreground break-words">{zap.comment}</p>
        )}
      </div>
    </div>
  );
}

/** The ⚡ total chip beside a message's reaction pills. */
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
            "flex items-center gap-1.5 rounded-full border px-2.5 py-1 touch:px-3.5 touch:py-2.5 text-sm leading-none transition-colors",
            tally.mine
              ? "border-amber-500 bg-amber-500/20 text-amber-500"
              : "border-amber-500/40 bg-amber-500/10 text-amber-500 hover:border-amber-500/70 hover:bg-amber-500/20",
          )}
        >
          {/* 20px box matching the reaction pill's glyph so pills line up. */}
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
        className="w-64 p-0 overflow-hidden"
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          <Zap className="size-4 text-amber-500 fill-current" />
          <span className="text-xs text-muted-foreground">
            <FormattedMessage
              id="zapPill.summary"
              defaultMessage="{sats} sats · {count, plural, one {# zap} other {# zaps}}"
              values={{ sats: formatSats(tally.totalSats), count: tally.count }}
            />
          </span>
        </div>
        <div className="max-h-52 overflow-y-auto py-0.5">
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
              <Zap className="size-3.5" /> <FormattedMessage id="zapPill.zap" defaultMessage="Zap" />
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
