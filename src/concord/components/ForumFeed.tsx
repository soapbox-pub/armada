import { ChevronDown, Clock, EyeOff, Flame, ImageOff, Loader2, MessageSquareText, MessagesSquare, Pin, Plus } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BlurhashCanvas } from "@/components/BlurhashCanvas";
import { DisplayName } from "@/components/DisplayName";
import { HeldMedia } from "@/components/chat/HeldMedia";
import { revealMessageMedia, useMediaHeld, useMediaUrlHold, useMessageRevealed } from "@/components/chat/mediaHold";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { PillTabs, type PillTab } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthor } from "@/hooks/useAuthor";
import { useMediaWithFallback } from "@/hooks/useMediaWithFallback";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { forumImages, type ForumImage, type ForumPost, type ForumSort } from "@/concord/lib/forum";
import { defineMessages, FormattedMessage, useIntl } from "@/i18n";
import { getAvatarShape } from "@/lib/avatarShape";
import { fullDateTime, shortTimeAgo, shortTimeAgoPhrase } from "@/lib/formatTime";
import { mediaHost } from "@/lib/mediaPolicy";
import { cn } from "@/lib/utils";

import type { ReactNode } from "react";
import { AvatarInitial } from "@/components/AvatarInitial";

/** Pages the sentinel auto-loads before handing over to its button. */
const MAX_AUTO_PAGES = 8;

const sortLabels = defineMessages({
  active: { id: "forumFeed.sort.active", defaultMessage: "Active" },
  newest: { id: "forumFeed.sort.newest", defaultMessage: "Newest" },
});

function AuthorAvatar({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = useScopedDisplayName(pubkey, metadata);
  return (
    <Avatar shape={getAvatarShape(metadata)} className={cn("size-8", className)}>
      <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
      <AvatarFallback className="bg-primary/20 text-primary text-xs"><AvatarInitial name={name} /></AvatarFallback>
    </Avatar>
  );
}

function ParticipantStack({ pubkeys }: { pubkeys: readonly string[] }) {
  const shown = pubkeys.slice(0, 3);
  if (shown.length === 0) return null;
  return (
    <span className="hidden sm:flex -space-x-1.5" aria-hidden>
      {shown.map((pk) => (
        <AuthorAvatar key={pk} pubkey={pk} className="size-5 ring-2 ring-card" />
      ))}
    </span>
  );
}

/** One post row in the work-item row shape (`ProjectsView`). */
const ForumPostRow = memo(function ForumPostRow({
  post,
  isNew,
  onOpen,
}: {
  post: ForumPost;
  isNew: boolean;
  onOpen: (post: ForumPost) => void;
}) {
  const intl = useIntl();
  const hasComments = post.replyCount > 0;
  const images = useMemo(() => forumImages(post.root), [post.root]);
  const revealed = useMessageRevealed(post.root.id);
  const senderHeld = useMediaHeld(post.root.pubkey) && !revealed;
  const holds = useMediaUrlHold(post.root.pubkey, post.root.id);
  // Like a chat gallery, one held image holds them all; the card sits outside the
  // row's button so its own buttons aren't nested in it.
  const heldImage = images.find((image) => holds(image.url));
  const heldHost = heldImage && !senderHeld ? mediaHost(heldImage.url) ?? heldImage.url : undefined;
  const rootId = post.root.id;
  const load = useCallback(() => revealMessageMedia(rootId), [rootId]);
  return (
    <div className={cn(isNew && "bg-primary/5")}>
      <button
        type="button"
        onClick={() => onOpen(post)}
        data-event-id={post.root.id}
        className={cn(
          "flex w-full flex-col p-3 text-left transition-colors hover:bg-foreground/5 focus:outline-none focus-visible:bg-foreground/5",
          heldImage && "pb-1.5",
        )}
      >
        <span className="flex w-full items-center gap-3">
          <AuthorAvatar pubkey={post.root.pubkey} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              {isNew && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-label={intl.formatMessage({ id: "forumFeed.newActivity", defaultMessage: "New activity" })} />}
              <span className={cn("truncate text-sm leading-5 text-foreground", isNew ? "font-bold" : "font-semibold")}>
                {post.title}
              </span>
            </span>
            <span className="block truncate text-xs leading-4 text-muted-foreground">
              <DisplayName pubkey={post.root.pubkey} />
              <span title={fullDateTime(post.root.created_at)}> · {shortTimeAgo(post.root.created_at)}</span>
              {hasComments && (
                <span title={fullDateTime(post.lastActivityAt)}>
                  {" "}
                  <FormattedMessage
                    id="forumFeed.activeAgo"
                    defaultMessage="· active {time}"
                    values={{ time: shortTimeAgoPhrase(post.lastActivityAt) }}
                  />
                </span>
              )}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {hasComments && <ParticipantStack pubkeys={post.participants} />}
            <span
              className={cn(
                "flex items-center gap-1 text-xs tabular-nums",
                isNew ? "font-medium text-primary" : "text-muted-foreground",
              )}
            >
              <MessagesSquare className="size-3.5" />
              {post.replyCount}
            </span>
          </span>
        </span>
        {images.length > 0 && !heldImage && <ForumGallery images={images} />}
      </button>
      {heldImage && (
        <div className="px-3 pb-1.5 sm:pl-14">
          <HeldMedia kind="image" count={images.length} host={heldHost} onLoad={load} />
        </div>
      )}
    </div>
  );
});

/** Reddit-style gallery: one whole over a blurred fill, two side by side, three+ as a mosaic. */
function ForumGallery({ images }: { images: readonly ForumImage[] }) {
  const frame = "mt-2 w-full max-w-md aspect-video overflow-hidden rounded-lg sm:ml-11 sm:w-[calc(100%-2.75rem)]";
  if (images.length === 1) {
    return (
      <span className={cn("block", frame)}>
        <ForumImageTile image={images[0]} fit="contain" className="size-full" />
      </span>
    );
  }
  if (images.length === 2) {
    return (
      <span className={cn("grid grid-cols-2 gap-1", frame)}>
        {images.map((image, i) => (
          <ForumImageTile key={i} image={image} className="size-full" />
        ))}
      </span>
    );
  }
  const extra = images.length - 3;
  return (
    <span className={cn("grid grid-cols-3 grid-rows-2 gap-1", frame)}>
      <ForumImageTile image={images[0]} className="col-span-2 row-span-2 size-full" />
      <ForumImageTile image={images[1]} className="size-full" />
      <ForumImageTile image={images[2]} className="size-full" overflow={extra > 0 ? extra : undefined} />
    </span>
  );
}

/** A spoilered image is never fetched — the post page reveals it. */
function ForumImageTile(props: {
  image: ForumImage;
  fit?: "cover" | "contain";
  overflow?: number;
  className?: string;
}) {
  const { image, overflow, className } = props;
  return (
    <span className={cn("relative block overflow-hidden bg-muted", className)}>
      {image.spoiler ? (
        <>
          {image.blurhash && <BlurhashCanvas hash={image.blurhash} className="absolute inset-0" />}
          <span className="absolute inset-0 flex items-center justify-center gap-1.5 bg-black/40 text-xs font-medium text-white">
            <EyeOff className="size-3.5" />
            <FormattedMessage id="forumFeed.spoiler" defaultMessage="Spoiler" />
          </span>
        </>
      ) : (
        <ResolvedImage image={image} fit={props.fit ?? "cover"} />
      )}
      {overflow !== undefined && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/60 text-lg font-semibold text-white">
          +{overflow}
        </span>
      )}
    </span>
  );
}

