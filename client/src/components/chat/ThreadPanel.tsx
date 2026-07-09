import { Braces, Copy, Link2, Loader2, MessagesSquare, Trash2, X, Zap } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useState } from "react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatContent } from "@/components/chat/ChatContent";
import { ProfilePreviewCard } from "@/components/chat/ProfilePreviewCard";
import { ReactionBar, ReactionPicker } from "@/components/chat/ReactionBar";
import { ZapDialog } from "@/components/chat/ZapDialog";
import { ZapPill } from "@/components/chat/ZapPill";
import { DittoIcon } from "@/components/brand/DittoIcon";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { getAvatarShape } from "@/lib/avatarShape";
import { shortClockTime } from "@/lib/formatTime";
import { writeClipboardText } from "@/lib/clipboard";
import { dittoEventUrl } from "@/lib/dittoUrl";
import { cn } from "@/lib/utils";

import type { ChatMsg, ChatTransport, MessageReactions, MessageZaps, ZapPayment } from "@/components/chat/transport";

/**
 * Consecutive replies from the same author within this window collapse into a
 * compact continuation (no repeated avatar/name). Matches the main timeline's
 * `CONTINUATION_WINDOW_SECONDS` in MessageTimeline.
 */
const CONTINUATION_WINDOW_SECONDS = 5 * 60;

