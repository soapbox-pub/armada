import { Reply } from "lucide-react";
import { memo, useContext, useEffect, useMemo, useState } from "react";

import { ExpirationTimerIcon } from "@/components/chat/ExpirationTimerIcon";
import { MeshProfilePreviewCard } from "@/components/chat/MeshProfilePreviewCard";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { BotPill } from "@/components/BotPill";
import { UltraPill } from "@/components/UltraPill";
import { DisplayName } from "@/components/DisplayName";
import { ProxyPill } from "@/components/ProxyPill";
import { StaffPill } from "@/components/StaffPill";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { AppContext } from "@/contexts/AppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedIdentity } from "@/hooks/useScopedDisplayName";
import { getAvatarShape } from "@/lib/avatarShape";
import { fullDateTime, isoDateTime, shortClockTime, shortTimeAgo } from "@/lib/formatTime";
import { formatTimeLeft } from "@/lib/nip17/disappearing";
import { useFrameCss, nameStyleCss, readUltra, ULTRA_LIST_NAME_CLASS } from "@/lib/ultra";
import { cn } from "@/lib/utils";
import { FormattedMessage, useIntl } from "@/i18n";
import { useDoubleTap } from "@/hooks/useDoubleTap";
import { useLongPress } from "@/hooks/useLongPress";
import { useSwipeToReply } from "@/hooks/useSwipeToReply";

import type { ProxyInfo } from "@/lib/nip48";
import type { ReactNode } from "react";
import { AvatarInitial } from "@/components/AvatarInitial";
import { nowSecs } from "@/lib/relayClock";

const NO_TAGS: string[][] = [];

/** Explicit identity for non-Nostr authors (mesh); skips the kind-0 and scoped-profile lookups. */
export interface MessageIdentity {
  name: string;
  color?: string;
  /** Muted suffix after the name (e.g. a mesh `#abcd` disambiguator). */
  suffix?: string;
}

const EXPIRY_URGENT_SECS = 60 * 60;

/**
 * NIP-40 disappearing-message clock ({@link ExpirationTimerIcon}), on header
 * rows only (a run expires together). The countdown text appears only in the
 * last hour; this wrapper's timer exists just for that text.
 */
function ExpirationClock({ createdAt, expiresAt }: { createdAt: number; expiresAt: number }) {
  const intl = useIntl();
  const [now, setNow] = useState(() => nowSecs());

  useEffect(() => {
    const left = expiresAt - nowSecs();
    if (left <= 0) return;
    const delayMs =
      left <= 60 ? 1000 : left <= EXPIRY_URGENT_SECS ? 30_000 : (left - EXPIRY_URGENT_SECS) * 1000;
    // setTimeout's delay is a 32-bit int; longer waits re-arm.
    const id = setTimeout(() => setNow(nowSecs()), Math.min(delayMs, 2 ** 31 - 1));
    return () => clearTimeout(id);
  }, [expiresAt, now]);

  const left = expiresAt - now;
  const label = formatTimeLeft(expiresAt, now);
  return (
    <span
      className="inline-flex items-center gap-0.5 shrink-0 text-3xs text-muted-foreground/60 tabular-nums"
      title={intl.formatMessage({ id: "messageRow.disappearsIn", defaultMessage: "Disappears in {time}" }, { time: label })}
      role="img"
      aria-label={intl.formatMessage({ id: "messageRow.disappearingLeft", defaultMessage: "Disappearing message, {time} left" }, { time: label })}
    >
      <ExpirationTimerIcon createdAt={createdAt} expiresAt={expiresAt} />
      {left <= EXPIRY_URGENT_SECS && <span>{label}</span>}
    </span>
  );
}

function EditedMark() {
  const intl = useIntl();
  return (
    <span className="text-3xs text-muted-foreground/60 shrink-0" title={intl.formatMessage({ id: "messageRow.editedTitle", defaultMessage: "Edited" })}>
      <FormattedMessage id="messageRow.edited" defaultMessage="(edited)" />
    </span>
  );
}

interface MessageRowProps {
  pubkey: string;
  /** Mesh identity: skips the Nostr lookup and the profile-preview card. */
  identityOverride?: MessageIdentity;
  /**
   * Mesh only (needs `identityOverride`): avatar/name open a
   * `MeshProfilePreviewCard`; `isSelf` hides its actions.
   */
  meshActions?: {
    peerID: string;
    isSelf?: boolean;
    onMessage?: (peerID: string) => void;
    onMention?: (peerID: string) => void;
  };
  createdAt: number;
  children: ReactNode;
  pending?: boolean;
  edited?: boolean;
  /** NIP-40 deadline (unix seconds); the clock only claims what the message's own tag says. */
  expiresAt?: number;
  /** Badge after the name (e.g. "NIP-04"); hidden on continuation rows. */
  nameBadge?: ReactNode;
  /** NIP-48 origin of a bridged message. */
  proxy?: ProxyInfo | null;
  /** Header-row controls, mounted only once the row is first hovered or focused. */
  actions?: ReactNode;
  beforeBody?: ReactNode;
  afterBody?: ReactNode;
  /** Continuation of the same author's previous message: no header, hover clock in the gutter. */
  continuation?: boolean;
  className?: string;
  containerProps?: React.HTMLAttributes<HTMLDivElement>;
  /**
   * Touch swipe-LEFT to reply. Leftward because rightward is SwipeReveal's
   * "leave room" gesture.
   */
  onSwipeReply?: () => void;
  /** Touch double-tap to reply. */
  onDoubleTapReply?: () => void;
  /**
   * Touch press-and-hold (action sheet). Ignored on interactive children;
   * cancelled by scroll or swipe.
   */
  onLongPress?: () => void;
}

