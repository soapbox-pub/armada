import { ArrowLeft, CornerDownRight, Loader2, MessagesSquare, Pin } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ChatComposer } from "@/components/chat/ChatComposer";
import { flashRow } from "@/components/chat/rowFlash";
import { ThreadMessage } from "@/components/chat/ThreadPanel";
import { useChatEditing } from "@/components/chat/useChatEditing";
import { DisplayName } from "@/components/DisplayName";
import { Button } from "@/components/ui/button";
import { ComposerBoundsProvider } from "@/contexts/ComposerBoundsContext";
import { isTombstoneRoot } from "@/concord/hooks/useConcordThreads";
import { buildCommentTree, flattenCommentTree, type CommentNode } from "@/concord/lib/commentTree";
import { useAndroidBack } from "@/hooks/useAndroidBack";
import { useAppContext } from "@/hooks/useAppContext";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useHiddenMessages } from "@/hooks/useHiddenMessages";
import { useMutedWordFilter } from "@/hooks/useMutedWords";
import { useMessagePermalink } from "@/hooks/useMessagePermalink";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import type { ReactNode } from "react";

/** Past this depth replies render at the cap with a "replying to" line. */
const MAX_INDENT_DEPTH = 4;
const INDENT_REM = 1.5;
const RAIL_OFFSET_REM = 0.75;
/** Matches the Tailwind duration. */
const EXPAND_MS = 200;

/**
 * A forum post page (CORD-03 §3) opening at the TOP, with comments as a tree
 * (`commentTree.ts`). Reply opens the editor in place under the comment. Rows
 * reuse {@link ThreadMessage} and the room's {@link ChatTransport}.
 */
