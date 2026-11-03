import { AtSign, Bell, BellOff, CheckCheck, ChevronLeft, ChevronRight, Copy, Flag, Headphones, Inbox, Loader2, Lock, MessageSquare, MoreVertical, PanelLeft, PanelLeftDashed, PenSquare, Phone, PhoneOff, Pin, PinOff, Plus, Search, ShieldCheck, Sparkles, Timer, User, UserCheck, Users, UserX, X } from "lucide-react";
import { nip19 } from "nostr-tools";
import { Fragment, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type UIEvent } from "react";
import { useLocation, useNavigate, useParams, Navigate } from "react-router-dom";

import { AppStageSlot } from "@/components/chat/AppStage";
import { CallStageSlot } from "@/components/chat/CallStageSlot";
import { DittoIcon } from "@/components/brand/DittoIcon";
import { SyncStatusIndicator } from "@/components/SyncStatusIndicator";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { keepItemFocus } from "@/components/chat/ChatHeader";
import { ChatSearchBar } from "@/components/chat/ChatSearchBar";
import { ChatShell } from "@/components/chat/ChatShell";
import { useSwipeLayout } from "@/components/layout/SwipeReveal";
import type { ChatMsg } from "@/components/chat/transport";
import { useChatEditing } from "@/components/chat/useChatEditing";
import { getQuoteReplyToId } from "@/components/chat/messageHelpers";
import { ReplyContext } from "@/components/chat/ReplyContext";
import { MessageRow } from "@/components/chat/MessageRow";
import { MessageTimeline } from "@/components/chat/MessageTimeline";
import { useTimelineFocus } from "@/hooks/useTimelineFocus";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { LoginArea } from "@/components/auth/LoginArea";
import { ServerRail } from "@/components/layout/ServerRail";
import { VoicePresence } from "@/components/VoicePresence";
import { BotPill } from "@/components/BotPill";
import { UltraPill } from "@/components/UltraPill";
import { DeferredRow } from "@/components/DeferredRow";
import { DisplayName, NameSkeleton } from "@/components/DisplayName";
import { DmAvatar } from "@/components/DmAvatar";
import { NoteToSelfAvatar, NoteToSelfIcon, NOTE_TO_SELF_NAME } from "@/components/NoteToSelfAvatar";
import { ReportDialog } from "@/components/ReportDialog";
import { ModerationMenuSection } from "@/components/chat/ModerationMenuSection";
import { SearchField } from "@/components/ui/search-field";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DmInboxNotice } from "@/components/DmInboxNotice";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { MountWhenOpened } from "@/components/MountWhenOpened";
import { useAndroidBack } from "@/hooks/useAndroidBack";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { PaneCoveredContext, useListShowing } from "@/contexts/PaneCoveredContext";
import { useAppContext } from "@/hooks/useAppContext";
import { useAuthor } from "@/hooks/useAuthor";
import { useCall } from "@/hooks/useCall";
import { useVoiceActivity } from "@/hooks/useVoiceActivity";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMuteToggle, useMuteUser, useMutedPubkeys } from "@/hooks/useMuteList";
import { useActiveRoom } from "@/hooks/useActiveRoom";
import {
  useDMConversations,
  useDMSupport,
  useHasUnreadDMs,
} from "@/hooks/useDirectMessages";
import { useBotManifests } from "@/hooks/useBotManifests";
import { useDm17Backfill, useDm17Conversations, useDm17HistoryIncomplete, useDm17Support, type Dm17Conversation } from "@/hooks/useDm17";
import { useDmConversationName } from "@/hooks/useDmConversationName";
import {
  recordDmConversationIndex,
  useDmConversationIndex,
  useDmConversationIndexReady,
} from "@/hooks/useDmConversationIndex";
import { useDmMessageSearch } from "@/hooks/useDmMessageSearch";
import { useDmProtocolPref } from "@/hooks/useDmProtocolPref";
import { useDmReplyParents } from "@/hooks/useDmReplyParents";
import { LegacyFallbackRequired, useDmTransport } from "@/hooks/useDmTransport";
import { useDmTyping } from "@/hooks/useDmTyping";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useDmCall } from "@/contexts/DmCallContext";
import { useDmCallReach } from "@/hooks/useDmCallReach";
import { useFollowSearch, useSearchProfiles, type SearchProfile } from "@/hooks/useSearchProfiles";
import { dmReadKey, useReadState } from "@/hooks/useReadState";
import { usePageCovered } from "@/lib/settingsOverlay";
import { useNotifLevels, dmScopeKey, type NotifLevel } from "@/hooks/useNotifLevels";
import { usePinnedDms } from "@/hooks/usePinnedDms";
import { useRailDms } from "@/hooks/useRailDms";
import { useAcceptedDms } from "@/hooks/useAcceptedDms";
import { useClosedDms, type DmLatestMarker } from "@/hooks/useClosedDms";
import { useKnownDmPeers } from "@/hooks/useKnownDmPeers";
import { useOpenProfile } from "@/hooks/useOpenProfile";
import { usePrefetchProfile } from "@/hooks/usePrefetchProfile";
import { useStartedDms } from "@/hooks/useStartedDms";
import { useSharedCommunities } from "@/hooks/useSharedCommunities";
import { useStableNavigate } from "@/hooks/useStableNavigate";
import { useToast } from "@/hooks/useToast";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { dmRouteParam, parseDmRouteParam } from "@/lib/dmConversation";
import { getAvatarShape } from "@/lib/avatarShape";
import { writeClipboardText } from "@/lib/clipboard";
import { forwardableTags } from "@/lib/forwardMessage";
import { chatRoute, parseChatRoute, type ChatRoute } from "@/lib/routes";
import { stashShare } from "@/lib/shareTarget";
import { dittoProfileUrl } from "@/lib/dittoUrl";
import { tryNpubEncode } from "@/lib/safeNip19";
import { getDisplayName } from "@/lib/getDisplayName";
import { useProfilesPending } from "@/lib/profileLoading";
import { DISAPPEARING_PRESETS, disappearingNotice, formatDisappearingDuration } from "@/lib/nip17/disappearing";
import { expirationOf, KIND_DM_CHAT, KIND_DM_FILE } from "@/lib/nip17/protocol";
import { dmConvKey, dmConvPeers } from "@/lib/nip17/conversation";
import { pickEmojiTags, readDmListSnapshot, writeDmListSnapshot } from "@/lib/dmListSnapshot";
import { resolvePubkey } from "@/lib/resolvePubkey";
import { buildEmojiMap } from "@/lib/customEmoji";
import { emojify } from "@/components/chat/emojify";
import { sanitizeUrl } from "@/lib/sanitizeUrl";
import { cn } from "@/lib/utils";
import { common, FormattedMessage, t, useIntl } from "@/i18n";

import type { NostrRumor } from "@/lib/nostrRumor";
import type { DmConversationLatest } from "@/lib/dmConversationIndex";
import { parseProfileImeta, type ProfileImeta } from "@/lib/profileImeta";
import { AvatarInitial } from "@/components/AvatarInitial";

/**
 * Highlight case-insensitive `query` matches in `text`, rendering NIP-30 emoji
 * from the message's own `emoji` tags (kind-4 has none, so shortcodes stay literal).
 */
const MENU_PARTS = {
  Item: DropdownMenuItem,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

function Highlight({
  text,
  query,
  emojiTags,
}: {
  text: string;
  query: string;
  emojiTags?: string[][];
}) {
  const emojiMap = buildEmojiMap(emojiTags ?? []);
  const render = (s: string) => (emojiMap.size > 0 ? emojify(s, emojiMap) : s);
  const q = query.trim();
  if (!q) return <>{render(text)}</>;
  // Split on the escaped query, keeping delimiters so matches can be wrapped.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="rounded-[2px] bg-primary/30 text-inherit">
            {render(part)}
          </mark>
        ) : (
          <Fragment key={i}>{render(part)}</Fragment>
        ),
      )}
    </>
  );
}

/** Row actions keyed by conversation; one stable object so memoized rows skip list-wide re-renders. */
interface ConversationRowActions {
  open: (conversation: string) => void;
  togglePin: (conversation: string) => void;
  toggleRail: (conversation: string) => void;
  close: (conversation: string) => void;
  block: (peer: string) => void;
}