/** Shared Discord-style message row for group chat and DMs. */
export const MessageRow = memo(function MessageRow({
  pubkey,
  identityOverride,
  meshActions,
  createdAt,
  children,
  pending,
  edited,
  expiresAt,
  nameBadge,
  proxy,
  actions,
  beforeBody,
  afterBody,
  continuation,
  className,
  containerProps,
  onSwipeReply,
  onDoubleTapReply,
  onLongPress,
}: MessageRowProps) {
  const longPress = useLongPress(onLongPress);
  const doubleTap = useDoubleTap(onDoubleTapReply);
  const absoluteTime = useContext(AppContext)?.config.absoluteTimestamps ?? false;
  // The toolbar is built only once hovered/focused (it's heavy per row), then latched.
  const [actionsArmed, setActionsArmed] = useState(false);
  const armActions = actions ? () => setActionsArmed(true) : undefined;
  const author = useAuthor(identityOverride ? undefined : pubkey);
  const metadata = author.data?.metadata;
  // Pass what the byline resolved so DisplayName/BotPill don't subscribe their own lookups.
  const scoped = useScopedIdentity(identityOverride ? undefined : pubkey, metadata);
  const displayName = identityOverride?.name ?? scoped.displayName;
  const color = identityOverride?.color ?? scoped.color;
  const label = identityOverride ? undefined : scoped.label;
  const ultra = useMemo(() => readUltra(metadata), [metadata]);
  const frameStyle = useFrameCss(ultra?.frame);
  const suffix = identityOverride?.suffix;

  const swipe = useSwipeToReply(
    () => onSwipeReply?.(),
    Boolean(onSwipeReply),
  );

  const avatar = (
    <Avatar shape={getAvatarShape(metadata)} className="size-10">
      <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
      <AvatarFallback
        className="text-sm"
        style={color ? { backgroundColor: `${color}33`, color } : undefined}
      >
        {displayName[0]?.toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );

  return (
    <div
      {...containerProps}
      {...(onSwipeReply ? swipe.touchHandlers : undefined)}
      {...longPress}
      onPointerDown={(e) => {
        longPress.onPointerDown(e);
        doubleTap.onPointerDown(e);
      }}
      onPointerUp={(e) => {
        longPress.onPointerUp(e);
        doubleTap.onPointerUp(e);
      }}
      onPointerEnter={(e) => {
        armActions?.();
        containerProps?.onPointerEnter?.(e);
      }}
      onFocusCapture={(e) => {
        armActions?.();
        containerProps?.onFocusCapture?.(e);
      }}
      className={cn(
        "group relative flex items-start gap-3 px-3 rounded hover:bg-secondary/40 transition-colors hover:z-10 focus-within:z-10",
        // A toolbar picker/menu is portalled out of the row, so it holds the row's hover state itself.
        "has-[[data-message-actions]_[aria-expanded=true]]:bg-secondary/40 has-[[data-message-actions]_[aria-expanded=true]]:z-10",
        continuation ? "py-0.5" : "pt-1.5 pb-0.5",
        pending && "animate-pulse",
        // Native text selection/callout fires `pointercancel` around 500ms and eats the
        // long-press; suppress it ("Copy text" replaces manual select).
        onLongPress && "select-none [-webkit-user-select:none] [-webkit-touch-callout:none]",
        className,
        containerProps?.className,
      )}
      style={{
        ...(onSwipeReply ? { touchAction: "pan-y" } : undefined),
        ...containerProps?.style,
      }}
    >
      {onSwipeReply && swipe.offset > 0 && (
        <div
          className="absolute right-2.5 top-1/2 -translate-y-1/2 z-0 pointer-events-none flex items-center justify-center"
          style={{
            opacity: Math.min(swipe.offset / 60, 1),
          }}
        >
          <div className="flex items-center justify-center size-9 rounded-full bg-primary/15 text-primary">
            <Reply className="size-4" />
          </div>
        </div>
      )}
      <div
        className="flex flex-col flex-1 min-w-0"
        style={
          onSwipeReply && swipe.offset !== 0
            ? {
                transform: `translateX(${-swipe.offset}px)`,
                transition: swipe.dragging ? "none" : "transform 0.25s ease-out",
              }
            : undefined
        }
      >
      {/* Above the avatar row so the avatar lines up with the name. */}
      {beforeBody}
      {/* Relative so the toolbar anchors to the message, not the preview. */}
      <div className="flex items-start gap-3 relative">
      {continuation ? (
        <time
          dateTime={isoDateTime(createdAt)}
          title={fullDateTime(createdAt)}
          className="shrink-0 w-10 self-stretch flex items-start justify-end pr-0.5 pt-0.5 text-3xs leading-none text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity tabular-nums select-none"
        >
          {shortClockTime(createdAt)}
        </time>
      ) : identityOverride ? (
        meshActions ? (
          <MeshProfilePreviewCard
            peerID={meshActions.peerID}
            identity={identityOverride}
            isSelf={meshActions.isSelf}
            onMessage={meshActions.onMessage}
            onMention={meshActions.onMention}
          >
            <button type="button" className="shrink-0 mt-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer transition-opacity hover:opacity-90">
              {avatar}
            </button>
          </MeshProfilePreviewCard>
        ) : (
          <span className="shrink-0 mt-0.5">{avatar}</span>
        )
      ) : (
        <ProfilePreviewCard pubkey={pubkey}>
          <button type="button" className="shrink-0 mt-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" style={frameStyle}>
            <Avatar shape={getAvatarShape(metadata)} className="size-10 cursor-pointer transition-opacity hover:opacity-90">
              <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
              <AvatarFallback className="bg-primary/20 text-primary text-sm">
                <AvatarInitial name={displayName} pubkey={pubkey} />
              </AvatarFallback>
            </Avatar>
          </button>
        </ProfilePreviewCard>
      )}
      <div className="flex-1 min-w-0">
        {!continuation && (
          <div className="flex items-baseline gap-2">
            {identityOverride ? (
              meshActions ? (
                <MeshProfilePreviewCard
                  peerID={meshActions.peerID}
                  identity={identityOverride}
                  isSelf={meshActions.isSelf}
                  onMessage={meshActions.onMessage}
                  onMention={meshActions.onMention}
                >
                  <button
                    type="button"
                    className="text-chat font-name font-semibold text-primary truncate min-w-0 inline-flex items-baseline gap-1 hover:underline focus:outline-none"
                    style={color ? { color } : undefined}
                  >
                    <span className="truncate">{displayName}</span>
                    {suffix && (
                      <span className="text-2xs font-normal text-muted-foreground/70 shrink-0 no-underline">
                        #{suffix}
                      </span>
                    )}
                  </button>
                </MeshProfilePreviewCard>
              ) : (
                <span
                  className="text-chat font-name font-semibold text-primary truncate min-w-0 inline-flex items-baseline gap-1"
                  style={color ? { color } : undefined}
                >
                  <span className="truncate">{displayName}</span>
                  {suffix && (
                    <span className="text-2xs font-normal text-muted-foreground/70 shrink-0">
                      #{suffix}
                    </span>
                  )}
                </span>
              )
            ) : (
              <ProfilePreviewCard pubkey={pubkey}>
                <button
                  type="button"
                  className={cn("text-chat font-name font-semibold text-primary truncate min-w-0 hover:underline focus:outline-none", !color && ultra?.name && ULTRA_LIST_NAME_CLASS)}
                  style={color ? { color } : nameStyleCss(ultra?.name)}
                >
                  <DisplayName pubkey={pubkey} name={displayName} tags={author.data?.event?.tags ?? NO_TAGS} />
                </button>
              </ProfilePreviewCard>
            )}
            {!identityOverride && <StaffPill pubkey={pubkey} />}
            <BotPill metadata={metadata} />
            {ultra && <UltraPill force />}
            <ProxyPill proxy={proxy} />
            {nameBadge}
            {label && (
              <Badge variant="secondary" className="text-3xs font-medium shrink min-w-0 max-w-[35%]">
                <span className="truncate">{label}</span>
              </Badge>
            )}
            <time
              dateTime={isoDateTime(createdAt)}
              title={fullDateTime(createdAt)}
              className="text-2xs text-muted-foreground/70 shrink-0 tabular-nums"
            >
              {/* The day dividers carry the date, so the clock time is exact. */}
              {absoluteTime ? shortClockTime(createdAt) : shortTimeAgo(createdAt)}
            </time>
            {edited && (
              <EditedMark />
            )}
            {expiresAt !== undefined && <ExpirationClock createdAt={createdAt} expiresAt={expiresAt} />}
          </div>
        )}
        {actions && actionsArmed && (
          // Straddles the row's top edge, as Discord's does, so it covers the gap
          // between messages rather than this one's text; always one line.
          // Pointer only; touch uses the long-press sheet. Hidden, it overhangs the
          // row above, so it must not take that row's pointer.
          <div data-message-actions className={cn(
            "absolute right-2.5 z-20 flex flex-nowrap items-center gap-0.5 vessel [--vessel-cut:0.45rem] px-1 py-0.5 select-none opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto has-[[aria-expanded=true]]:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto transition-opacity",
            continuation ? "-top-4" : "-top-5",
          )}>
            {actions}
          </div>
        )}
        {children}
        {continuation && edited && (
          // Continuation rows have no header, so (edited) trails the body in normal flow.
          <div className="mt-0.5 flex items-center gap-2 leading-none">
            <EditedMark />
          </div>
        )}
        {afterBody}
      </div>
      </div>
      </div>
    </div>
  );
});