export function ForumPostPage({
  root,
  title,
  pinned = false,
  transport,
  groupId,
  canWrite,
  mentionPubkeys,
  conversationRelays,
  disappearingTimer,
  autoFocus = false,
  onBack,
  className,
}: {
  /** The post (a kind-9 root carrying a subject). */
  root: ChatMsg;
  title: string;
  pinned?: boolean;
  transport: ChatTransport;
  groupId: string;
  canWrite: boolean;
  mentionPubkeys?: string[];
  conversationRelays?: string[];
  /** See ChatComposer's. */
  disappearingTimer?: () => Promise<number>;
  autoFocus?: boolean;
  onBack: () => void;
  className?: string;
}) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const isLoading = transport.threadLoading?.(root.id) ?? false;
  const threadRepliesFor = transport.threadRepliesFor;

  // Comments bypass the timeline's mute/hide filter, so filter here.
  const { mutedPubkeys, ready: mutesReady } = useMutedPubkeys();
  const { hiddenIds } = useHiddenMessages();
  const mutedWord = useMutedWordFilter();
  const comments = useMemo(() => {
    const all = threadRepliesFor?.(root.id) ?? [];
    const dropMuted = mutesReady && mutedPubkeys.size > 0;
    if (!dropMuted && hiddenIds.size === 0 && !mutedWord) return all;
    return all.filter(
      (reply) => !hiddenIds.has(reply.id) && !mutedWord?.(reply)
        && (!dropMuted || !mutedPubkeys.has(reply.pubkey)),
    );
  }, [threadRepliesFor, root.id, mutedPubkeys, mutesReady, hiddenIds, mutedWord]);
  const tree = useMemo(() => buildCommentTree(root.id, comments), [root.id, comments]);
  // Reading order, walked by "edit last" and permalinks.
  const ordered = useMemo(() => [root, ...flattenCommentTree(tree)], [root, tree]);
  const rootMuted = mutesReady && mutedPubkeys.has(root.pubkey);
  const rootGone = isTombstoneRoot(root) || rootMuted;

  const reactionsFor = transport.reactionsFor;
  const zapsFor = transport.zapsFor;
  const zapEnabled = config.zapsEnabled && Boolean(transport.zapsFor);
  const isRumor = transport.isRumor ?? false;
  const editMessage = transport.editMessage;
  const composerBoundsRef = useRef<HTMLElement | null>(null);

  const { editingId, startEditing, cancelEditing, handleEditSubmit, editLast } = useChatEditing({
    edit: (original, content) => editMessage?.(original, content),
    messages: ordered,
    isPending: (id) => transport.sendStatusFor?.(id) !== undefined,
    self: user?.pubkey,
  });

  const [replyingTo, setReplyingTo] = useState<ChatMsg | undefined>(undefined);
  useEffect(() => setReplyingTo(undefined), [root.id]);
  // Collapsed to one line until the reader means to write.
  const [commentOpen, setCommentOpen] = useState(autoFocus);
  useEffect(() => setCommentOpen(autoFocus), [root.id, autoFocus]);
  // Kept MOUNTED while closed so opening animates an already-sized box; clip
  // lifts only when fully open so overlays work.
  const [commentSettled, setCommentSettled] = useState(autoFocus);
  const topComposerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!commentOpen) {
      setCommentSettled(false);
      return;
    }
    // No scroll while the box is still growing.
    topComposerRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
    const settle = setTimeout(() => {
      setCommentSettled(true);
      topComposerRef.current?.scrollIntoView({ block: "nearest" });
    }, EXPAND_MS);
    return () => clearTimeout(settle);
  }, [commentOpen]);
  const openCommentBox = useCallback(() => {
    setReplyingTo(undefined);
    setCommentOpen(true);
  }, []);

  // Registered here so it wins over the swipe-reveal back handler.
  useAndroidBack(() => {
    onBack();
    return true;
  });

  // The scroller is reused across posts, so reset per post.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [root.id]);

  const scrollToComment = useCallback((id: string) => {
    const row = contentRef.current?.querySelector<HTMLElement>(`[data-event-id="${id}"]`);
    if (!row) return false;
    flashRow(row, true);
    return true;
  }, []);
  const clearCommentFocus = useMessagePermalink({
    messages: ordered,
    isLoading,
    scrollTo: scrollToComment,
    scope: "thread",
  });

  const commentCount = comments.length;
  const commentsLabel = isLoading
    ? intl.formatMessage({ id: "forumPostPage.comments", defaultMessage: "Comments" })
    : commentCount === 0
      ? intl.formatMessage({ id: "forumPostPage.noComments", defaultMessage: "No comments yet" })
      : intl.formatMessage(
        { id: "forumPostPage.commentCount", defaultMessage: "{count, plural, one {# comment} other {# comments}}" },
        { count: commentCount },
      );

  const rowProps = (event: ChatMsg) => ({
    event,
    reactions: reactionsFor?.(event.id),
    zaps: zapsFor?.(event.id),
    zapEnabled,
    onSendZap: transport.sendZap,
    onSendOnchainZap: transport.sendOnchainZap,
    canReact: canWrite,
    canModerate: transport.canModerate,
    isRumor,
    everyoneMention: transport.mentionsEveryone?.(event),
    onDelete: transport.deleteMessage,
    isEditing: editingId === event.id,
    onEdit: startEditing,
    onEditSubmit: handleEditSubmit,
    onEditCancel: cancelEditing,
  });

  const composer = (parent: ChatMsg, opts: { inline: boolean }) => (
    <ChatComposer
      relayUrl="dm"
      groupId={groupId}
      messages={[]}
      layout="document"
      documentEnterSends
      submitLabel={opts.inline
        ? intl.formatMessage(common.reply)
        : intl.formatMessage({ id: "forumPostPage.comment", defaultMessage: "Comment" })}
      onCancel={opts.inline ? () => setReplyingTo(undefined) : () => setCommentOpen(false)}
      mentionPubkeys={mentionPubkeys}
      canMentionEveryone={transport.canMentionEveryone}
      mentionRoles={transport.mentionRoles}
      conversationRelays={conversationRelays}
      placeholder={opts.inline
        ? intl.formatMessage({ id: "forumPostPage.writeReply", defaultMessage: "Write a reply" })
        : intl.formatMessage({ id: "forumPostPage.addComment", defaultMessage: "Add a comment" })}
      // Inline drafts are scoped to the comment answered.
      draftScope={opts.inline ? `thread:${root.id}:${parent.id}` : `thread:${root.id}`}
      autoFocus={opts.inline}
      pollsEnabled={false}
      // Attachments sealed like the post's: Blossom holds ciphertext, key in imeta.
      encryptAttachments
      disappearingTimer={disappearingTimer}
      canSend={transport.canSend}
      sendOverride={async (text, tags) => {
        // `buildConcordCommentTags` inherits the root pointer from `parent`.
        await transport.sendThreadReply?.(parent, text, tags);
        if (opts.inline) setReplyingTo(undefined);
        else setCommentOpen(false);
        // Commenting means the reader is at the present.
        clearCommentFocus();
      }}
      onEditLast={editMessage ? editLast : undefined}
    />
  );

  // Rendered FLAT with per-row rails, not nested containers, so the in-place
  // reply editor keeps full width at any depth.
  const rows: ReactNode[] = [];
  const pushRows = (nodes: readonly CommentNode[], parent: ChatMsg | undefined) => {
    for (const { comment, depth, children } of nodes) {
      const capped = depth >= MAX_INDENT_DEPTH;
      const shown = Math.min(depth, MAX_INDENT_DEPTH);
      rows.push(
        <div
          key={comment.id}
          data-event-id={comment.id}
          className="relative"
          style={{ paddingLeft: `${shown * INDENT_REM}rem` }}
        >
          {Array.from({ length: shown }, (_, level) => (
            <span
              key={level}
              aria-hidden
              className="absolute inset-y-0 w-px bg-border/40"
              style={{ left: `${level * INDENT_REM + RAIL_OFFSET_REM}rem` }}
            />
          ))}
          {capped && parent && (
            <div className="flex items-center gap-1 px-3 pt-2 text-xs text-muted-foreground">
              <CornerDownRight className="size-3 shrink-0" />
              <span className="truncate">
                <FormattedMessage
                  id="forumPostPage.replyingToLower"
                  defaultMessage="replying to {name}"
                  values={{ name: <DisplayName pubkey={parent.pubkey} /> }}
                />
              </span>
            </div>
          )}
          <ThreadMessage presentation="comment" onReply={canWrite ? setReplyingTo : undefined} {...rowProps(comment)} />
        </div>,
      );
      if (replyingTo?.id === comment.id) {
        rows.push(
          <div key={`reply:${comment.id}`} className="px-3 pb-3 pt-1">
            <div className="mb-1 flex items-center gap-1 px-1 text-xs text-muted-foreground">
              <CornerDownRight className="size-3 shrink-0" />
              <span className="truncate">
                <FormattedMessage
                  id="forumPostPage.replyingTo"
                  defaultMessage="Replying to {name}"
                  values={{ name: <DisplayName pubkey={comment.pubkey} /> }}
                />
              </span>
            </div>
            {composer(comment, { inline: true })}
          </div>,
        );
      }
      pushRows(children, comment);
    }
  };
  pushRows(tree, undefined);

  return (
    <ComposerBoundsProvider value={composerBoundsRef}>
      <div className={cn("flex min-h-0 flex-col", className)}>
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-clip overscroll-contain scrollbar-stable"
        >
          <div ref={contentRef} className="mx-auto w-full max-w-2xl px-3 pb-6 pt-3 sm:px-4">
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 mb-2 gap-1.5 text-muted-foreground hover:text-foreground touch:h-11"
              onClick={onBack}
            >
              <ArrowLeft className="size-4" />
              <FormattedMessage id="forumPostPage.allPosts" defaultMessage="All posts" />
            </Button>

            <article data-event-id={root.id}>
              {pinned && (
                <div className="mb-1 flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Pin className="size-3" />
                  <FormattedMessage id="forumPostPage.pinned" defaultMessage="Pinned" />
                </div>
              )}
              <h1 className="mb-4 text-2xl font-semibold leading-tight break-words">{title}</h1>
              {rootGone ? (
                <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground/70">
                  <MessagesSquare className="size-4 shrink-0" />
                  <span className="italic">
                    {rootMuted
                      ? <FormattedMessage id="forumPostPage.authorBlocked" defaultMessage="You blocked the person who wrote this post." />
                      : <FormattedMessage id="forumPostPage.notLoaded" defaultMessage="The post isn't loaded. It may be older than the channel window." />}
                  </span>
                </div>
              ) : (
                <ThreadMessage presentation="post" {...rowProps(root)} />
              )}
            </article>

            {canWrite ? (
              <div className="mt-4">
                {!commentOpen && (
                  <button
                    type="button"
                    onClick={openCommentBox}
                    className="flex w-full items-center clip-corner-lg bg-secondary/60 px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary/80 hover:text-foreground touch:py-3"
                  >
                    <FormattedMessage id="forumPostPage.addComment" defaultMessage="Add a comment" />
                  </button>
                )}
                <div
                  ref={topComposerRef}
                  inert={!commentOpen}
                  aria-hidden={!commentOpen}
                  // `minmax(0,1fr)`: an auto column grows to the attachment tray's
                  // min-content and pushes the submit button off-screen.
                  className={cn(
                    "grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
                    commentOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                  )}
                >
                  <div className={cn("min-h-0", !(commentOpen && commentSettled) && "overflow-hidden")}>
                    {composer(root, { inline: false })}
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-4 py-2 text-center text-xs text-muted-foreground">
                <FormattedMessage id="forumPostPage.joinToComment" defaultMessage="Join this channel to comment." />
              </p>
            )}

            <section className="mt-6" aria-label={intl.formatMessage({ id: "forumPostPage.comments", defaultMessage: "Comments" })}>
              <h2 className="flex items-center gap-2 px-3 pb-1 text-sm font-semibold">
                <span>{commentsLabel}</span>
                {isLoading && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
              </h2>
              {!isLoading && rows.length > 0 && <div>{rows}</div>}
            </section>
          </div>
        </div>
      </div>
    </ComposerBoundsProvider>
  );
}