/** Under the media policy and decrypted when encrypted. */
function ResolvedImage({ image, fit }: { image: ForumImage; fit: "cover" | "contain" }) {
  const [loaded, setLoaded] = useState(false);
  const { resolved, onError, failed } = useMediaWithFallback(image);
  if (failed) {
    return (
      <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">
        <ImageOff className="size-5" />
      </span>
    );
  }
  return (
    <>
      {/* Prefer the blurhash (free per frame) over a full-size blur filter. */}
      {image.blurhash && (!loaded || fit === "contain") && (
        <BlurhashCanvas hash={image.blurhash} className={cn("absolute inset-0", loaded && "opacity-50")} />
      )}
      {resolved.status === "ready" && (
        <>
          {fit === "contain" && loaded && !image.blurhash && (
            <img
              src={resolved.src}
              alt=""
              aria-hidden
              draggable={false}
              className="absolute inset-0 size-full scale-110 object-cover opacity-50 blur-2xl"
            />
          )}
          <img
            src={resolved.src}
            alt=""
            draggable={false}
            loading="lazy"
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={onError}
            className={cn(
              "absolute inset-0 size-full transition-opacity",
              fit === "contain" ? "object-contain" : "object-cover",
              loaded ? "opacity-100" : "opacity-0",
            )}
          />
        </>
      )}
    </>
  );
}

function PostGroup({
  eyebrow,
  icon: Icon,
  children,
}: {
  eyebrow?: string;
  icon?: typeof Pin;
  children: ReactNode;
}) {
  return (
    <div>
      {eyebrow && (
        <div className="flex items-center gap-1 px-1 pb-1 text-xs font-medium text-muted-foreground">
          {Icon && <Icon className="size-3 shrink-0" />}
          {eyebrow}
        </div>
      )}
      <div className="clip-corner-lg bg-card divide-y divide-border/60">{children}</div>
    </div>
  );
}