/** A single message row inside the thread panel (root or reply). */
function ThreadMessage({
  event,
  reactions,
  zaps,
  zapEnabled = false,
  onSendZap,
  canReact,
  canModerate = false,
  isRumor = false,
  continuation = false,
  onDelete,
}: {
  event: ChatMsg;
  reactions?: MessageReactions;
  /** Aggregated zaps for this message (feeds the ⚡ total chip). */
  zaps?: MessageZaps;
  /** Whether this surface supports zaps (shows the ⚡ button on others' messages). */
  zapEnabled?: boolean;
  /** CORD.md announcement publisher (Concord v2); absent = NIP-57 public surface. */
  onSendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
  canReact: boolean;
  /** Whether the current user may delete others' messages (moderation). */
  canModerate?: boolean;
  /**
   * Whether this message is an unsigned rumor (Concord sealed chat event). Drives
   * the right-click context menu: rumors offer "View event JSON" (a dialog with
   * the rumor, pretty-printed), signed events offer the relay off-ramps.
   */
  isRumor?: boolean;
  /**
   * Render as a compact continuation of the previous same-author reply: hides
   * the avatar/name/timestamp header (a hover-revealed clock time replaces the
   * avatar), mirroring the main timeline's continuation collapsing.
   */
  continuation?: boolean;
  /** Delete this message (own always; others' require moderation). Hidden when absent. */
  onDelete?: (event: ChatMsg) => void;
}) {
  const { user } = useCurrentUser();
  const author = useAuthor(event.pubkey);
  const metadata = author.data?.metadata;
  const displayName = useScopedDisplayName(event.pubkey, metadata);
  const when = new Date(event.created_at * 1000);

  const [jsonOpen, setJsonOpen] = useState(false);
  const [zapOpen, setZapOpen] = useState(false);
  // A rumor has no signature; strip the synthetic empty `sig` the transport
  // adds for rendering so the JSON view reflects the true rumor shape.
  const rumorJson = isRumor
    ? JSON.stringify((({ sig: _sig, ...rest }) => rest)(event), null, 2)
    : null;

  // The author can delete their own message; moderators can delete anyone's
  // (mirrors ChatMessage's gating). The transport decides how.
  const isOwn = user?.pubkey === event.pubkey;
  const canDelete = Boolean(onDelete) && (isOwn || canModerate);
  // Zap gating mirrors ChatMessage: shown on others' messages when the surface
  // supports zaps; disabled once the author's profile loads with no lightning
  // address.
  const canZap = Boolean(zapEnabled && user && !isOwn);
  const zapDisabled = Boolean(author.data && !metadata?.lud16 && !metadata?.lud06);

  return (
    <>
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className={cn(
          "group/threadmsg relative flex items-start gap-3 px-2.5 rounded hover:bg-secondary/40 transition-colors",
          continuation ? "py-0.5" : "py-1.5",
        )}>
          {continuation ? (
            <span className="shrink-0 w-9 self-stretch flex items-start justify-end pr-0.5 pt-0.5 text-[10px] leading-none text-muted-foreground/60 opacity-0 group-hover/threadmsg:opacity-100 transition-opacity tabular-nums select-none">
              {shortClockTime(event.created_at)}
            </span>
          ) : (
            <ProfilePreviewCard pubkey={event.pubkey}>
              <button type="button" className="shrink-0 mt-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Avatar shape={getAvatarShape(metadata)} className="size-9 cursor-pointer transition-opacity hover:opacity-90">
                  <AvatarImage src={metadata?.picture} alt={displayName} />
                  <AvatarFallback className="bg-primary/20 text-primary text-sm">
                    {displayName[0]?.toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </button>
            </ProfilePreviewCard>
          )}
          <div className="flex-1 min-w-0">
            {!continuation && (
              <div className="flex items-baseline gap-2">
                <ProfilePreviewCard pubkey={event.pubkey}>
                  <button type="button" className="text-[15px] font-semibold text-primary truncate hover:underline focus:outline-none">
                    {displayName}
                  </button>
                </ProfilePreviewCard>
                <span className="text-[11px] text-muted-foreground/70 shrink-0" title={when.toLocaleString()}>
                  {when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
            )}
            <ChatContent event={event} className="text-[15px]" />
            {((zaps && zaps.tally.count > 0) || (reactions && reactions.tallies.length > 0)) && (
              <ReactionBar
                tallies={reactions?.tallies ?? []}
                canReact={canReact}
                onReact={reactions?.react ?? (() => {})}
                leading={
                  zaps && zaps.tally.count > 0 ? (
                    <ZapPill
                      tally={zaps.tally}
                      canZap={canZap && !zapDisabled}
                      onZap={() => setZapOpen(true)}
                    />
                  ) : undefined
                }
              />
            )}
          </div>
          {(canReact && reactions) || canZap ? (
            <div className="absolute right-1.5 top-1 flex items-center opacity-0 group-hover/threadmsg:opacity-100 focus-within:opacity-100 transition-opacity">
              {canReact && reactions && <ReactionPicker onReact={reactions.react} />}
              {canZap && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Zap message"
                      disabled={zapDisabled}
                      className="size-9 md:size-7 text-muted-foreground hover:text-amber-500 disabled:opacity-40"
                      onClick={() => setZapOpen(true)}
                    >
                      <Zap className="size-[18px] md:size-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {zapDisabled ? "No lightning address on their profile" : "Zap message"}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {canZap && !zapDisabled && (
          <ContextMenuItem onSelect={() => setZapOpen(true)}>
            <Zap className="mr-2 size-4" /> Zap message
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => writeClipboardText(event.content).catch(() => undefined)}>
          <Copy className="mr-2 size-4" /> Copy text
        </ContextMenuItem>
        {!isRumor && (
          <ContextMenuItem
            onSelect={() => {
              try {
                writeClipboardText(
                  `nostr:${nip19.neventEncode({ id: event.id, author: event.pubkey })}`,
                ).catch(() => undefined);
              } catch {
                writeClipboardText(event.id).catch(() => undefined);
              }
            }}
          >
            <Link2 className="mr-2 size-4" /> Copy message ID
          </ContextMenuItem>
        )}
        {!isRumor && dittoEventUrl(event) && (
          <ContextMenuItem
            onSelect={() => {
              const href = dittoEventUrl(event);
              if (href) window.open(href, "_blank", "noopener,noreferrer");
            }}
          >
            <DittoIcon className="mr-2 size-4" /> View on Ditto
          </ContextMenuItem>
        )}
        {rumorJson !== null && (
          <ContextMenuItem onSelect={() => setJsonOpen(true)}>
            <Braces className="mr-2 size-4" /> View event JSON
          </ContextMenuItem>
        )}
        {canDelete && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={() => onDelete?.(event)}
            >
              <Trash2 className="mr-2 size-4" /> Delete message
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
    {zapOpen && (
      <ZapDialog open={zapOpen} onOpenChange={setZapOpen} target={event} sendZap={onSendZap} />
    )}
    {rumorJson !== null && (
      <Dialog open={jsonOpen} onOpenChange={setJsonOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Event JSON</DialogTitle>
            <DialogDescription>
              The raw, unsigned rumor for this message.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
            {rumorJson}
          </pre>
          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => writeClipboardText(rumorJson).catch(() => undefined)}
            >
              <Copy className="mr-2 size-4" /> Copy JSON
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )}
    </>
  );
}

interface ThreadPanelProps {
  /** The root chat message this thread hangs off. */
  root: ChatMsg;
  /** The room's transport — supplies the replies, reply-send, and reactions. */
  transport: ChatTransport;
  /**
   * NIP-29 composer context: the group's host relay + `h`-tag id. Concord
   * transports send replies via {@link ChatTransport.sendThreadReply} and don't
   * use these (they pass placeholder values).
   */
  relayUrl: string;
  groupId: string;
  /** Whether the current user can post replies. */
  canWrite: boolean;
  /**
   * Explicit @-mention roster for the reply composer. Required for Concord
   * transports (`relayUrl="dm"` has no NIP-29 group to derive members from);
   * NIP-29 callers can omit it and the composer derives the roster itself.
   */
  mentionPubkeys?: string[];
  /** Focus the reply input on open (e.g. when launched via /thread). */
  autoFocus?: boolean;
  onClose: () => void;
}

/**
 * Side panel showing a message thread: the root message, its replies, and a
 * composer for posting a new reply. Sits beside the channel timeline
 * (Slack/Discord style). It is transport-driven — NIP-29, Concord V1, and
 * Concord V2 all render through it, each supplying its own replies + reply-send
 * via the {@link ChatTransport} (`threadRepliesFor`/`sendThreadReply`), so
 * replies never appear in the main timeline (they're nested here instead).
 */
export function ThreadPanel({ root, transport, relayUrl, groupId, canWrite, mentionPubkeys, autoFocus = false, onClose }: ThreadPanelProps) {
  const replies = transport.threadRepliesFor?.(root.id) ?? [];
  const isLoading = transport.threadLoading?.(root.id) ?? false;
  const reactionsFor = transport.reactionsFor;
  const zapsFor = transport.zapsFor;
  const zapEnabled = Boolean(transport.zapsFor);
  const onSendZap = transport.sendZap;
  const isRumor = transport.isRumor ?? false;
  const canModerate = transport.canModerate;
  const onDelete = transport.deleteMessage;

  return (
    <aside className="flex flex-col min-h-0 flex-1 min-w-0 m-2 sidebar:my-3 sidebar:mr-2 sidebar:ml-0 p-1.5 clip-corner-lg bg-chrome">
      <div className="flex items-center justify-between px-2 py-1 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <MessagesSquare className="size-4 text-muted-foreground shrink-0" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground truncate">
            Thread{replies.length > 0 ? ` · ${replies.length}` : ""}
          </h3>
        </div>
        <Button variant="ghost" size="icon" aria-label="Close thread" className="size-6" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable space-y-1">
        <ThreadMessage event={root} reactions={reactionsFor?.(root.id)} zaps={zapsFor?.(root.id)} zapEnabled={zapEnabled} onSendZap={onSendZap} canReact={canWrite} canModerate={canModerate} isRumor={isRumor} onDelete={onDelete} />
        <div className="flex items-center gap-2 px-3 py-1">
          <div className="h-px flex-1 bg-border/60" />
          {!isLoading && (
            <span className="text-[11px] text-muted-foreground/60 shrink-0">
              {replies.length === 0
                ? "No replies yet"
                : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
            </span>
          )}
          <div className="h-px flex-1 bg-border/60" />
        </div>
        {isLoading ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          replies.map((reply, i) => {
            // Collapse consecutive same-author replies within a short window into
            // a compact continuation, mirroring the main timeline. The root never
            // continues into the first reply (they're separated by the divider).
            const prev = replies[i - 1];
            const continuation =
              !!prev &&
              prev.pubkey === reply.pubkey &&
              reply.created_at - prev.created_at < CONTINUATION_WINDOW_SECONDS;
            return (
              <ThreadMessage key={reply.id} event={reply} reactions={reactionsFor?.(reply.id)} zaps={zapsFor?.(reply.id)} zapEnabled={zapEnabled} onSendZap={onSendZap} canReact={canWrite} canModerate={canModerate} isRumor={isRumor} continuation={continuation} onDelete={onDelete} />
            );
          })
        )}
      </div>

      {canWrite ? (
        <ChatComposer
          relayUrl={relayUrl}
          groupId={groupId}
          messages={[]}
          mentionPubkeys={mentionPubkeys}
          placeholder="Reply in thread…"
          draftScope={`thread:${root.id}`}
          autoFocus={autoFocus}
          sendOverride={async (text, tags) => {
            await transport.sendThreadReply?.(root, text, tags);
          }}
        />
      ) : (
        <div className="p-3 shrink-0 pb-safe">
          <p className="text-xs text-muted-foreground text-center py-1">
            Join this channel to reply.
          </p>
        </div>
      )}
    </aside>
  );
}
