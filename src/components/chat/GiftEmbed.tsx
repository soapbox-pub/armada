import { GiftBox } from "@/components/gift/GiftBox";
import { GiftStage } from "@/components/gift/GiftStage";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useStableNavigate } from "@/hooks/useStableNavigate";
import { FormattedMessage } from "@/i18n";
import { getDisplayName } from "@/lib/getDisplayName";
import { nameStyleCss } from "@/lib/ultra";
import { giftPath } from "@/lib/ultraGift";
import { cn } from "@/lib/utils";

const TITLE_STYLE = nameStyleCss("aurora");

/** Card for an Armada Ultra gift link; opening it lands on the in-app gift page. */
export function GiftEmbed({ from, className }: { from: string; className?: string }) {
  const navigate = useStableNavigate();
  const { user } = useCurrentUser();
  const author = useAuthor(from);
  const name = getDisplayName(author.data?.metadata, from);
  const path = giftPath(from);
  const own = user?.pubkey === from;

  return (
    <div className={cn("relative w-full max-w-sm overflow-hidden clip-corner-lg shadow-lg shadow-primary/20", className)}>
      <GiftStage stars={false} />
      <div className="relative flex items-center gap-4 p-4">
        <GiftBox className="size-16" rays={false} />
        <div className="min-w-0 flex-1">
          <div className="text-2xs font-semibold uppercase tracking-[0.2em] text-foreground/70">
            {own
              ? <FormattedMessage id="giftEmbed.fromYou" defaultMessage="A gift from you" />
              : <FormattedMessage id="giftEmbed.from" defaultMessage="A gift from {name}" values={{ name }} />}
          </div>
          <div className="truncate text-xl font-black tracking-tight" style={TITLE_STYLE}>Armada Ultra</div>
          {path && (
            <Button
              size="sm"
              className="mt-2 h-8 bg-gradient-to-r from-primary via-fuchsia-500 to-accent2 font-semibold text-white clip-corner-lg hover:brightness-110 touch:h-11"
              onClick={() => navigate(path)}
            >
              {own
                ? <FormattedMessage id="giftEmbed.view" defaultMessage="View" />
                : <FormattedMessage id="giftEmbed.open" defaultMessage="Open gift" />}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
