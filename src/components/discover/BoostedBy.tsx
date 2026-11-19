import { Gem } from "lucide-react";

import { DisplayName } from "@/components/DisplayName";
import { UserAvatar } from "@/components/UserAvatar";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { useAuthor } from "@/hooks/useAuthor";
import { FormattedMessage, useIntl } from "@/i18n";
import { boostLevel, type Boost } from "@/lib/discoverBoost";
import { getDisplayName } from "@/lib/getDisplayName";
import { cn } from "@/lib/utils";

const SHOWN_BOOSTERS = 3;

/** Boost pink. */
export const BOOST_COLOR = "text-[#ff73fa]";

/** "Lv 2", once a community reaches a level. */
export function BoostLevelChip({ count, className }: { count: number; className?: string }) {
  const intl = useIntl();
  const { level } = boostLevel(count);
  if (level === 0) return null;
  return (
    <span
      title={intl.formatMessage({ id: "boostedBy.levelTitle", defaultMessage: "Boost level {level}" }, { level })}
      className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-full bg-[#ff73fa]/15 px-1.5 py-0.5 text-3xs font-semibold", BOOST_COLOR, className)}
    >
      <Gem className="size-2.5" aria-hidden />
      <FormattedMessage id="boostedBy.level" defaultMessage="Lv {level}" values={{ level }} />
    </span>
  );
}

/**
 * "Boosted by Alice and 4 others", naming someone the viewer trusts (`named`);
 * without one, just the count.
 */
export function BoostedBy({ boosts, named, showLevel = true }: { boosts: Boost[]; named: Boost[]; showLevel?: boolean }) {
  const first = named[0]?.pubkey;
  const author = useAuthor(first);
  const name = first ? getDisplayName(author.data?.metadata, first) : "";
  const label = (
    <>
      <Gem className={cn("size-3.5 shrink-0", BOOST_COLOR)} />
      {first && (
        <span className="flex shrink-0 -space-x-1.5">
          {named.slice(0, SHOWN_BOOSTERS).map((b) => (
            <UserAvatar
              key={b.pubkey}
              pubkey={b.pubkey}
              className="size-4 ring-1 ring-card"
              fallbackClassName="text-monogram"
              frame={false}
            />
          ))}
        </span>
      )}
      <span className="truncate">
        {first ? (
          <FormattedMessage
            id="boostedBy.named"
            defaultMessage="{others, plural, =0 {Boosted by {name}} one {Boosted by {name} and # other} other {Boosted by {name} and # others}}"
            values={{ name: <DisplayName pubkey={first} name={name} />, others: boosts.length - 1 }}
          />
        ) : (
          <FormattedMessage
            id="boostedBy.count"
            defaultMessage="{count, plural, one {# boost} other {# boosts}}"
            values={{ count: boosts.length }}
          />
        )}
      </span>
      {showLevel && <BoostLevelChip count={boosts.length} />}
    </>
  );
  const className = "flex items-center gap-1.5 text-xs text-muted-foreground min-w-0";
  if (!first) return <p className={className}>{label}</p>;
  return (
    <ProfilePreviewCard pubkey={first}>
      <button type="button" className={cn(className, "hover:text-foreground")}>
        {label}
      </button>
    </ProfilePreviewCard>
  );
}
