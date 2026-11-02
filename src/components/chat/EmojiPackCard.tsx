import { Check, Link2, Loader2, Pencil, Plus, Smile, Trash2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Link } from "react-router-dom";

import { DisplayName } from "@/components/DisplayName";
import { CustomEmojiImg } from "@/components/chat/CustomEmoji";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { FallbackImage } from "@/components/ui/FallbackImage";
import {
  emojiPackAbout,
  emojiPackEntries,
  emojiPackName,
  emojiPackPicture,
  useAddEmojiPack,
  useHasEmojiPack,
  useRemoveEmojiPack,
} from "@/hooks/useEmojiPacks";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNaddrLink } from "@/hooks/useNaddrLink";
import { toast } from "@/hooks/useToast";
import { getAvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import { naddrPath } from "@/lib/naddrLink";
import { cn } from "@/lib/utils";
import { FormattedMessage, common, t, useIntl } from "@/i18n";

import type { NostrRumor } from "@/lib/nostrRumor";
import { AvatarInitial } from "@/components/AvatarInitial";

const EmojiPackDialog = lazy(() =>
  import("@/components/discover/EmojiPackDialog").then((m) => ({ default: m.EmojiPackDialog })),
);

/** How many emojis to show in the preview grid before "+N more". */
const PREVIEW_LIMIT = 16;
/** "Show more" step on the expanded page: packs are sender-controlled and can name thousands. */
export const EXPANDED_STEP = 200;

interface EmojiPackCardProps {
  event: NostrRumor;
  /** Show every emoji rather than the first {@link PREVIEW_LIMIT} (the pack's own page). */
  expanded?: boolean;
  className?: string;
}

/**
 * Preview card for a NIP-30 emoji pack (kind 30030): name, author, preview grid,
 * "Add" (to the kind-10030 list) and a copy of its `/<naddr>` link.
 */
export function EmojiPackCard({ event, expanded = false, className }: EmojiPackCardProps) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = getDisplayName(metadata, event.pubkey);

  const name = emojiPackName(event);
  const about = emojiPackAbout(event);
  const picture = emojiPackPicture(event);
  const identifier = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
  const entries = emojiPackEntries(event);

  const coord = `30030:${event.pubkey}:${identifier}`;
  const alreadyAdded = useHasEmojiPack(coord);
  const { mutateAsync: addPack, isPending: isAdding } = useAddEmojiPack();
  const { mutateAsync: removePack, isPending: isRemoving } = useRemoveEmojiPack();
  // Flip instantly on success rather than waiting for the list re-read.
  const [override, setOverride] = useState<"added" | "removed" | null>(null);
  const [editing, setEditing] = useState(false);
  const isOwn = !!user && user.pubkey === event.pubkey;

  const { naddr, copied, copy } = useNaddrLink(event);

  const [expandedLimit, setExpandedLimit] = useState(EXPANDED_STEP);
  const visible = entries.slice(0, expanded ? expandedLimit : PREVIEW_LIMIT);
  const extra = entries.length - visible.length;

  const onAdd = async () => {
    if (!user) {
      toast({ title: t({ id: "emojiPackCard.signInToAdd", defaultMessage: "Sign in to add emoji packs" }) });
      return;
    }
    try {
      await addPack({ pubkey: event.pubkey, identifier });
      setOverride("added");
    } catch (e) {
      toast({
        title: t({ id: "emojiPackCard.addFailed", defaultMessage: "Couldn't add pack" }),
        description: e instanceof Error
          ? e.message
          : t({ id: "emojiPackCard.publishFailed", defaultMessage: "Publishing failed." }),
        variant: "destructive",
      });
    }
  };

  const onRemove = async () => {
    try {
      await removePack({ coord });
      setOverride("removed");
      toast({ title: t({ id: "emojiPackCard.removed", defaultMessage: "Emoji pack removed" }), description: name });
    } catch (e) {
      toast({
        title: t({ id: "emojiPackCard.removeFailed", defaultMessage: "Couldn't remove pack" }),
        description: e instanceof Error
          ? e.message
          : t({ id: "emojiPackCard.publishFailed", defaultMessage: "Publishing failed." }),
        variant: "destructive",
      });
    }
  };

  const isAdded = override ? override === "added" : alreadyAdded;

  return (
    <div
      className={cn(
        "flex flex-col max-w-sm w-full clip-hairline-lg [--edge:var(--border)/0.6] [--fill:var(--card)] [--fill-hover:var(--card)] overflow-hidden my-1.5",
        className,
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3.5 py-3 flex flex-col flex-1 gap-2.5">
        <div className="flex items-center gap-2 min-w-0">
          {picture ? (
            <FallbackImage
              src={picture}
              className="size-8 shrink-0 clip-corner object-cover"
              fallback={<Smile className="size-4 shrink-0 text-primary" />}
            />
          ) : (
            <Smile className="size-4 shrink-0 text-primary" />
          )}
          {naddr ? (
            <Link
              to={naddrPath(naddr)}
              className="font-semibold truncate leading-tight flex-1 hover:underline"
            >
              {name}
            </Link>
          ) : (
            <p className="font-semibold truncate leading-tight flex-1">{name}</p>
          )}
          <span
            className={cn(
              "text-3xs px-1.5 py-px rounded-full shrink-0",
              isAdded ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground",
            )}
          >
            {isAdded ? (
              <FormattedMessage id="emojiPackCard.added" defaultMessage="Added" />
            ) : (
              <FormattedMessage id="emojiPackCard.emojiPack" defaultMessage="Emoji pack" />
            )}
          </span>
        </div>

        {about && (
          <p className="text-xs text-muted-foreground line-clamp-2 -mt-1">{about}</p>
        )}

        <ProfilePreviewCard pubkey={event.pubkey}>
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground min-w-0"
            onClick={(e) => e.stopPropagation()}
          >
            <Avatar shape={getAvatarShape(metadata)} className="size-4 shrink-0">
              <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-monogram">
                <AvatarInitial name={displayName} />
              </AvatarFallback>
            </Avatar>
            <span className="truncate">
              <FormattedMessage
                id="emojiPackCard.byAuthor"
                defaultMessage="by {name}"
                values={{ name: <DisplayName pubkey={event.pubkey} name={displayName} /> }}
              />
            </span>
          </button>
        </ProfilePreviewCard>

        {visible.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {visible.map((e) => (
              <CustomEmojiImg
                key={e.shortcode}
                name={e.shortcode}
                url={e.url}
                className="h-7 w-7 object-contain"
              />
            ))}
            {extra > 0 && !expanded && (
              <span className="flex h-7 min-w-7 items-center justify-center rounded px-1 text-xs font-medium text-muted-foreground">
                +{extra}
              </span>
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            <FormattedMessage id="emojiPackCard.empty" defaultMessage="This pack has no emojis." />
          </p>
        )}
        {expanded && extra > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start text-muted-foreground touch:h-11"
            onClick={() => setExpandedLimit((limit) => limit + EXPANDED_STEP)}
          >
            <FormattedMessage
              id="emojiPackCard.showMore"
              defaultMessage="Show {step} more ({hidden} hidden)"
              values={{ step: Math.min(extra, EXPANDED_STEP), hidden: extra }}
            />
          </Button>
        )}

        {/* Pinned to the bottom so grid cards align. */}
        <div className="mt-auto flex items-center gap-2">
          {isAdded ? (
            <Button
              variant="ghost"
              className="flex-1 clip-corner-lg hover:text-destructive"
              onClick={onRemove}
              disabled={isRemoving}
            >
              {isRemoving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <FormattedMessage id="emojiPackCard.removing" defaultMessage="Removing…" />
                </>
              ) : (
                <>
                  <Trash2 className="size-4" />
                  <FormattedMessage {...common.remove} />
                </>
              )}
            </Button>
          ) : (
            <Button
              className="flex-1 clip-corner-lg"
              onClick={onAdd}
              disabled={isAdding || entries.length === 0}
            >
              {isAdding ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  <FormattedMessage id="emojiPackCard.adding" defaultMessage="Adding…" />
                </>
              ) : (
                <>
                  <Plus className="size-4" />
                  {entries.length > 0 ? (
                    <FormattedMessage
                      id="emojiPackCard.addCount"
                      defaultMessage="{count, plural, one {Add # emoji} other {Add # emojis}}"
                      values={{ count: entries.length }}
                    />
                  ) : (
                    <FormattedMessage id="emojiPackCard.addPack" defaultMessage="Add pack" />
                  )}
                </>
              )}
            </Button>
          )}
          {isOwn && identifier && (
            <Button
              variant="secondary"
              className="shrink-0 clip-corner-lg"
              onClick={() => setEditing(true)}
              aria-label={intl.formatMessage({ id: "emojiPackCard.edit", defaultMessage: "Edit emoji pack" })}
              title={intl.formatMessage({ id: "emojiPackCard.edit", defaultMessage: "Edit emoji pack" })}
            >
              <Pencil className="size-4" />
            </Button>
          )}
          {naddr && (
            <Button
              variant="secondary"
              className="shrink-0 clip-corner-lg"
              onClick={copy}
              aria-label={intl.formatMessage({ id: "emojiPackCard.copyLink", defaultMessage: "Copy emoji pack link" })}
              title={intl.formatMessage({ id: "emojiPackCard.copyLink", defaultMessage: "Copy emoji pack link" })}
            >
              {copied ? <Check className="size-4" /> : <Link2 className="size-4" />}
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <Suspense fallback={null}>
          <EmojiPackDialog open onOpenChange={setEditing} editEvent={event} />
        </Suspense>
      )}
    </div>
  );
}