/** Forum channel (CORD-03 §2 `view: "forum"`): titled posts as rows over `forumPosts()`. */
export function ForumFeed({
  posts,
  sort,
  onSortChange,
  isLoading,
  syncing = false,
  hasMore = false,
  isLoadingOlder = false,
  onLoadOlder,
  onOpen,
  isNew,
  onNewPost,
  banner,
  className,
}: {
  /** Already sorted (`forumPosts`), pinned first. */
  posts: readonly ForumPost[];
  sort: ForumSort;
  onSortChange: (sort: ForumSort) => void;
  isLoading: boolean;
  /** A background catch-up is running: an empty feed is not yet a verdict. */
  syncing?: boolean;
  hasMore?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => Promise<number>;
  onOpen: (post: ForumPost) => void;
  isNew: (post: ForumPost) => boolean;
  /** Undefined when the reader may not write. */
  onNewPost?: () => void;
  banner?: ReactNode;
  className?: string;
}) {
  const intl = useIntl();
  const sortTabs = useMemo<readonly PillTab<ForumSort>[]>(() => [
    { id: "active", label: intl.formatMessage(sortLabels.active), icon: Flame },
    { id: "newest", label: intl.formatMessage(sortLabels.newest), icon: Clock },
  ], [intl]);
  // Auto-page older history with a bounded sentinel: a page with no titled post
  // leaves it in view, so unbounded it'd walk a chatty channel's whole history.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadOlderRef = useRef(onLoadOlder);
  loadOlderRef.current = onLoadOlder;
  const autoPagesRef = useRef(0);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || isLoadingOlder || !onLoadOlder) return;
    if (autoPagesRef.current >= MAX_AUTO_PAGES) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      if (autoPagesRef.current >= MAX_AUTO_PAGES) return;
      autoPagesRef.current += 1;
      void loadOlderRef.current?.();
    }, { rootMargin: "200px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isLoadingOlder, onLoadOlder, posts.length]);
  const loadOlderByHand = () => {
    autoPagesRef.current = 0;
    void onLoadOlder?.();
  };

  const empty = !isLoading && posts.length === 0;
  const pinned = posts.filter((p) => p.pinned);
  const rest = posts.filter((p) => !p.pinned);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {banner}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-stable">
        <div className="mx-auto w-full max-w-2xl px-3 py-4 sm:px-4">
          <div className="mt-0.5 mb-[18px] flex flex-wrap items-center gap-2">
            <PillTabs tabs={sortTabs} value={sort} onChange={onSortChange} className="w-auto" />
            {onNewPost && (
              <Button size="sm" className="ml-auto clip-corner-lg h-9 gap-1.5 touch:h-11" onClick={onNewPost}>
                <Plus className="size-4" />
                <FormattedMessage id="forumFeed.newPost" defaultMessage="New post" />
              </Button>
            )}
          </div>

          {isLoading ? (
            <div className="clip-corner-lg bg-card divide-y divide-border/60">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 p-3">
                  <Skeleton className="size-8 rounded-full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-2/3" />
                    <Skeleton className="h-3 w-1/3" />
                  </div>
                  <Skeleton className="h-3 w-6" />
                </div>
              ))}
            </div>
          ) : empty ? (
            <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
              <div className="flex size-14 items-center justify-center clip-corner-lg bg-primary/10 text-primary">
                {syncing ? <Loader2 className="size-6 animate-spin" /> : <MessageSquareText className="size-6" />}
              </div>
              <p className="font-medium">{syncing
                ? <FormattedMessage id="forumFeed.catchingUp" defaultMessage="Catching up" />
                : <FormattedMessage id="forumFeed.empty" defaultMessage="No posts yet" />}</p>
              {onNewPost && !syncing && (
                <Button className="clip-corner-lg gap-1.5" onClick={onNewPost}>
                  <Plus className="size-4" />
                  <FormattedMessage id="forumFeed.writeFirst" defaultMessage="Write the first post" />
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {pinned.length > 0 && (
                <PostGroup eyebrow={intl.formatMessage({ id: "forumFeed.pinned", defaultMessage: "Pinned" })} icon={Pin}>
                  {pinned.map((post) => (
                    <ForumPostRow key={post.root.id} post={post} isNew={isNew(post)} onOpen={onOpen} />
                  ))}
                </PostGroup>
              )}
              {rest.length > 0 && (
                <PostGroup eyebrow={pinned.length > 0 ? intl.formatMessage({ id: "forumFeed.posts", defaultMessage: "Posts" }) : undefined}>
                  {rest.map((post) => (
                    <ForumPostRow key={post.root.id} post={post} isNew={isNew(post)} onOpen={onOpen} />
                  ))}
                </PostGroup>
              )}
              {hasMore && onLoadOlder && (
                <div ref={sentinelRef} className="flex justify-center py-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-muted-foreground"
                    disabled={isLoadingOlder}
                    onClick={loadOlderByHand}
                  >
                    {isLoadingOlder ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
                    {isLoadingOlder
                      ? <FormattedMessage id="forumFeed.loadingOlder" defaultMessage="Loading older posts" />
                      : <FormattedMessage id="forumFeed.loadOlder" defaultMessage="Load older posts" />}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