const ConversationRow = memo(function ConversationRow({
  conversation,
  peers,
  preview,
  previewText,
  unread,
  inCall,
  selfPubkey,
  query,
  messageMatch,
  active,
  pinned,
  onRail,
  request,
  sharedCommunity,
  closable,
  actions,
}: {
  conversation: string;
  peers: string[];
  preview: NostrRumor | undefined;
  previewText: string | undefined;
  unread: boolean;
  inCall: boolean;
  selfPubkey: string | undefined;
  query: string;
  messageMatch: string | undefined;
  active: boolean;
  pinned: boolean;
  onRail: boolean;
  /**
   * Request-tier row: no profile picture (fetching it would reveal our IP to an
   * unknown sender), and accept/block instead of the pin menu.
   */
  request?: boolean;
  /** A community both parties are in, when one is known — see useSharedCommunities. */
  sharedCommunity?: string;
  closable: boolean;
  actions: ConversationRowActions;
}) {
  const group = peers.length > 1;
  const { name, metadata, emojiTags } = useDmConversationName(peers, selfPubkey);
  // Note to Self uses Signal's name/mark: your own face would read as a message FROM you.
  const noteToSelf = !group && peers[0] === selfPubkey;

  // Per-person options are 1:1 only.
  const openProfile = useOpenProfile();
  const { toast } = useToast();
  const intl = useIntl();

  // While searching, keep rows matching the name/handle or a decrypted message
  // (`messageMatch`, which then replaces the preview line).
  const q = query.trim().toLowerCase();
  const nameMatches = q.length > 0 && `${name} ${metadata?.nip05 ?? ""}`.toLowerCase().includes(q);
  if (q && !nameMatches && messageMatch === undefined) return null;

  const secondLine = messageMatch ?? previewText;
  const secondLineHighlight = q && secondLine ? secondLine.toLowerCase().includes(q) : false;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => actions.open(conversation)}
          className={cn(
            // Larger than a channel row: avatar and preview carry recognition here.
            "flex items-center gap-3 w-full px-2 py-2.5 clip-corner text-left transition-colors",
            active ? "bg-secondary" : "hover:bg-secondary/60",
          )}
        >
          {/* Never fetch a request's avatar: it would confirm a live reader to the sender. */}
          <DmAvatar
            peers={peers}
            selfPubkey={selfPubkey}
            sizePx={48}
            className="size-12"
            anonymous={request}
          />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex items-center gap-1.5 min-w-0">
              <div className={cn("text-chat truncate", unread ? "font-semibold text-foreground" : "font-medium")}>
                {q ? (
                  <Highlight text={name} query={query} emojiTags={emojiTags} />
                ) : noteToSelf ? (
                  name
                ) : group ? (
                  // Several names: plain text, no single-person DisplayName chrome.
                  <GroupName peers={peers} name={name} />
                ) : (
                  <DisplayName pubkey={peers[0]} name={name} />
                )}
              </div>
              {!noteToSelf && !group && <BotPill metadata={metadata} />}
              {!noteToSelf && !group && <UltraPill metadata={metadata} />}
            </div>
            {(preview || secondLine) && (
              <div className={cn("text-sm truncate", unread ? "text-foreground/80" : "text-muted-foreground")}>
                {secondLine ? (
                  <Highlight
                    text={secondLine}
                    query={secondLineHighlight ? query : ""}
                    emojiTags={preview?.tags}
                  />
                ) : (
                  <FormattedMessage id="dmsPage.row.encrypted" defaultMessage="Encrypted message" />
                )}
              </div>
            )}
            {/* Positive assertion only: no label means no membership data, not "nothing shared". */}
            {request && sharedCommunity && (
              <div className="flex items-center gap-1 text-2xs text-muted-foreground/80">
                <Users className="size-3 shrink-0" aria-hidden />
                <span className="truncate">
                  <FormattedMessage
                    id="dmsPage.row.alsoIn"
                    defaultMessage="Also in {community}"
                    values={{ community: sharedCommunity }}
                  />
                </span>
              </div>
            )}
          </div>
          {inCall ? (
            <span
              className="shrink-0 flex size-6 items-center justify-center rounded-full bg-success text-success-foreground"
              aria-label={intl.formatMessage({ id: "dmsPage.row.inCall", defaultMessage: "Voice call in progress" })}
            >
              <Headphones className="size-3.5" />
            </span>
          ) : unread ? (
            <span className="shrink-0 size-2.5 rounded-full bg-primary" aria-label={intl.formatMessage({ id: "dmsPage.row.unread", defaultMessage: "Unread messages" })}
            />
          ) : null}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        {request ? (
          // No accept: replying is accepting (the composer notice says so).
          <>
            {/* Hidden until the sender writes again, like closing a DM. */}
            <ContextMenuItem onSelect={() => actions.close(conversation)}>
              <X className="mr-2 size-4" /> <FormattedMessage id="dmsPage.row.dismissRequest" defaultMessage="Dismiss" />
            </ContextMenuItem>
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => {
                // Group requests have no single sender to block.
                if (!group) actions.block(peers[0]);
              }}
            >
              <UserX className="mr-2 size-4" /> <FormattedMessage id="dmsPage.block" defaultMessage="Block" />
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onSelect={() => actions.togglePin(conversation)}>
              {pinned ? (
                <>
                  <PinOff className="mr-2 size-4" /> <FormattedMessage id="dmsPage.row.unpin" defaultMessage="Unpin" />
                </>
              ) : (
                <>
                  <Pin className="mr-2 size-4" /> <FormattedMessage id="dmsPage.row.pin" defaultMessage="Pin" />
                </>
              )}
            </ContextMenuItem>
            {!group && (
              <>
                <ContextMenuItem onSelect={() => openProfile(tryNpubEncode(peers[0]) ?? peers[0])}>
                  <User className="mr-2 size-4" /> <FormattedMessage id="dmsPage.viewProfile" defaultMessage="View profile" />
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => {
                    const npub = tryNpubEncode(peers[0]);
                    if (!npub) return;
                    writeClipboardText(npub).then(
                      () => toast({ title: t({ id: "dmsPage.row.copiedNpub", defaultMessage: "Copied npub" }) }),
                      () => toast({
                        title: t({ id: "dmsPage.row.copyFailed", defaultMessage: "Copy failed" }),
                        variant: "destructive",
                      }),
                    );
                  }}
                >
                  <Copy className="mr-2 size-4" /> <FormattedMessage id="dmsPage.row.copyNpub" defaultMessage="Copy npub" />
                </ContextMenuItem>
              </>
            )}
            {/* Rail shortcut opening this thread. 1:1 only: the rail layout stores bare pubkeys (`dmRailKey`). */}
            {!group && (
            <ContextMenuItem onSelect={() => actions.toggleRail(conversation)}>
              {onRail ? (
                <>
                  <PanelLeftDashed className="mr-2 size-4" />{" "}
                  <FormattedMessage id="dmsPage.row.removeFromRail" defaultMessage="Remove from rail" />
                </>
              ) : (
                <>
                  <PanelLeft className="mr-2 size-4" /> <FormattedMessage id="dmsPage.row.addToRail" defaultMessage="Add to rail" />
                </>
              )}
            </ContextMenuItem>
            )}
            {/* Note to Self is a fixture of the list, so it has no close. */}
            {closable && (
              <ContextMenuItem onSelect={() => actions.close(conversation)}>
                <X className="mr-2 size-4" /> <FormattedMessage id="dmsPage.row.closeDm" defaultMessage="Close DM" />
              </ContextMenuItem>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

/**
 * Stable, varied placeholder width derived from the event id (uniform widths
 * read as a loading bar; never hints at real length).
 */
function placeholderBodyWidth(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `${25 + (hash % 60)}%`;
}

/**
 * Not-yet-decrypted DM placeholder reserving its row; decrypts on scroll into
 * view via `observePlaceholder`. If bulk decryption was DECLINED, shows a
 * "Decrypt" button instead and never pokes the signer on scroll.
 */
function DmPlaceholderRow({
  id,
  pubkey,
  createdAt,
  continuation,
  observePlaceholder,
  declined,
  onDecrypt,
}: {
  id: string;
  pubkey: string;
  createdAt: number;
  continuation?: boolean;
  observePlaceholder: (el: HTMLElement, id: string) => () => void;
  declined?: boolean;
  onDecrypt?: (id: string) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (declined) return; // manual-only: don't auto-decrypt on scroll
    const el = rowRef.current;
    if (!el) return;
    return observePlaceholder(el, id);
  }, [id, observePlaceholder, declined]);

  return (
    <div ref={rowRef} data-event-id={id}>
      <MessageRow pubkey={pubkey} createdAt={createdAt} continuation={continuation}>
        {declined ? (
          <button
            type="button"
            onClick={() => onDecrypt?.(id)}
            className="inline-flex items-center gap-1.5 clip-corner-lg bg-muted/60 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <Lock className="size-3" />
            <FormattedMessage id="dmsPage.placeholder.tapToDecrypt" defaultMessage="Encrypted message. Tap to decrypt." />
          </button>
        ) : (
          <Skeleton
            className="h-3.5 max-w-full"
            style={{ width: placeholderBodyWidth(id) }}
          />
        )}
      </MessageRow>
    </div>
  );
}

/**
 * Marker for legacy NIP-04 (kind 4) messages, making the downgrade visible in
 * mixed threads. A Popover (not a tooltip) so it works on touch.
 */
function DmLegacyBadge() {
  const intl = useIntl();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-0.5 clip-corner bg-muted/60 px-1.5 py-0.5 text-3xs font-medium leading-none text-muted-foreground/80 hover:text-foreground shrink-0 select-none"
          aria-label={intl.formatMessage({
            id: "dmsPage.legacyBadge.label",
            defaultMessage: "Older, less private encryption. Tap for details.",
          })}
        >
          <Lock className="size-2.5" aria-hidden />
          NIP-04
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-64 p-3 text-xs font-normal text-muted-foreground">
        <FormattedMessage
          id="dmsPage.legacyBadge.details"
          defaultMessage="Sent with older DM encryption. It hides the message text, but not the fact that you two are talking or when. Newer messages use stronger, fully private encryption."
        />
      </PopoverContent>
    </Popover>
  );
}

/** Shared element: a fresh badge per render would defeat the row memo. */
const LEGACY_BADGE = <DmLegacyBadge />;

/**
 * Replaces the composer when the peer can't receive NIP-17: falling back to
 * kind 4 leaks metadata, so the downgrade must be an explicit choice.
 */
function DmLegacyFallbackNotice({
  peer,
  name,
  onEnable,
}: {
  peer: string;
  name: string;
  onEnable: () => void;
}) {
  return (
    <div className="mx-gutter mb-3 clip-hairline-lg [--fill:var(--muted)/0.4] [--fill-hover:var(--muted)/0.4] px-4 py-3 text-sm">
      <div className="flex items-start gap-2.5">
        <Lock className="size-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 space-y-2">
          <p className="text-muted-foreground">
            <FormattedMessage
              id="dmsPage.legacyFallback.description"
              defaultMessage="{name} hasn't set up private messaging yet, so we can't send them a fully-private DM. You can still message them with older encryption. It hides what you say, but not that you're talking or when."
              values={{
                name: (
                  <span className="font-medium text-foreground">
                    <DisplayName pubkey={peer} name={name} />
                  </span>
                ),
              }}
            />
          </p>
          <Button size="sm" className="clip-corner-lg" onClick={onEnable}>
            <FormattedMessage id="dmsPage.legacyFallback.enable" defaultMessage="Message with legacy encryption" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A disappearing-timer change shown as a centered notice (conversation state, not a message). */
function DmTimerNotice({ author, seconds, self, name }: { author: string; seconds: number; self: string | undefined; name: string }) {
  return (
    <div className="flex items-center justify-center gap-1.5 px-4 py-1.5 select-none" role="status">
      <Timer className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
      <span className="text-2xs text-muted-foreground/80 text-center">
        {disappearingNotice(seconds, author === self, name)}
      </span>
    </div>
  );
}

/**
 * The message a DM replies to: our NIP-C7 `q` tag or a foreign client's plain
 * `e` parent tag. Kind-4 rows never resolve.
 */
function dmReplyToId(msg: NostrRumor): string | undefined {
  if (msg.kind !== KIND_DM_CHAT && msg.kind !== KIND_DM_FILE) return undefined;
  return getQuoteReplyToId(msg) ?? msg.tags.find(([name, value]) => name === "e" && value)?.[1];
}

/**
 * Shown above the composer while reading a request. No accept button —
 * replying IS accepting; the only action is blocking (a NIP-51 mute across both planes).
 */
function DmRequestNotice({
  peer,
  name,
  sharedCommunity,
  onBlock,
  blocking,
}: {
  peer?: string;
  name: string;
  sharedCommunity?: string;
  /** Absent for a group: blocking has to name one person. */
  onBlock?: () => void;
  blocking: boolean;
}) {
  const requestName = (
    <span className="font-medium text-foreground">
      {peer ? <DisplayName pubkey={peer} name={name} /> : name}
    </span>
  );
  return (
    // Action beside the text, not under it: this ADDS to the composer's height.
    <div className="mx-gutter mb-3 clip-hairline-lg [--fill:var(--muted)/0.4] [--fill-hover:var(--muted)/0.4] px-4 py-2.5 text-sm">
      <div className="flex items-center gap-3">
        <Inbox className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          {/* Wraps rather than truncates so narrow phones keep the community hint. */}
          <p className="text-muted-foreground break-words">
            {peer ? (
              <FormattedMessage
                id="dmsPage.request.notFollowed"
                defaultMessage="{name} isn't someone you follow{shared, select, yes { · also in {community}} other {}}"
                values={{ name: requestName, shared: sharedCommunity ? "yes" : "no", community: sharedCommunity }}
              />
            ) : (
              <FormattedMessage
                id="dmsPage.request.groupNotFollowed"
                defaultMessage="{name} includes people you don't follow{shared, select, yes { · also in {community}} other {}}"
                values={{ name: requestName, shared: sharedCommunity ? "yes" : "no", community: sharedCommunity }}
              />
            )}
          </p>
          <p className="text-xs text-muted-foreground/80">
            {peer ? (
              <FormattedMessage
                id="dmsPage.request.replyToAccept"
                defaultMessage="Reply to accept. They aren't notified."
              />
            ) : (
              <FormattedMessage
                id="dmsPage.request.replyToAcceptGroup"
                defaultMessage="Reply to accept. Nobody here is notified."
              />
            )}
          </p>
        </div>
        {onBlock && (
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 touch:h-11 text-destructive hover:text-destructive"
            onClick={onBlock}
            disabled={blocking}
          >
            <UserX className="size-4" />
            {blocking ? (
              <FormattedMessage id="dmsPage.blocking" defaultMessage="Blocking…" />
            ) : (
              <FormattedMessage id="dmsPage.block" defaultMessage="Block" />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Memoized with stable props so conversation-LIST changes don't re-render the open thread. */
const Conversation = memo(function Conversation({
  conversation,
  peers,
  isRequest,
  onAccept,
  onBack,
}: {
  conversation: string;
  peers: string[];
  isRequest: boolean;
  onAccept: () => void;
  onBack: () => void;
}) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const location = useLocation();
  const openProfile = useOpenProfile();
  const prefetchProfile = usePrefetchProfile();
  const group = peers.length > 1;
  // Groups have no single counterparty; `peer` exists only so per-person
  // controls (all hidden for groups) have something to name.
  const peer = peers[0] ?? "";
  // Note to Self throughout (see ConversationRow).
  const noteToSelf = !group && peer === user?.pubkey;
  const { name, metadata: peerMetadata } = useDmConversationName(peers, user?.pubkey);
  const dittoProfileHref = group ? undefined : dittoProfileUrl(peer);
  const composerBoundsRef = useRef<HTMLElement | null>(null);
  const focusedRumorId = useMemo(() => {
    const route = parseChatRoute(location.pathname);
    return route?.kind === "dm" && parseDmRouteParam(route.peer) === conversation
      ? route.messageId
      : undefined;
  }, [location.pathname, conversation]);
  const { transport, entries, syncing, disappearingTimer, resolveDisappearingTimer, setDisappearingTimer, encryptedIds, dm17Ids, dm17Enabled, legacyPinned, decryptVisible, decryptOne, decryptAll, decryptDeclined, hasEncrypted, send } =
    useDmTransport(conversation, peers, focusedRumorId);
  const { messages } = transport;

  // A bot peer's declared commands render untagged `/cmd` invocations as action
  // lines. Only query bot-manifest indexers when the profile marks a bot.
  const botRoster = useMemo(
    () => (peerMetadata?.bot === true ? [peer] : []),
    [peerMetadata?.bot, peer],
  );
  const { entries: botCommandEntries } = useBotManifests(botRoster);
  const knownCommands = useMemo(
    () => new Set(botCommandEntries.map((e) => e.command.name)),
    [botCommandEntries],
  );
  const { markRead } = useReadState();
  // Covered by Settings or by the mobile list: mounted but not being read.
  const settingsCovered = usePageCovered();
  const listCovered = useContext(PaneCoveredContext);
  const covered = settingsCovered || listCovered;
  const { dmLevel, setLevel: setNotifLevel } = useNotifLevels();
  const { toast } = useToast();
  const { activeCall } = useCall();
  const { voiceRoomPubkeys } = useVoiceActivity();
  const muteUser = useMuteUser();
  const mute = useMuteToggle(peer);
  // NIP-04 has no group form, so the protocol choice is 1:1 only.
  const { pref: dmProtocol, setPref: setDmProtocol } = useDmProtocolPref(peer);
  const isTouch = useIsTouch();
  // Typing rides the NIP-17 plane only, and never on an unaccepted request
  // (it would tell a stranger someone is reading).
  const { typers, publishTyping } = useDmTyping(conversation, dm17Enabled && !isRequest);
  // Tier-2 hint for the request banner; read only while a request is open.
  const requestPeers = useMemo(
    () => (isRequest && !group ? [peer] : []),
    [isRequest, group, peer],
  );
  // Stable permalink: a fresh object per row would defeat every message's memo.
  const dmPermalink = useMemo<ChatRoute>(
    () => ({ kind: "dm", peer: dmRouteParam(conversation) }),
    [conversation],
  );
  const sharedCommunity = useSharedCommunities(requestPeers, isRequest && !group).get(peer);

  const { editingId, startEditing, cancelEditing, handleEditSubmit, editLast } = useChatEditing({
    edit: (original, content) => transport.editMessage?.(original, content),
    messages: transport.messages,
    isPending: (id) => transport.sendStatusFor?.(id) !== undefined,
    self: user?.pubkey,
  });

  // Quote-replies are NIP-17 only (kind 4 has no in-band convention).
  const [replyTo, setReplyTo] = useState<NostrRumor | undefined>(undefined);
  useEffect(() => setReplyTo(undefined), [conversation]);

  // Forward the CONTENT only (see forwardableTags) through the share picker,
  // landing in the destination composer so the user can edit before sending.
  // Stable across conversations via a ref (`useNavigate` changes per location).
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const stableNavigate = useStableNavigate();
  const handleForward = useCallback((event: ChatMsg) => {
    stashShare({ text: event.content, files: [], tags: forwardableTags(event) }, null);
    stableNavigate("/share", {
      state: { forwardFrom: chatRoute({ kind: "dm", peer: dmRouteParam(conversationRef.current) }) },
    });
  }, [stableNavigate]);

  // No silent downgrade to kind 4: the composer is replaced by an opt-in notice,
  // reset per conversation.
  const [legacyAllowed, setLegacyAllowed] = useState(false);
  useEffect(() => setLegacyAllowed(false), [conversation]);
  // Block only once we KNOW there's no NIP-17 inbox (no flash while loading);
  // legacy-pinned threads send kind 4 directly.
  const legacyBlocked = !legacyPinned && !dm17Enabled && !transport.isLoading && !legacyAllowed;

  // Quote jumps, permalinks, and touch tap-to-reveal (the toolbar is inert
  // until the row is tapped).
  const {
    timelineRef,
    jumpToMessage,
    pinToPresent,
    activeId,
    toggleActive,
  } = useTimelineFocus({
    messages,
    isLoading: transport.isLoading,
    hasMore: transport.hasMore,
    loadOlder: transport.loadOlder,
    resetKey: conversation,
  });

  // For resolving quoted parents locally (NIP-17 rumors aren't relay-fetchable).
  const messagesById = useMemo(() => {
    const map = new Map<string, NostrRumor>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);
  // Parents older than the loaded window come from the store.
  const olderReplyParents = useDmReplyParents(conversation, peers, messages, messagesById, dmReplyToId);

  // Reuse reply-context elements per parent so replies don't re-render with the whole thread.
  const replyNodes = useRef(
    new Map<string, { parent: NostrRumor | undefined; onJump: typeof jumpToMessage; node: ReactNode }>(),
  );
  useEffect(() => replyNodes.current.clear(), [conversation]);
  const replyContextFor = (msg: ChatMsg): ReactNode => {
    const replyId = dmReplyToId(msg);
    if (!replyId) return undefined;
    const parent = messagesById.get(replyId) ?? olderReplyParents.get(replyId);
    const hit = replyNodes.current.get(msg.id);
    if (hit && hit.parent === parent && hit.onJump === jumpToMessage) return hit.node;
    const node = <ReplyContext parentId={replyId} parent={parent} onJump={jumpToMessage} />;
    replyNodes.current.set(msg.id, { parent, onJump: jumpToMessage, node });
    return node;
  };

  // Inline search filters the loaded thread client-side.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [muteConfirmOpen, setMuteConfirmOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, [conversation]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, []);

  // Placeholders have no text, so they're excluded while searching.
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const searchResults = useMemo(
    () =>
      normalizedSearch
        ? messages.filter(
            (m) => !encryptedIds.has(m.id) && m.content.toLocaleLowerCase().includes(normalizedSearch),
          )
        : [],
    [messages, encryptedIds, normalizedSearch],
  );

  // DM calls use the blind broker (DmCallProvider): any 1:1 with a NIP-44 login; no groups or Note to Self.
  const { startCall, acceptCall, canCall, incoming } = useDmCall();
  const callable = canCall && Boolean(user) && !group && !noteToSelf;
  const inThisCall = Boolean(activeCall?.dmPeer && activeCall.dmPeer === peer);

  // Surface a ringing call from this (known) peer here too, since the modal auto-dismisses.
  const peerCalling = Boolean(incoming && incoming.author === peer && !inThisCall);

  // Predict whether their ring gate admits us; refused calls drop silently, so
  // the button is SOFT-disabled with "Call anyway" (the prediction is partial).
  // A peer calling us is always answerable.
  const peerWroteLoaded = useMemo(
    () => callable && messages.some((m) => m.pubkey === peer),
    [callable, messages, peer],
  );
  const callReach = useDmCallReach(callable ? peer : undefined, peerWroteLoaded);
  const callBlocked = !peerCalling && callReach === "unlikely";
  const [callWarnOpen, setCallWarnOpen] = useState(false);
  const callWarnToComposer = useRef(false);
  useEffect(() => setCallWarnOpen(false), [conversation]);
  const joinCallLabel = intl.formatMessage({ id: "dmsPage.call.join", defaultMessage: "Join voice call" });
  const startCallLabel = intl.formatMessage({ id: "dmsPage.call.start", defaultMessage: "Start voice call" });
  const callWarnTitle = intl.formatMessage({
    id: "dmsPage.call.warnTitle",
    defaultMessage: "Message them before you call",
  });
  const callTooltip = peerCalling ? joinCallLabel : callBlocked ? callWarnTitle : startCallLabel;

  // Before we join, a ringing offer is the only presence signal for a blind-broker room.
  const dmOthersInVoice = useMemo(
    () =>
      inThisCall
        ? (voiceRoomPubkeys ?? []).filter((pk) => pk !== user?.pubkey)
        : peerCalling
          ? [peer]
          : [],
    [inThisCall, voiceRoomPubkeys, user?.pubkey, peerCalling, peer],
  );

  // Lazy decryption: one IntersectionObserver decrypts placeholders as they
  // scroll into view (element→id via WeakMap).
  const elementIds = useRef(new WeakMap<Element, string>());
  const decryptVisibleRef = useRef(decryptVisible);
  decryptVisibleRef.current = decryptVisible;
  const observerRef = useRef<IntersectionObserver | null>(null);
  if (!observerRef.current && typeof IntersectionObserver !== "undefined") {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        // Decrypt bottom-up (threads anchor to the newest message).
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.boundingClientRect.top - a.boundingClientRect.top);
        for (const entry of visible) {
          const id = elementIds.current.get(entry.target);
          if (id) decryptVisibleRef.current(id);
        }
      },
      { rootMargin: "200px 0px" },
    );
  }
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const observePlaceholder = useCallback((el: HTMLElement, id: string) => {
    const observer = observerRef.current;
    if (!observer) {
      // No IntersectionObserver: decrypt immediately.
      decryptVisibleRef.current(id);
      return () => {};
    }
    elementIds.current.set(el, id);
    observer.observe(el);
    return () => {
      observer.unobserve(el);
      elementIds.current.delete(el);
    };
  }, []);

  useEffect(() => {
    if (messages.length === 0 || covered) return;
    const latest = messages[messages.length - 1]?.created_at ?? 0;
    if (latest <= 0) return;
    const stamp = () => {
      if (document.visibilityState === "visible") markRead(dmReadKey(conversation), latest);
    };
    stamp();
    document.addEventListener("visibilitychange", stamp);
    return () => document.removeEventListener("visibilitychange", stamp);
  }, [messages, conversation, markRead, covered]);

  const handleSubmit = useCallback(
    async (text: string, tags: string[][]) => {
      try {
        // Resolves once signed and optimistically rendered; delivery status is
        // shown per message. Quote-replies carry NIP-C7 `q` plus NIP-17's plain
        // `e` parent tag for foreign clients.
        const finalTags = replyTo ? [...tags, ["e", replyTo.id]] : tags;
        await send(text, finalTags, { allowLegacy: legacyAllowed });
        // Replying is accepting; record it now so the row leaves Requests this frame.
        if (isRequest) onAccept();
        // Sending means "at the present": follow the new message even if scrolled up.
        pinToPresent();
        setReplyTo(undefined);
      } catch (e) {
        // Reachability flipped between render and submit: show the opt-in notice.
        if (e instanceof LegacyFallbackRequired) {
          setLegacyAllowed(false);
          throw e;
        }
        // Only signing/encryption errors reach here; keep the composer content.
        toast({
          title: t({ id: "dmsPage.notSent", defaultMessage: "Message not sent" }),
          description: e instanceof Error
            ? e.message
            : t({ id: "dmsPage.notSentDescription", defaultMessage: "Could not sign the message." }),
          variant: "destructive",
        });
        throw e;
      }
    },
    [send, toast, replyTo, legacyAllowed, isRequest, onAccept, pinToPresent],
  );

  const handleMute = useCallback(async () => {
    setMuteConfirmOpen(false);
    // Optimistic mute first so the sidebar drops the peer immediately.
    const pendingMute = muteUser.mutateAsync(peer);
    onBack();
    try {
      await pendingMute;
      toast({
        title: t({ id: "dmsPage.blocked", defaultMessage: "Blocked" }),
        description: t(
          { id: "dmsPage.blockedDescription", defaultMessage: "You won't see messages from {name}." },
          { name },
        ),
      });
    } catch (e) {
      toast({
        title: t({ id: "dmsPage.blockFailed", defaultMessage: "Couldn't block" }),
        description: e instanceof Error
          ? e.message
          : t({ id: "dmsPage.blockFailedDescription", defaultMessage: "Failed to update your block list." }),
        variant: "destructive",
      });
    }
  }, [muteUser, peer, name, toast, onBack]);

  return (
    <ComposerBoundsProvider value={composerBoundsRef}>
    <div className="flex flex-col flex-1 min-h-0">
      {/* Keyed by CONVERSATION, matching the launch card's `ChatScopeContext`. */}
      <AppStageSlot scope={{ kind: "dm", conversation }} />
      <header className="relative h-12 touch:h-[3.25rem] mx-gutter mt-1 sidebar:mt-3 px-2 sidebar:px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
        <Button
          variant="ghost"
          size="icon"
          aria-label={intl.formatMessage({ id: "dmsPage.backToConversations", defaultMessage: "Back to conversations" })}
          className="size-9 touch:size-11 shrink-0 sidebar:hidden"
          onClick={onBack}
        >
          <ChevronLeft className="size-5" />
        </Button>
        <div className="relative shrink-0">
          <DmAvatar peers={peers} selfPubkey={user?.pubkey} sizePx={28} className="size-7" />
          {/* Older-history paging reports here, as on a Concord channel header. */}
          <SyncStatusIndicator className="absolute -bottom-1 -right-1 z-10" />
        </div>
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <h1 className="font-semibold truncate min-w-0">
            {noteToSelf ? name : group ? <GroupName peers={peers} name={name} /> : <DisplayName pubkey={peer} name={name} />}
          </h1>
          {!noteToSelf && !group && <BotPill metadata={peerMetadata} />}
          {!noteToSelf && !group && <UltraPill metadata={peerMetadata} />}
        </div>
        {dmOthersInVoice.length > 0 && (
          <VoicePresence participants={dmOthersInVoice} className="text-success/90" />
        )}
        {callable && !inThisCall && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={peerCalling ? joinCallLabel : startCallLabel}
                aria-haspopup={callBlocked ? "dialog" : undefined}
                className={cn(
                  "relative size-8 touch:size-11 shrink-0",
                  peerCalling
                    ? "text-success hover:text-success animate-pulse"
                    : callBlocked
                      ? "text-muted-foreground opacity-50 hover:opacity-100"
                      : "text-muted-foreground hover:text-success",
                )}
                onClick={
                  peerCalling
                    ? () => acceptCall()
                    : callBlocked
                      ? () => setCallWarnOpen(true)
                      : () => void startCall(peer)
                }
              >
                <Phone className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{callTooltip}</TooltipContent>
          </Tooltip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={intl.formatMessage({ id: "dmsPage.moreOptions", defaultMessage: "More options" })}
              className="size-8 touch:size-11 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <MoreVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64" onCloseAutoFocus={keepItemFocus}>
            <DropdownMenuItem onClick={() => setSearchOpen(true)}>
              <Search className="size-4" />
              <FormattedMessage id="dmsPage.searchMessages" defaultMessage="Search messages" />
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {(() => {
                  const lvl = dmLevel(conversation);
                  const Icon = lvl === "nothing" ? BellOff : lvl === "mentions" ? AtSign : Bell;
                  return <Icon className="mr-2 size-4" />;
                })()}
                <FormattedMessage id="dmsPage.notifications" defaultMessage="Notifications" />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                <DropdownMenuRadioGroup
                  value={dmLevel(conversation)}
                  onValueChange={(v) => setNotifLevel(dmScopeKey(conversation), v as NotifLevel)}
                >
                  <DropdownMenuRadioItem value="all">
                    <Bell className="mr-2 size-4" />{" "}
                    <FormattedMessage id="dmsPage.notifications.all" defaultMessage="All messages" />
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="mentions">
                    <AtSign className="mr-2 size-4" />{" "}
                    <FormattedMessage id="dmsPage.notifications.mentions" defaultMessage="Only @mentions" />
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="nothing">
                    <BellOff className="mr-2 size-4" />{" "}
                    <FormattedMessage id="dmsPage.notifications.nothing" defaultMessage="Nothing" />
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {!group && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                {dmProtocol === "nip04" ? (
                  <Lock className="mr-2 size-4" />
                ) : (
                  <ShieldCheck className="mr-2 size-4" />
                )}
                <FormattedMessage id="dmsPage.encryption" defaultMessage="Encryption" />
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                <DropdownMenuRadioGroup
                  value={dmProtocol}
                  onValueChange={(v) => setDmProtocol(v as "auto" | "nip17" | "nip04")}
                >
                  <DropdownMenuRadioItem value="auto" className="items-start">
                    <Sparkles className="mr-2 mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0">
                      <div>
                        <FormattedMessage id="dmsPage.encryption.auto" defaultMessage="Automatic" />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <FormattedMessage
                          id="dmsPage.encryption.autoDescription"
                          defaultMessage="Private when possible, legacy only if you allow it."
                        />
                      </p>
                    </div>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="nip17" className="items-start">
                    <ShieldCheck className="mr-2 mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0">
                      <div>
                        <FormattedMessage id="dmsPage.encryption.nip17" defaultMessage="Private (NIP-17)" />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <FormattedMessage
                          id="dmsPage.encryption.nip17Description"
                          defaultMessage="Always fully private; hides that you're talking."
                        />
                      </p>
                    </div>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="nip04" className="items-start">
                    <Lock className="mr-2 mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0">
                      <div>
                        <FormattedMessage id="dmsPage.encryption.nip04" defaultMessage="Legacy (NIP-04)" />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        <FormattedMessage
                          id="dmsPage.encryption.nip04Description"
                          defaultMessage="Older encryption; leaks who's talking and when."
                        />
                      </p>
                    </div>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            )}
            {/* Disappearing messages need NIP-17 sealed rumors; hidden on legacy-pinned threads. */}
            {dm17Enabled && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Timer className="size-4 shrink-0" />
                  {/* Duration under the label: beside it, the label wraps. */}
                  <div className="min-w-0">
                    <div>
                      <FormattedMessage id="dmsPage.disappearing" defaultMessage="Disappearing messages" />
                    </div>
                    {disappearingTimer > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {formatDisappearingDuration(disappearingTimer)}
                      </p>
                    )}
                  </div>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    <FormattedMessage
                      id="dmsPage.disappearing.description"
                      defaultMessage="New messages in this chat disappear for everyone in it after the time you pick. Anyone here can change it."
                    />
                  </p>
                  <DropdownMenuRadioGroup
                    value={String(disappearingTimer)}
                    onValueChange={(v) => setDisappearingTimer(Number(v))}
                  >
                    {DISAPPEARING_PRESETS.map((preset) => (
                      <DropdownMenuRadioItem key={preset.seconds} value={String(preset.seconds)}>
                        {preset.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {!group && (
              <DropdownMenuItem
               
                onClick={() => openProfile(tryNpubEncode(peer) ?? peer)}
                onPointerEnter={() => prefetchProfile(peer)}
                onFocus={() => prefetchProfile(peer)}
              >
                <User className="size-4" />
                <FormattedMessage id="dmsPage.viewProfile" defaultMessage="View profile" />
              </DropdownMenuItem>
            )}
            {dittoProfileHref && (
              <DropdownMenuItem asChild>
                <a href={dittoProfileHref} target="_blank" rel="noopener noreferrer">
                  <DittoIcon className="size-4" />
                  <FormattedMessage id="dmsPage.viewOnDitto" defaultMessage="View on Ditto" />
                </a>
              </DropdownMenuItem>
            )}
            {/* Mute/block name ONE person: not on Note to Self (you'd hide your
                own messages) or groups (muting a member hides the whole conversation). */}
            {!noteToSelf && !group && (
              <>
                <DropdownMenuSeparator />
                {/* Its own items rather than useUserModeration's: blocking a DM peer
                    hides the whole conversation, so it confirms first. */}
                <ModerationMenuSection parts={MENU_PARTS}>
                  {mute.muted ? (
                    <DropdownMenuItem disabled={mute.pending} onClick={() => void mute.toggle()}>
                      <UserCheck className="size-4" />
                      <FormattedMessage id="dmsPage.unblockPerson" defaultMessage="Unblock person" />
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => setMuteConfirmOpen(true)}
                    >
                      <UserX className="size-4" />
                      <FormattedMessage id="dmsPage.blockPerson" defaultMessage="Block person" />
                    </DropdownMenuItem>
                  )}
                  {/* DMs have no moderator: reports go to the public network in the
                      clear, and never name the message (NIP-17 rumor ids resolve for no one). */}
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setReportOpen(true)}
                  >
                    <Flag className="size-4" />
                    <FormattedMessage id="dmsPage.reportPerson" defaultMessage="Report person" />
                  </DropdownMenuItem>
                </ModerationMenuSection>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <ChatSearchBar
          open={searchOpen}
          value={searchQuery}
          onChange={setSearchQuery}
          onClose={closeSearch}
          placeholder={intl.formatMessage({ id: "dmsPage.searchPlaceholder", defaultMessage: "Search messages…" })}
        />
      </header>

      <CallStageSlot active={inThisCall} />

      {/* "Decrypt all" also grants consent for future threads. */}
      {decryptDeclined && hasEncrypted && (
        <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/30 px-4 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground min-w-0">
            <Lock className="size-3.5 shrink-0" />
            <span className="truncate">
              <FormattedMessage
                id="dmsPage.locked"
                defaultMessage="Messages are locked. Decrypt with your signer to read them."
              />
            </span>
          </div>
          <Button size="sm" variant="secondary" className="shrink-0" onClick={decryptAll}>
            <FormattedMessage id="dmsPage.decryptAll" defaultMessage="Decrypt all" />
          </Button>
        </div>
      )}

      {normalizedSearch ? (
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable px-3 py-4">
          {searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Search className="size-10 text-muted-foreground/40 mb-3" />
              <p className="text-sm text-muted-foreground">
                <FormattedMessage id="dmsPage.search.noMatches" defaultMessage="No matching messages" />
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                <FormattedMessage
                  id="dmsPage.search.loadedOnly"
                  defaultMessage="Only loaded messages are searched. Scroll up to load more."
                />
              </p>
            </div>
          ) : (
            <>
              <p className="px-2 pb-1 text-2xs uppercase tracking-wide text-muted-foreground/80">
                <FormattedMessage
                  id="dmsPage.search.results"
                  defaultMessage="{count, plural, one {# result} other {# results}}"
                  values={{ count: searchResults.length }}
                />
              </p>
              {searchResults.map((msg) => (
                <ChatMessage
                  key={msg.id}
                  event={msg}
                  canWrite={transport.canWrite}
                  canModerate={transport.canModerate}
                  highlight={searchQuery}
                  sendStatus={transport.sendStatusFor?.(msg.id)}
                  mentionHighlight={false}
                  nameBadge={!dm17Ids.has(msg.id) ? LEGACY_BADGE : undefined}
                  continuation={false}
                />
              ))}
            </>
          )}
        </div>
      ) : (
        <MessageTimeline
          transport={transport}
          handleRef={timelineRef}
          className="flex-1 min-h-0"
          entries={entries}
          // Empty but still catching up: say so (not part of the skeleton gate — see shouldShowDmTimelineLoading).
          syncing={syncing}
          renderEntry={(entry) =>
            entry.type === "dm-timer" ? (
              <DmTimerNotice
                key={entry.id}
                author={entry.author}
                seconds={entry.seconds}
                self={user?.pubkey}
                name={name}
              />
            ) : null
          }
          emptyState={
            noteToSelf ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <NoteToSelfIcon sizePx={40} className="size-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  <FormattedMessage id="dmsPage.empty.notesTitle" defaultMessage="No notes yet" />
                </p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  <FormattedMessage
                    id="dmsPage.empty.notesDescription"
                    defaultMessage="Anything you send here is just for you, and syncs to your other devices."
                  />
                </p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <MessageSquare className="size-10 text-muted-foreground/40 mb-3" />
                <p className="text-sm text-muted-foreground">
                  <FormattedMessage id="dmsPage.empty.title" defaultMessage="No messages yet" />
                </p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  <FormattedMessage
                    id="dmsPage.empty.sayHello"
                    defaultMessage="Say hello to {name}!"
                    values={{ name: group ? <GroupName peers={peers} name={name} /> : <DisplayName pubkey={peer} name={name} /> }}
                  />
                </p>
              </div>
            )
          }
          renderMessage={(msg, continuation) => {
            const sendStatus = transport.sendStatusFor?.(msg.id);
            const failed = sendStatus === "failed";
            return encryptedIds.has(msg.id) ? (
              <DmPlaceholderRow
                key={msg.id}
                id={msg.id}
                pubkey={msg.pubkey}
                createdAt={msg.created_at}
                continuation={continuation}
                observePlaceholder={observePlaceholder}
                declined={decryptDeclined}
                onDecrypt={decryptOne}
              />
            ) : (
              <ChatMessage
                key={msg.id}
                event={msg}
                permalink={dmPermalink}
                canWrite={transport.canWrite}
                canModerate={transport.canModerate}
                sendStatus={sendStatus}
                // Closures only for failed rows, so other rows keep their memo.
                onRetry={failed && transport.retry ? () => transport.retry!(msg) : undefined}
                onDiscard={
                  failed && dm17Ids.has(msg.id) && transport.discard
                    ? () => transport.discard!(msg.id)
                    : undefined
                }
                // Every DM p-tags you; that's addressing, not a mention.
                mentionHighlight={false}
                nameBadge={!dm17Ids.has(msg.id) ? LEGACY_BADGE : undefined}
                onReply={dm17Enabled ? setReplyTo : undefined}
                onForward={handleForward}
                isEditing={editingId === msg.id}
                onEdit={
                  dm17Ids.has(msg.id) && msg.pubkey === user?.pubkey && transport.editMessage
                    ? startEditing
                    : undefined
                }
                onEditSubmit={handleEditSubmit}
                onEditCancel={cancelEditing}
                replyContext={replyContextFor(msg)}
                reactions={transport.reactionsFor?.(msg.id)}
                // Own NIP-17 messages only (kind 4 has no in-band delete).
                onDelete={
                  dm17Ids.has(msg.id) && msg.pubkey === user?.pubkey && transport.deleteMessage
                    ? transport.deleteMessage
                    : undefined
                }
                // NIP-17 rumors are unsigned: offer "View event JSON" instead.
                rumor={dm17Ids.has(msg.id) ? msg : undefined}
                knownCommands={knownCommands}
                continuation={continuation}
                active={activeId === msg.id}
                onToggleActive={toggleActive}
              />
            );
          }}
        />
      )}

      {!normalizedSearch && <TypingIndicator pubkeys={typers} />}

      {isRequest && (
        <DmRequestNotice
          peer={group ? undefined : peer}
          name={name}
          sharedCommunity={sharedCommunity}
          onBlock={group ? undefined : () => setMuteConfirmOpen(true)}
          blocking={muteUser.isPending}
        />
      )}

      {legacyBlocked && !group ? (
        <DmLegacyFallbackNotice peer={peer} name={name} onEnable={() => setLegacyAllowed(true)} />
      ) : (
        <ChatComposer
          relayUrl="dm"
          groupId={conversation}
          messages={[]}
          // From the conversation key, not the location, so the page being left can't claim it.
          shareRoute={chatRoute({ kind: "dm", peer: dmRouteParam(conversation) })}
          // A DM's recipient IS the bot, so invocations send untagged.
          botDmPeer={group ? undefined : peer}
          placeholder={noteToSelf
            ? intl.formatMessage({ id: "dmsPage.composer.note", defaultMessage: "Add a note…" })
            : intl.formatMessage({ id: "dmsPage.composer.message", defaultMessage: "Message {name}…" }, { name })}
          replyTo={replyTo}
          sealed
          onCancelReply={() => setReplyTo(undefined)}
          onJumpToReply={jumpToMessage}
          // Client-side AES-256-GCM attachments on NIP-17 only (kind 4 can't carry the key).
          encryptAttachments={dm17Enabled}
          disappearingTimer={resolveDisappearingTimer}
          // Not on touch: the keyboard would spring up mid slide-in.
          autoFocus={!isTouch}
          onTyping={publishTyping}
          sendOverride={handleSubmit}
          onEditLast={editLast}
        />
      )}

      {/* Built on first open: mounted closed, it would run every render. */}
      <MountWhenOpened open={callWarnOpen}>
        <Dialog open={callWarnOpen} onOpenChange={setCallWarnOpen}>
          <ChromeDialogContent
            title={callWarnTitle}
            className="sm:max-w-sm focus:outline-none"
            onOpenAutoFocus={(e) => {
              // Focus the surface: programmatic focus paints a ring on the button.
              e.preventDefault();
              (e.currentTarget as HTMLElement | null)?.focus();
            }}
            onCloseAutoFocus={(e) => {
              if (!callWarnToComposer.current) return;
              callWarnToComposer.current = false;
              const input = composerBoundsRef.current?.querySelector("textarea");
              if (!input) return;
              e.preventDefault();
              input.focus();
            }}
          >
            <div className="flex flex-col items-center gap-2 text-center">
              <div className="flex size-12 items-center justify-center clip-corner-lg bg-warning/15 text-warning">
                <PhoneOff className="size-6" />
              </div>
              <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
                <FormattedMessage id="dmsPage.call.warnHeading" defaultMessage="message them before you call" />
              </h2>
              <p className="text-sm text-muted-foreground">
                <FormattedMessage
                  id="dmsPage.call.warnDescription"
                  defaultMessage="{name} probably won't get your call yet. Calls only ring for people who follow you or have messaged you. Send them a message, and once they reply, you can call."
                  values={{ name: <DisplayName pubkey={peer} name={name} /> }}
                />
              </p>
            </div>
            <div className="mt-6 flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                className="flex-1 clip-corner-lg"
                onClick={() => {
                  setCallWarnOpen(false);
                  void startCall(peer);
                }}
              >
                <Phone className="size-4" />
                <FormattedMessage id="dmsPage.call.anyway" defaultMessage="Call anyway" />
              </Button>
              <Button
                type="button"
                className="flex-1 clip-corner-lg"
                onClick={() => {
                  callWarnToComposer.current = true;
                  setCallWarnOpen(false);
                }}
              >
                <MessageSquare className="size-4" />
                <FormattedMessage id="dmsPage.call.sendMessage" defaultMessage="Send a message" />
              </Button>
            </div>
          </ChromeDialogContent>
        </Dialog>
      </MountWhenOpened>

      <MountWhenOpened open={muteConfirmOpen}>
        <AlertDialog open={muteConfirmOpen} onOpenChange={setMuteConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                <FormattedMessage
                  id="dmsPage.blockConfirm.title"
                  defaultMessage="Block {name}?"
                  values={{ name: <DisplayName pubkey={peer} name={name} /> }}
                />
              </AlertDialogTitle>
              <AlertDialogDescription>
                <FormattedMessage
                  id="dmsPage.blockConfirm.description"
                  defaultMessage="This conversation will be hidden and you won't see new messages from {name}. You can unblock them later from Settings."
                  values={{ name: <DisplayName pubkey={peer} name={name} /> }}
                />
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                <FormattedMessage {...common.cancel} />
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={(e) => {
                  e.preventDefault();
                  void handleMute();
                }}
                disabled={muteUser.isPending}
              >
                {muteUser.isPending ? (
                  <FormattedMessage id="dmsPage.blocking" defaultMessage="Blocking…" />
                ) : (
                  <FormattedMessage id="dmsPage.block" defaultMessage="Block" />
                )}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </MountWhenOpened>

      {reportOpen && (
        <ReportDialog
          open={reportOpen}
          onOpenChange={setReportOpen}
          destination={{ kind: "network" }}
          target={{ pubkey: peer }}
        />
      )}
    </div>
    </ComposerBoundsProvider>
  );
});

function RecipientSuggestion({
  pubkey,
  metadata,
  imeta,
  active,
  followed,
  onSelect,
}: {
  pubkey: string;
  metadata: SearchProfile["metadata"] | undefined;
  imeta?: ProfileImeta;
  active: boolean;
  followed: boolean;
  onSelect: () => void;
}) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  // Picking yourself opens Note to Self, so label it that way.
  const noteToSelf = pubkey === user?.pubkey;
  const name = noteToSelf ? intl.formatMessage(NOTE_TO_SELF_NAME) : getDisplayName(metadata, pubkey);
  const picture = sanitizeUrl(metadata?.picture);
  const npub = nip19.npubEncode(pubkey);
  const handle = metadata?.nip05 ?? `${npub.slice(0, 12)}…${npub.slice(-6)}`;

  return (
    <button
      type="button"
      onClick={onSelect}
      data-active={active}
      className={cn(
        "flex w-full items-center gap-3 clip-corner p-2.5 text-left transition-colors",
        active ? "bg-secondary" : "hover:bg-secondary/60",
      )}
    >
      {noteToSelf ? (
        <NoteToSelfAvatar sizePx={36} className="size-9" />
      ) : (
        <Avatar shape={getAvatarShape(metadata)} className="size-9 shrink-0">
          <AvatarImage src={picture} imeta={imeta?.picture} alt={name} />
          <AvatarFallback className="bg-primary/20 text-primary text-xs">
            <AvatarInitial name={name} pubkey={pubkey} />
          </AvatarFallback>
        </Avatar>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">
            {noteToSelf ? name : <DisplayName pubkey={pubkey} name={name} />}
          </span>
          {followed && !noteToSelf && (
            <UserCheck className="size-3.5 shrink-0 text-primary" aria-label={intl.formatMessage({ id: "dmsPage.recipient.followed", defaultMessage: "You follow this person" })}
            />
          )}
        </div>
        <span className="block truncate text-xs text-muted-foreground">
          {noteToSelf
            ? intl.formatMessage({ id: "dmsPage.recipient.noteToSelf", defaultMessage: "Notes only you can read" })
            : handle}
        </span>
      </div>
    </button>
  );
}

/** A recipient not yet in search results (e.g. a pasted npub); resolves its own profile. */
function ResolvedRecipientSuggestion({
  pubkey,
  active,
  followed,
  onSelect,
}: {
  pubkey: string;
  active: boolean;
  followed: boolean;
  onSelect: () => void;
}) {
  const author = useAuthor(pubkey);
  return (
    <RecipientSuggestion
      pubkey={pubkey}
      metadata={author.data?.metadata}
      imeta={author.data?.imeta}
      active={active}
      followed={followed}
      onSelect={onSelect}
    />
  );
}

/** A chosen recipient in the group composer's "To:" field. */
function RecipientChip({ pubkey, onRemove }: { pubkey: string; onRemove: () => void }) {
  const intl = useIntl();
  const author = useAuthor(pubkey);
  const name = getDisplayName(author.data?.metadata, pubkey);
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-secondary py-0.5 pl-0.5 pr-1.5 text-sm">
      <Avatar shape={getAvatarShape(author.data?.metadata)} className="size-5 shrink-0">
        <AvatarImage src={sanitizeUrl(author.data?.metadata?.picture)} imeta={author.data?.imeta?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-primary text-monogram">
          <AvatarInitial name={name} pubkey={pubkey} />
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{name}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={intl.formatMessage({ id: "dmsPage.recipient.remove", defaultMessage: "Remove {name}" }, { name })}
        className="shrink-0 clip-corner text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

/**
 * The inline "start a new chat" pane: debounced autocomplete (follows, NIP-50,
 * pasted npub/nprofile/hex) with keyboard nav. DIRECT mode opens a thread on
 * tap; GROUP mode (entered explicitly) multi-selects into chips, so 1:1s never
 * pay a confirmation step.
 */
function NewDMPane({
  onSelectRecipients,
  onCancel,
}: {
  onSelectRecipients: (pubkeys: string[]) => void;
  onCancel: () => void;
}) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [group, setGroup] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const { data: profiles, isFetching, followedPubkeys } = useSearchProfiles(query);
  const trimmed = query.trim();

  // A pasted npub/nprofile/hex is DM-able directly; shown first, de-duped.
  const direct = resolvePubkey(query);
  const chosenSet = useMemo(() => new Set(chosen), [chosen]);
  const recipients = useMemo(() => {
    const fromSearch = (profiles ?? []).filter((p) => p.pubkey !== direct);
    const list: { pubkey: string; metadata?: SearchProfile["metadata"]; imeta?: ProfileImeta; resolved?: boolean }[] = [];
    if (direct) list.push({ pubkey: direct, resolved: true });
    for (const p of fromSearch) {
      list.push({ pubkey: p.pubkey, metadata: p.metadata, imeta: parseProfileImeta(p.event.tags, p.metadata) });
    }
    return group ? list.filter((r) => !chosenSet.has(r.pubkey)) : list;
  }, [profiles, direct, group, chosenSet]);

  useEffect(() => {
    setActiveIndex(0);
  }, [recipients.length]);

  const pick = (pubkey: string) => {
    if (!group) {
      onSelectRecipients([pubkey]);
      return;
    }
    setChosen((prev) => (prev.includes(pubkey) ? prev : [...prev, pubkey]));
    setQuery("");
  };

  // Your own copy is minted regardless, so exclude yourself from group peers.
  const groupPeers = useMemo(
    () => chosen.filter((pubkey) => pubkey !== user?.pubkey),
    [chosen, user?.pubkey],
  );
  const canStart = groupPeers.length > 0;

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === "Backspace" && group && query === "" && chosen.length > 0) {
      e.preventDefault();
      setChosen((prev) => prev.slice(0, -1));
      return;
    }
    if (e.key === "Enter" && group && recipients.length === 0 && canStart) {
      e.preventDefault();
      onSelectRecipients(groupPeers);
      return;
    }
    if (recipients.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % recipients.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + recipients.length) % recipients.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const candidate = recipients[activeIndex];
      if (candidate) pick(candidate.pubkey);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col safe-area-top">
      <header className="h-12 touch:h-[3.25rem] mx-gutter mt-1 sidebar:mt-3 px-2 sidebar:px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
        <Button
          variant="ghost"
          size="icon"
          aria-label={intl.formatMessage({ id: "dmsPage.backToConversations", defaultMessage: "Back to conversations" })}
          className="size-9 touch:size-11 shrink-0 sidebar:hidden"
          onClick={onCancel}
        >
          <ChevronLeft className="size-5" />
        </Button>
        {group ? (
          <Users className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <PenSquare className="size-4 text-muted-foreground shrink-0" />
        )}
        <h1 className="font-semibold truncate flex-1 min-w-0">
          {group ? (
            <FormattedMessage id="dmsPage.newGroup" defaultMessage="New group" />
          ) : (
            <FormattedMessage id="dmsPage.newMessage" defaultMessage="New message" />
          )}
        </h1>
        {group && (
          <Button
            size="sm"
            className="shrink-0 clip-corner-lg"
            disabled={!canStart}
            onClick={() => onSelectRecipients(groupPeers)}
          >
            <FormattedMessage id="dmsPage.newDm.start" defaultMessage="Start" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={intl.formatMessage(common.cancel)}
          className="size-8 shrink-0 text-muted-foreground hidden sidebar:inline-flex"
          onClick={onCancel}
        >
          <X className="size-4" />
        </Button>
      </header>

      <div className="px-3 pt-3 pb-2 shrink-0">
        <label htmlFor="dm-recipient" className="mb-1.5 block text-xs font-medium text-muted-foreground">
          <FormattedMessage id="dmsPage.newDm.to" defaultMessage="To:" />
        </label>
        {group && chosen.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {chosen.map((pubkey) => (
              <RecipientChip
                key={pubkey}
                pubkey={pubkey}
                onRemove={() => setChosen((prev) => prev.filter((p) => p !== pubkey))}
              />
            ))}
          </div>
        )}
        <SearchField
          id="dm-recipient"
          autoFocus
          value={query}
          onChange={setQuery}
          onKeyDown={handleKeyDown}
          placeholder={intl.formatMessage({
            id: "dmsPage.newDm.placeholder",
            defaultMessage: "Search a name or paste an npub…",
          })}
          autoComplete="off"
          busy={isFetching}
          className="h-10 touch:h-11"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-safe space-y-0.5">
        {!group && (
          <button
            type="button"
            onClick={() => setGroup(true)}
            className="flex w-full items-center gap-3 clip-corner p-2.5 text-left transition-colors hover:bg-secondary/60"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/20 text-primary">
              <Users className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                <FormattedMessage id="dmsPage.newGroup" defaultMessage="New group" />
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                <FormattedMessage id="dmsPage.newDm.groupHint" defaultMessage="Message several people at once" />
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        )}
        {recipients.length > 0 ? (
          recipients.map((r, index) =>
            r.resolved ? (
              <ResolvedRecipientSuggestion
                key={r.pubkey}
                pubkey={r.pubkey}
                active={index === activeIndex}
                followed={followedPubkeys.has(r.pubkey)}
                onSelect={() => pick(r.pubkey)}
              />
            ) : (
              <RecipientSuggestion
                key={r.pubkey}
                pubkey={r.pubkey}
                metadata={r.metadata}
                imeta={r.imeta}
                active={index === activeIndex}
                followed={followedPubkeys.has(r.pubkey)}
                onSelect={() => pick(r.pubkey)}
              />
            ),
          )
        ) : (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <PenSquare className="size-8 text-primary/70" />
            <p className="mx-auto max-w-xs text-sm text-muted-foreground">
              {trimmed
                ? isFetching
                  ? <FormattedMessage id="dmsPage.newDm.searching" defaultMessage="Searching…" />
                  : (
                    <FormattedMessage
                      id="dmsPage.newDm.noResults"
                      defaultMessage="No one found. Try a different name, or paste an npub."
                    />
                  )
                : group
                  ? canStart
                    ? <FormattedMessage id="dmsPage.newDm.addMore" defaultMessage="Add anyone else, or press Start." />
                    : <FormattedMessage id="dmsPage.newDm.searchGroup" defaultMessage="Search for the people to include." />
                  : (
                    <FormattedMessage
                      id="dmsPage.newDm.hint"
                      defaultMessage="Search for someone by name, or paste their npub to start a conversation."
                    />
                  )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Cold-start placeholder rows (no snapshot), matching ConversationRow's
 * geometry; fixed widths so they don't reflow.
 */
const SKELETON_WIDTHS = [
  "70%", "45%", "58%", "38%", "64%", "50%", "72%", "42%",
  "55%", "66%", "34%", "61%", "47%", "75%", "40%", "53%",
] as const;

/** A group's joined names, or a skeleton until every participant's profile has resolved. */
function GroupName({ peers, name }: { peers: readonly string[]; name: string }) {
  return useProfilesPending(peers) ? <NameSkeleton /> : <>{name}</>;
}

function ConversationRowSkeletons() {
  return (
    <div aria-hidden>
      {SKELETON_WIDTHS.map((width, i) => (
        <div key={i} className="flex items-center gap-3 w-full px-2.5 py-2.5">
          <Skeleton className="size-12 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-4 w-28 max-w-full" />
            <Skeleton className="h-3.5 max-w-full" style={{ width }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ConversationSectionHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-2.5 pt-3 pb-px text-2xs font-semibold uppercase tracking-wider text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Approx height of one conversation row (avatar size-12 + py-2.5), for the gate placeholder. */
const ROW_MIN_H = 68;
/**
 * Rows rendered eagerly before gating (a tall viewport's worth). Gated by
 * POSITION, not list length: rows are expensive (avatar, profile, presence
 * queries), and DeferredRow never un-shows, so length thresholds break as lists grow.
 */
const EAGER_ROWS = 12;

type DmListView = "inbox" | "requests";

/**
 * One conversation-list row. `latest` is absent for threads with no local
 * message yet; `indexedLatest` is deliberately kept out of `latest`.
 */
interface DmListRow {
  conversation: string;
  peers: string[];
  latest?: NostrRumor;
  /** Synced ordering/close marker only; never a preview or unread source. */
  indexedLatest?: DmConversationLatest;
  plaintext?: string;
  mine: boolean;
}

// eslint-disable-next-line react-refresh/only-export-components
export function dmListRowLatestMarker(
  row: Pick<DmListRow, "latest" | "indexedLatest">,
): DmLatestMarker | undefined {
  if (!row.latest) {
    return row.indexedLatest
      ? { id: row.indexedLatest.id, created_at: row.indexedLatest.createdAt }
      : undefined;
  }

  if (!row.indexedLatest || row.latest.created_at >= row.indexedLatest.createdAt) {
    return row.latest;
  }

  return { id: row.indexedLatest.id, created_at: row.indexedLatest.createdAt };
}

function dmListRowCreatedAt(row: DmListRow): number {
  return Math.max(row.latest?.created_at ?? 0, row.indexedLatest?.createdAt ?? 0);
}

/**
 * One rumor per NIP-17 latest record: the row list is re-derived on every
 * switch, and a fresh object would re-render every memoized row as a new `preview`.
 */
const dm17LatestRumors = new WeakMap<Dm17Conversation["latest"], NostrRumor>();

function dm17LatestRumor(latest: Dm17Conversation["latest"]): NostrRumor {
  let rumor = dm17LatestRumors.get(latest);
  if (!rumor) {
    rumor = {
      id: latest.rumorId,
      pubkey: latest.author,
      created_at: latest.createdAt,
      kind: latest.kind,
      content: latest.content,
      tags: latest.tags,
    };
    dm17LatestRumors.set(latest, rumor);
  }
  return rumor;
}

/**
 * The request-tier entry row. Deliberately low-salience (muted count, no rail
 * badge): flooding a stranger's inbox must not light up their UI.
 */
function RequestsEntryRow({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Phones: 4px up, keeping pace with the rail's tighter mobile spacing.
      className="flex items-center gap-3 w-full px-2 py-2.5 max-sidebar:-mt-1 clip-corner text-left transition-colors hover:bg-secondary/60"
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Inbox className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-chat font-medium truncate">
          <FormattedMessage id="dmsPage.requests.entryTitle" defaultMessage="Message requests" />
        </div>
        <div className="text-sm text-muted-foreground truncate">
          <FormattedMessage
            id="dmsPage.requests.entryCount"
            defaultMessage="{count, plural, one {# person you don't follow} other {# people you don't follow}}"
            values={{ count }}
          />
        </div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

/** Exported for DMsPage.list.test.tsx, which renders it directly. */
export function ConversationList({
  rows,
  requestRows,
  view,
  onViewChange,
  previews,
  events,
  activePeer,
  dmSupported,
  isLoading,
  hasUnread,
  onMarkAllRead,
  onCompose,
  openPeer,
  startDm,
  closePeer,
  dismissRequests,
  loadMore,
  hasMore,
  isLoadingMore,
  className,
}: {
  rows: DmListRow[];
  requestRows: DmListRow[];
  view: DmListView;
  onViewChange: (view: DmListView) => void;
  previews: Record<string, string>;
  events: NostrRumor[];
  activePeer: string | undefined;
  dmSupported: boolean;
  isLoading: boolean;
  hasUnread: boolean;
  onMarkAllRead: () => void;
  onCompose: () => void;
  openPeer: (conversation: string) => void;
  /** Opens (or starts) a 1:1 with a person who may have no conversation yet. */
  startDm: (pubkey: string) => void;
  closePeer: (conversation: string, latest: DmLatestMarker | undefined) => void;
  /** Close every request row at once. */
  dismissRequests?: () => void;
  loadMore: () => Promise<number>;
  hasMore: boolean;
  isLoadingMore: boolean;
  className?: string;
}) {
  const { user } = useCurrentUser();
  const { getLastRead } = useReadState();
  const { registerCallBarSlot, activeCall } = useCall();
  const { config } = useAppContext();
  const muteUser = useMuteUser();
  const { toast } = useToast();
  const intl = useIntl();
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const requesting = view === "requests";

  // Tier-2 hint, only while the request list shows; 1:1 requests only.
  const requestPeers = useMemo(
    () => requestRows.filter((c) => c.peers.length === 1).map((c) => c.peers[0]),
    [requestRows],
  );
  const sharedCommunities = useSharedCommunities(requestPeers, requesting);

  // Request-tier older-history recovery and the last press's outcome.
  const backfill = useDm17Backfill();
  const [recovered, setRecovered] = useState<string[] | undefined>(undefined);
  const loadOlderRequests = useCallback(async () => {
    setRecovered(undefined);
    setRecovered(await backfill.loadOlder());
  }, [backfill]);
  // Count only what this view gained; most recovered history lands in the inbox.
  const olderFound = useMemo(
    () =>
      recovered === undefined
        ? undefined
        : recovered.filter((key) => requestRows.some((c) => c.conversation === key)).length,
    [recovered, requestRows],
  );

  const blockPeer = useCallback(
    async (peer: string) => {
      try {
        await muteUser.mutateAsync(peer);
      } catch (e) {
        toast({
          title: t({ id: "dmsPage.blockFailed", defaultMessage: "Couldn't block" }),
          description: e instanceof Error
            ? e.message
            : t({ id: "dmsPage.blockFailedRetry", defaultMessage: "Please try again." }),
          variant: "destructive",
        });
      }
    },
    [muteUser, toast],
  );

  // Local search over decrypted history (both planes); never prompts the signer.
  const messageMatches = useDmMessageSearch(search, events, user?.pubkey);
  const historyIncomplete = useDm17HistoryIncomplete(search.trim().length > 0);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus({ preventScroll: true });
  }, [searchOpen]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearch("");
  }, []);

  // Back clears the search before leaving the list, but only while the list is
  // on screen; behind an open chat, back is the chat's.
  const isDesktop = useIsDesktop();
  const listShowing = useListShowing();
  useAndroidBack(() => {
    closeSearch();
    return true;
  }, searchOpen && (isDesktop || listShowing), "overlay");

  // Followed people with no 1:1 in the list yet, so search doubles as a way to start one.
  const followMatches = useFollowSearch(search, searchOpen && !requesting);
  const followSuggestions = useMemo(() => {
    if (followMatches.length === 0) return followMatches;
    const listed = new Set([...rows, ...requestRows].map((r) => r.conversation));
    return followMatches.filter((p) => p.pubkey !== user?.pubkey && !listed.has(p.pubkey));
  }, [followMatches, rows, requestRows, user?.pubkey]);

  // Pinned rows get their own section; both stay newest-first.
  const { pinned: pinnedPeers, isPinned, togglePin } = usePinnedDms();
  const { isOnRail, toggleRail } = useRailDms();
  const [pinnedRows, otherRows] = useMemo(() => {
    const pinnedSet = new Set(pinnedPeers);
    return [
      rows.filter((c) => pinnedSet.has(c.conversation)),
      rows.filter((c) => !pinnedSet.has(c.conversation)),
    ];
  }, [rows, pinnedPeers]);

  // Searching gives a flat list (rows self-hide, so headers could label nothing).
  const sectioned = search.trim().length === 0 && pinnedRows.length > 0;

  // No gating while searching: placeholders would reserve height for self-hidden rows.
  const gateRows = search.trim().length === 0;

  const onlyNoteToSelf = rows.length === 1 && rows[0]?.conversation === user?.pubkey;
  // A synced roster is final enough to paint while message history catches up.
  const hasSyncedRoster = rows.some((row) => row.indexedLatest !== undefined);

  // Read at call time so the actions object keeps one identity.
  const rowActionsRef = useRef({ openPeer, togglePin, toggleRail, closePeer, blockPeer, rows, requestRows });
  rowActionsRef.current = { openPeer, togglePin, toggleRail, closePeer, blockPeer, rows, requestRows };
  const rowActions = useMemo<ConversationRowActions>(() => ({
    open: (conversation) => rowActionsRef.current.openPeer(conversation),
    togglePin: (conversation) => rowActionsRef.current.togglePin(conversation),
    toggleRail: (conversation) => rowActionsRef.current.toggleRail(conversation),
    close: (conversation) => {
      const { closePeer: close, rows: all, requestRows: requests } = rowActionsRef.current;
      const row = all.find((r) => r.conversation === conversation)
        ?? requests.find((r) => r.conversation === conversation);
      close(conversation, row ? dmListRowLatestMarker(row) : undefined);
    },
    block: (peer) => void rowActionsRef.current.blockPeer(peer),
  }), []);

  const renderRow = (c: DmListRow, index: number, request = false) => (
    <DeferredRow key={c.conversation} active={gateRows && index >= EAGER_ROWS} minHeight={ROW_MIN_H}>
    <ConversationRow
      peers={c.peers}
      // Hidden previews drop the whole line; a search hit still shows what was typed.
      preview={config.showDmPreviews ? c.latest : undefined}
      previewText={config.showDmPreviews ? c.plaintext ?? previews[c.conversation] : undefined}
      query={search}
      messageMatch={messageMatches.get(c.conversation)?.text}
      unread={
        c.latest !== undefined &&
        c.latest.pubkey !== user?.pubkey &&
        c.latest.created_at > getLastRead(dmReadKey(c.conversation)) &&
        c.conversation !== activePeer
      }
      active={c.conversation === activePeer}
      pinned={isPinned(c.conversation)}
      onRail={isOnRail(c.conversation)}
      request={request}
      sharedCommunity={request ? sharedCommunities.get(c.conversation) : undefined}
      inCall={Boolean(activeCall?.dmPeer) && activeCall?.dmPeer === c.conversation}
      selfPubkey={user?.pubkey}
      conversation={c.conversation}
      // Note to Self is always re-added (withNoteToSelf), so it can't close.
      closable={c.conversation !== user?.pubkey}
      actions={rowActions}
    />
    </DeferredRow>
  );

  // Slot for the persistent desktop call bar (like ChannelSidebar).
  const callBarRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = callBarRef.current;
    if (!el) return;
    return registerCallBarSlot(el);
  }, [registerCallBarSlot]);

  // Page older conversations near the bottom (per-relay cursors, as in useDMConversations).
  const handleListScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      if (!hasMore || isLoadingMore) return;
      const el = e.currentTarget;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
        void loadMore();
      }
    },
    [hasMore, isLoadingMore, loadMore],
  );

  const markAllReadLabel = intl.formatMessage({ id: "dmsPage.list.markAllRead", defaultMessage: "Mark all as read" });
  const searchLabel = intl.formatMessage({ id: "dmsPage.list.search", defaultMessage: "Search conversations" });
  const newMessageLabel = intl.formatMessage({ id: "dmsPage.newMessage", defaultMessage: "New message" });

  const showRequestsEntry = config.showDmRequests && requestRows.length > 0 && search.trim().length === 0;

  return (
    <aside
      className={cn(
        // No `safe-area-top`: the header's padding carries the inset (like ChannelSidebarView).
        "relative flex flex-col min-w-0 shrink-0 bg-chrome",
        className,
      )}
    >
      {/* Phones: 2px tighter, keeping pace with the rail's tighter mobile spacing. */}
      <div className="px-3 pt-[calc(0.625rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))] sidebar:pt-[calc(0.75rem+var(--safe-area-inset-top,env(safe-area-inset-top,0px)))] shrink-0">
        <div className="relative overflow-hidden">
          <div
            className={cn(
              // Desktop: the top-bar band (12-60px). Rows then step by the rail's 68px, the first
              // avatar exactly over the rail's DM icon (80-128px). Phones hold the inbox's
              // button height while Requests hides them, so both lists start on one line.
              "flex items-center justify-between py-1 min-h-10 touch:min-h-[3.25rem] sidebar:h-12 sidebar:py-0",
              requesting ? "pl-0" : "pl-2",
            )}
          >
            {requesting ? (
              <button
                type="button"
                onClick={() => onViewChange("inbox")}
                className="flex items-center gap-1 pr-2 py-1 rounded text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
              >
                <ChevronLeft className="size-4" aria-hidden />
                <FormattedMessage id="dmsPage.list.requests" defaultMessage="Requests" />
              </button>
            ) : (
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <FormattedMessage id="dmsPage.list.messages" defaultMessage="Messages" />
              </span>
            )}
            <div className={cn("flex items-center gap-2", requesting && "hidden")}>
              {hasUnread && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 touch:size-11 shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={markAllReadLabel}
                      onClick={onMarkAllRead}
                    >
                      <CheckCheck className="size-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{markAllReadLabel}</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 touch:size-11 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={searchLabel}
                    aria-pressed={searchOpen}
                    onClick={() => setSearchOpen(true)}
                  >
                    <Search className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{searchLabel}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 touch:size-11 shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={newMessageLabel}
                    onClick={onCompose}
                  >
                    <Plus className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{newMessageLabel}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          <div
            className={cn(
              "absolute inset-y-0 inset-x-0 z-10 flex items-center gap-1.5 pl-2",
              "bg-chrome",
              "transition-transform duration-300 ease-in-out",
              searchOpen
                ? "transform-none pointer-events-auto"
                : "translate-x-full pointer-events-none",
            )}
          >
            <Search className="size-4 text-muted-foreground shrink-0" />
            <Input
              ref={searchInputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
              }}
              placeholder={intl.formatMessage({
                id: "dmsPage.list.searchPlaceholder",
                defaultMessage: "Search messages or people…",
              })}
              aria-label={searchLabel}
              className="h-8 touch:h-10 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={intl.formatMessage({ id: "dmsPage.list.closeSearch", defaultMessage: "Close search" })}
              className="size-8 touch:size-10 shrink-0 text-muted-foreground"
              onClick={closeSearch}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* pan-y: a scroller re-allows every pan, letting the browser claim the close swipe. */}
      <div className="flex-1 overflow-y-auto touch-pan-y px-3 py-2 sidebar:pt-2.5" onScroll={handleListScroll}>
        {dmSupported && !requesting && <DmInboxNotice dismissible className="mb-2" />}
        {!dmSupported ? (
          <p className="text-sm text-muted-foreground p-3">
            <FormattedMessage
              id="dmsPage.list.unsupported"
              defaultMessage="Your signer doesn't support encryption, so direct messages are unavailable."
            />
          </p>
        ) : requesting ? (
          <>
            <p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">
              <FormattedMessage
                id="dmsPage.requests.description"
                defaultMessage="Messages from people you don't follow. Reply to one and it moves to your inbox. Nobody here is told you've seen theirs."
              />
            </p>
            {dismissRequests && requestRows.length > 1 && (
              <div className="flex justify-end px-1 pb-2">
                <Button variant="secondary" size="sm" onClick={dismissRequests}>
                  <X className="size-4" />
                  <FormattedMessage id="dmsPage.requests.dismissAll" defaultMessage="Dismiss all" />
                </Button>
              </div>
            )}
            {requestRows.map((c, i) => renderRow(c, i, true))}
            {/* Sync only moves forward, so older-only senders need explicit backfill (useDm17Backfill). */}
            <div className="flex flex-col items-center gap-1 py-3">
              {backfill.hasMore ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  disabled={backfill.isLoading}
                  onClick={() => void loadOlderRequests()}
                >
                  {backfill.isLoading ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      <FormattedMessage id="dmsPage.requests.looking" defaultMessage="Looking…" />
                    </>
                  ) : (
                    <FormattedMessage id="dmsPage.requests.loadOlder" defaultMessage="Look for older requests" />
                  )}
                </Button>
              ) : (
                <p className="text-xs text-muted-foreground">
                  <FormattedMessage
                    id="dmsPage.requests.exhausted"
                    defaultMessage="That's everything your relays still have."
                  />
                </p>
              )}
              {olderFound !== undefined && (
                <p className="text-xs text-muted-foreground">
                  <FormattedMessage
                    id="dmsPage.requests.olderFound"
                    defaultMessage="{count, plural, =0 {No older requests found.} one {Found # older request.} other {Found # older requests.}}"
                    values={{ count: olderFound }}
                  />
                </p>
              )}
            </div>
          </>
        ) : isLoading && !hasSyncedRoster ? (
          <ConversationRowSkeletons />
        ) : (
          <>
            {historyIncomplete && (
              <p className="flex items-center gap-1.5 px-2 pb-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
                <FormattedMessage
                  id="dmsPage.list.historyIncomplete"
                  defaultMessage="Older messages are still downloading, so some may not show up yet."
                />
              </p>
            )}
            {/* The request entry covers the whole list; hidden while searching. */}
            {showRequestsEntry && (
              <RequestsEntryRow
                count={requestRows.length}
                onClick={() => onViewChange("requests")}
              />
            )}
            {sectioned ? (
              <>
                {/* First in the list it needs room under the top bar; after the requests row it doesn't. */}
                <ConversationSectionHeader className={showRequestsEntry ? "pt-0.5" : "pt-[9px]"}>
                  <FormattedMessage id="dmsPage.list.pinned" defaultMessage="Pinned" />
                </ConversationSectionHeader>
                {pinnedRows.map((c, i) => renderRow(c, i))}
                {otherRows.length > 0 && (
                  <ConversationSectionHeader className="pt-1">
                    <FormattedMessage id="dmsPage.list.recent" defaultMessage="Recent" />
                  </ConversationSectionHeader>
                )}
                {/* Numbering continues across sections (position in the scroll container is what matters). */}
                {otherRows.map((c, i) => renderRow(c, pinnedRows.length + i))}
              </>
            ) : (
              [...pinnedRows, ...otherRows].map((c, i) => renderRow(c, i))
            )}
            {followSuggestions.length > 0 && (
              <>
                <ConversationSectionHeader>
                  <FormattedMessage id="dmsPage.list.peopleYouFollow" defaultMessage="People you follow" />
                </ConversationSectionHeader>
                {followSuggestions.map((p) => (
                  <RecipientSuggestion
                    key={p.pubkey}
                    pubkey={p.pubkey}
                    metadata={p.metadata}
                    imeta={parseProfileImeta(p.event.tags, p.metadata)}
                    active={false}
                    followed={false}
                    onSelect={() => startDm(p.pubkey)}
                  />
                ))}
              </>
            )}
            {/* Note to Self is always a row, so the hint sits under it. */}
            {onlyNoteToSelf && requestRows.length === 0 && search.trim().length === 0 && (
              <p className="text-sm text-muted-foreground p-3">
                <FormattedMessage
                  id="dmsPage.list.empty"
                  defaultMessage="No conversations yet. Start one with the + button."
                />
              </p>
            )}
            {isLoadingMore && (
              <div className="flex justify-center py-3">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </>
        )}
      </div>

      <div ref={callBarRef} className="empty:hidden shrink-0" />

      <div className="px-3 pb-[var(--bottom-chrome-pad)] sidebar:pb-[var(--safe-area-pad-bottom-tight)] shrink-0">
        <div className="sidebar:pb-2">
          <LoginArea className="w-full flex" />
        </div>
      </div>
    </aside>
  );
}

/**
 * Top-level Direct Messages surface (account-level, not per server). DMs ride
 * legacy NIP-04 kind 4 or NIP-17 sealed rumors over the user's own relays.
 */
export function DMsPage() {
  const navigate = useNavigate();
  const stableNavigate = useStableNavigate();
  const { peer: rawPeer } = useParams<{ peer: string }>();
  const { user } = useCurrentUser();
  const self = user?.pubkey;
  const dmSupported = useDMSupport();
  const dm17Supported = useDm17Support();
  const { config } = useAppContext();
  const showPreviews = config.showDmPreviews;
  const {
    conversations,
    previews,
    events,
    isLoading: kind4Loading,
    loadMore,
    hasMore,
    isLoadingMore,
  } = useDMConversations({ decryptPreviews: showPreviews });
  // Interactive: the DMs page may legitimately raise the one-time decrypt-consent prompt.
  const { conversations: dm17Conversations, isLoading: dm17Loading } = useDm17Conversations({
    interactive: true,
  });
  const indexedConversations = useDmConversationIndex();
  const indexReady = useDmConversationIndexReady();
  const { isKnown, isLoading: followsLoading } = useKnownDmPeers();
  const { mutedPubkeys, ready: muteReady } = useMutedPubkeys();
  const { accept } = useAcceptedDms();
  const { started: startedPeers } = useStartedDms();
  const { close: closeDm, closeMany: closeManyDms, reopen: reopenDm, reopenForNewMessages, isClosed: isDmClosed } = useClosedDms();
  const [composing, setComposing] = useState(false);
  const [listView, setListView] = useState<DmListView>("inbox");

  // True until EVERY input to `rows` settles; a partial list is wrong and
  // re-sorts, so show the snapshot/roster/skeletons meanwhile. (`kind4Loading`
  // covers the mute set.)
  const isLoading = kind4Loading || dm17Loading || followsLoading || !muteReady || !indexReady;

  // One npub (1:1) or several (group), canonicalized so hand-ordered links can't fork a conversation.
  const activePeer = parseDmRouteParam(rawPeer);

  // Tell the native notification service this thread is on screen. Must match
  // its `enqueueRoomMessage` key: `dm:<conversationKey>`.
  useActiveRoom(activePeer ? `dm:${activePeer}` : undefined);

  // The last thread opened, which Android back from the list returns to; unlike
  // `renderedPeer` it outlives the slid-out thread's unmount.
  const [returnPeer, setReturnPeer] = useState(activePeer);
  if (activePeer && returnPeer !== activePeer) setReturnPeer(activePeer);

  // Lags `activePeer` so the thread stays mounted while sliding out on mobile.
  // Under the revealed mobile list it stays on `returnPeer`, so a swipe back
  // drags in the thread itself rather than the empty state.
  const swipeLayout = useSwipeLayout();
  const [renderedPeer, setRenderedPeer] = useState(activePeer);
  useEffect(() => {
    if (activePeer) {
      setRenderedPeer(activePeer);
      return;
    }
    if (swipeLayout && !composing) {
      setRenderedPeer(returnPeer);
      return;
    }
    // Drop the slid-out thread at IDLE (bounded by a timeout): its unmount is a
    // big synchronous commit that would stutter the end of the settle transition.
    let idleId: number | undefined;
    const timer = setTimeout(() => {
      if (typeof requestIdleCallback === "function") {
        idleId = requestIdleCallback(() => setRenderedPeer(undefined), { timeout: 1000 });
      } else {
        setRenderedPeer(undefined);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      if (idleId !== undefined) cancelIdleCallback(idleId);
    };
  }, [activePeer, swipeLayout, composing, returnPeer]);

  // Composing takes over the thread column; drop any lingering thread.
  useEffect(() => {
    if (composing) setRenderedPeer(undefined);
  }, [composing]);

  // Merge kind-4 and NIP-17 rows per conversation (newest wins), then split by
  // `isKnown` into inbox and requests. Index-only hints enter the inbox only
  // after the trust gate and never become requests.
  const [rows, requestRows] = useMemo(() => {
    // Kind 4 is pairwise, so its rows merge only with the same person's NIP-17 1:1.
    const byConversation = new Map<string, DmListRow>();
    for (const c of conversations) {
      byConversation.set(c.peer, {
        conversation: c.peer,
        peers: [c.peer],
        latest: c.latest,
        mine: c.mine,
      });
    }
    for (const c of dm17Conversations) {
      const existing = byConversation.get(c.key);
      // Participation is sticky across planes.
      const mine = (existing?.mine ?? false) || c.mine;
      if (existing?.latest && existing.latest.created_at >= c.latest.createdAt) {
        existing.mine = mine;
        continue;
      }
      byConversation.set(c.key, {
        conversation: c.key,
        peers: c.peers,
        latest: dm17LatestRumor(c.latest),
        plaintext: c.latest.content,
        mine,
      });
    }

    // The encrypted index is a discovery hint only: re-check known/mute; failures stay absent.
    for (const indexed of indexedConversations) {
      const peers = dmConvPeers(indexed.key);
      if (peers.length === 0 || peers.some((peer) => mutedPubkeys.has(peer))) continue;
      const existing = byConversation.get(indexed.key);
      if (existing) {
        existing.mine ||= indexed.mine;
        existing.indexedLatest = indexed.latest;
        continue;
      }
      if (!peers.every((peer) => isKnown(peer, indexed.mine))) continue;
      byConversation.set(indexed.key, {
        conversation: indexed.key,
        peers,
        indexedLatest: indexed.latest,
        mine: indexed.mine,
      });
    }
    const sorted = [...byConversation.values()].sort(
      (a, b) => dmListRowCreatedAt(b) - dmListRowCreatedAt(a),
    );
    const known: DmListRow[] = [];
    const requests: DmListRow[] = [];
    // A group is in the inbox only if EVERY participant is known.
    for (const c of sorted) {
      if (c.peers.every((peer) => isKnown(peer, c.mine))) known.push(c);
      // Index-only rows never become requests (stale self docs mustn't create stranger surfaces).
      else if (c.latest) requests.push(c);
    }
    // Threads seeded by a chat link (`/<npub>`) persist after navigating away; oldest-started first.
    for (const peer of startedPeers) {
      if (peer === activePeer) continue; // the rule below already places it
      if (peer === self) continue; // Note to Self places itself — see withNoteToSelf
      if (sorted.some((c) => c.conversation === peer)) continue; // it has real messages
      known.unshift({
        conversation: peer,
        peers: [peer],
        mine: false,
      });
    }
    // A message-less navigated-to peer was deliberately started: inbox, not
    // requests. Note to Self is excluded (hoisting it on open would move the row).
    if (activePeer && activePeer !== self && !sorted.some((c) => c.conversation === activePeer)) {
      known.unshift({
        conversation: activePeer,
        peers: dmConvPeers(activePeer),
        mine: false,
      });
    }
    return [known, requests];
  }, [
    conversations,
    dm17Conversations,
    indexedConversations,
    mutedPubkeys,
    activePeer,
    isKnown,
    startedPeers,
    self,
  ]);

  // Persist settled MAIN-INBOX rows only; relay publication is coalesced
  // separately (a minute) to avoid signer-prompt streams.
  useEffect(() => {
    if (isLoading || !self) return;
    const records = rows.flatMap((row) => row.latest ? [{
      key: row.conversation,
      latest: { createdAt: row.latest.created_at, id: row.latest.id },
      mine: row.mine,
    }] : []);
    if (records.length === 0) return;
    const timer = setTimeout(() => void recordDmConversationIndex(self, records), 800);
    return () => clearTimeout(timer);
  }, [isLoading, rows, self]);

  // A close hides only the current latest message; a new message reopens it and drops the marker.
  useEffect(() => {
    reopenForNewMessages([...rows, ...requestRows].map((r) => ({
      peer: r.conversation,
      latest: dmListRowLatestMarker(r),
    })));
  }, [rows, requestRows, reopenForNewMessages]);

  // Note to Self ignores close markers (it's always shown).
  const isHidden = useCallback(
    (row: DmListRow) => row.conversation !== self
      && isDmClosed(row.conversation, dmListRowLatestMarker(row)),
    [self, isDmClosed],
  );

  const visibleRows = useMemo(() => rows.filter((row) => !isHidden(row)), [rows, isHidden]);
  const visibleRequestRows = useMemo(() => requestRows.filter((row) => !isHidden(row)), [requestRows, isHidden]);

  const dismissRequests = useCallback(() => {
    closeManyDms(visibleRequestRows.map((row) => ({ peer: row.conversation, latest: dmListRowLatestMarker(row) })));
    if (activePeer && visibleRequestRows.some((row) => row.conversation === activePeer)) {
      setRenderedPeer(undefined);
      navigate("/dm");
    }
  }, [closeManyDms, visibleRequestRows, activePeer, navigate]);

  // Opening a request switches the list INTO the request view (never out of it mid-thread).
  useEffect(() => {
    if (activePeer && requestRows.some((c) => c.conversation === activePeer)) setListView("requests");
  }, [activePeer, requestRows]);
  useEffect(() => {
    if (visibleRequestRows.length === 0) setListView("inbox");
  }, [visibleRequestRows.length]);
  // Back from the request list returns to the inbox, ahead of SwipeReveal's
  // root-screen back (leave the app), which applies only there.
  useAndroidBack(() => {
    setListView("inbox");
    return true;
  }, listView === "requests" && !activePeer && !composing, "overlay");

  // Restored snapshot of the final merged OUTCOME, so live rows replace it without reshuffling.
  const restoredRows = useMemo(() => {
    const snapshot = readDmListSnapshot(user?.pubkey);
    return (snapshot ?? []).map((r) => ({
      conversation: r.peer,
      // Every key is its participant list (see `dmConvKey`), so old bare keys decode too.
      peers: dmConvPeers(r.peer),
      latest: {
        id: r.eventId ?? "",
        pubkey: r.author,
        created_at: r.createdAt,
        kind: 4,
        content: "",
        // Emoji tags so restored previews render custom emoji on the first frame.
        tags: r.emojiTags ?? [],
      } satisfies NostrRumor,
      plaintext: r.preview,
      mine: r.mine,
    }));
  }, [user?.pubkey]);

  const visibleRestoredRows = useMemo(
    () => restoredRows.filter((row) => !isHidden(row)),
    [restoredRows, isHidden],
  );

  /**
   * Guarantee the Note to Self row (appended last only while message-less),
   * for the restored snapshot too, while the snapshot writer sees real rows only.
   */
  const withNoteToSelf = useCallback(
    (list: DmListRow[]): DmListRow[] => {
      if (!self || list.some((r) => r.conversation === self)) return list;
      return [
        ...list,
        {
          conversation: self,
          peers: [self],
          mine: true,
        },
      ];
    },
    [self],
  );

  // Skeletons only on a genuine cold start (no snapshot).
  const showSkeletons = isLoading && visibleRestoredRows.length === 0;
  const displayRows = useMemo(() => {
    if (!isLoading || visibleRestoredRows.length === 0) return withNoteToSelf(visibleRows);
    if (!activePeer || visibleRestoredRows.some((r) => r.conversation === activePeer)) {
      return withNoteToSelf(visibleRestoredRows);
    }
    return withNoteToSelf([
      {
        conversation: activePeer,
        peers: dmConvPeers(activePeer),
        mine: false,
      },
      ...visibleRestoredRows,
    ]);
  }, [isLoading, visibleRestoredRows, visibleRows, activePeer, withNoteToSelf]);

  // Persist the settled INBOX rows (never partial, never requests), debounced;
  // an empty list clears the snapshot.
  useEffect(() => {
    const self = user?.pubkey;
    if (isLoading || !self) return;
    const timer = setTimeout(() => {
      writeDmListSnapshot(
        self,
        visibleRows.flatMap((c) => c.latest ? [{
            peer: c.conversation,
            eventId: c.latest.id,
            createdAt: c.latest.created_at,
            author: c.latest.pubkey,
            // Hidden previews stay off disk too: the snapshot is plaintext at rest.
            preview: showPreviews ? c.plaintext ?? previews[c.conversation] : undefined,
            emojiTags: pickEmojiTags(c.latest.tags),
            // So a restored disappearing preview drops after its deadline.
            expiresAt: expirationOf(c.latest.tags),
            mine: c.mine,
          }] : []),
      );
    }, 800);
    return () => clearTimeout(timer);
  }, [isLoading, visibleRows, previews, showPreviews, user?.pubkey]);

  const openPeer = useCallback(
    (conversation: string) => {
      setComposing(false);
      // Mount synchronously so the empty state doesn't flash between compose and thread.
      setRenderedPeer(conversation);
      navigate(chatRoute({ kind: "dm", peer: dmRouteParam(conversation) }));
    },
    [navigate],
  );

  // Accept every participant: the split requires ALL to be known.
  const acceptConversation = useCallback(
    (conversation: string) => {
      for (const peer of dmConvPeers(conversation)) accept(peer);
    },
    [accept],
  );

  // Choosing recipients accepts them, so the new thread doesn't land in Requests.
  const openNewRecipients = useCallback(
    (pubkeys: string[]) => {
      const conversation = dmConvKey([...new Set(pubkeys)].sort());
      reopenDm(conversation);
      acceptConversation(conversation);
      openPeer(conversation);
    },
    [reopenDm, acceptConversation, openPeer],
  );

  const startDm = useCallback((pubkey: string) => openNewRecipients([pubkey]), [openNewRecipients]);

  const closePeer = useCallback(
    (conversation: string, latest: DmLatestMarker | undefined) => {
      closeDm(conversation, latest);
      if (returnPeer === conversation) setReturnPeer(undefined);
      if (activePeer === conversation) {
        setRenderedPeer(undefined);
        navigate("/dm");
      }
    },
    [closeDm, activePeer, returnPeer, navigate],
  );

  // Mark conversations read where the peer sent the latest (both planes; stamps are monotonic).
  const { markRead } = useReadState();
  const hasUnreadDms = useHasUnreadDMs();
  // Requests are skipped: don't quietly triage an unseen pile.
  const markAllDmsRead = useCallback(() => {
    if (!user) return;
    for (const c of conversations) {
      if (c.latest.pubkey !== user.pubkey && isKnown(c.peer, c.mine)) {
        markRead(dmReadKey(c.peer), c.latest.created_at);
      }
    }
    for (const c of dm17Conversations) {
      if (c.latest.author !== user.pubkey && c.peers.every((peer) => isKnown(peer, c.mine))) {
        markRead(dmReadKey(c.key), c.latest.createdAt);
      }
    }
  }, [user, conversations, dm17Conversations, isKnown, markRead]);

  // Reveal the list by clearing the active peer and compose; stable identity.
  const revealList = useCallback(() => {
    setComposing(false);
    stableNavigate("/dm");
  }, [stableNavigate]);
  const renderedPeers = useMemo(
    () => (renderedPeer ? dmConvPeers(renderedPeer) : []),
    [renderedPeer],
  );
  const acceptRendered = useCallback(() => {
    if (renderedPeer) acceptConversation(renderedPeer);
  }, [acceptConversation, renderedPeer]);

  if (!user) {
    return <Navigate to="/" replace />;
  }
  const returnToThread = () => {
    if (returnPeer) navigate(chatRoute({ kind: "dm", peer: dmRouteParam(returnPeer) }));
  };
  const startComposing = () => {
    navigate("/dm");
    setComposing(true);
  };

  // Mobile: the list shows when there's no thread and no compose pane.
  const listRevealed = !activePeer && !composing;

  return (
    <ChatShell
      scope={renderedPeer ? { kind: "dm", conversation: renderedPeer } : undefined}
      reveal={{
        open: listRevealed,
        onReveal: revealList,
        onClose: returnToThread,
        canClose: !!returnPeer,
        underlay: (
        <>
          <ServerRail />
          <ConversationList
            rows={displayRows}
            requestRows={visibleRequestRows}
            view={listView}
            onViewChange={setListView}
            previews={previews}
            events={events}
            activePeer={activePeer}
            dmSupported={dmSupported || dm17Supported}
            isLoading={showSkeletons}
            hasUnread={hasUnreadDms}
            onMarkAllRead={markAllDmsRead}
            onCompose={startComposing}
            openPeer={openPeer}
            startDm={startDm}
            closePeer={closePeer}
            dismissRequests={dismissRequests}
            loadMore={loadMore}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            // Wider than ChannelSidebarView: rows carry avatar, name and preview.
            className="w-72 xl:w-80 touch:max-sidebar:flex-1"
          />
        </>
        ),
      }}
    >
      {/* A new-DM recipient picker takes this column in place of the empty state. */}
        {renderedPeer ? (
            <Conversation
              key={renderedPeer}
              conversation={renderedPeer}
              peers={renderedPeers}
              isRequest={requestRows.some((c) => c.conversation === renderedPeer)}
              onAccept={acceptRendered}
              onBack={revealList}
            />
        ) : composing ? (
          <NewDMPane onSelectRecipients={openNewRecipients} onCancel={revealList} />
        ) : (
          <div className="flex flex-1 items-center justify-center text-muted-foreground p-8 text-center">
            <div className="flex flex-col items-center gap-3 max-w-sm">
              <MessageSquare className="size-12 opacity-30" />
              <p className="text-sm">
                <FormattedMessage id="dmsPage.selectConversation" defaultMessage="Select a conversation" />
              </p>
              <Button className="mt-1 clip-corner-lg" onClick={startComposing}>
                <PenSquare className="size-4" />
                <FormattedMessage id="dmsPage.newMessage" defaultMessage="New message" />
              </Button>
            </div>
          </div>
        )}
    </ChatShell>
  );
}
