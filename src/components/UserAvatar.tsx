import type { NostrMetadata } from "@nostrify/nostrify";
import type { CSSProperties, ReactNode } from "react";

import { AvatarInitial } from "@/components/AvatarInitial";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useAuthor } from "@/hooks/useAuthor";
import { getAvatarShape, isEmoji, isValidAvatarShape, type AvatarShape } from "@/lib/avatarShape";
import { getDisplayName } from "@/lib/getDisplayName";
import type { ImetaEntry } from "@/lib/imeta";
import { useFrameCss, useUltra } from "@/lib/ultra";
import { cn } from "@/lib/utils";

export interface UserAvatarProps {
  pubkey: string | undefined;
  /**
   * The caller's resolved kind-0. Passing the prop at all, even as `undefined`
   * while it loads, means this avatar subscribes to nothing of its own (matters on timelines).
   */
  metadata?: NostrMetadata;
  /** The picture's imeta (`author.data?.imeta?.picture`), when the caller already has it. */
  imeta?: ImetaEntry;
  /** Alt text and fallback initial; defaults to the profile's display name. */
  name?: string;
  /** Size and placement of the avatar itself, e.g. `size-10 mt-0.5`. */
  className?: string;
  fallbackClassName?: string;
  fallbackStyle?: CSSProperties;
  /** Never load the picture: a message request's sender must not learn we looked. */
  anonymous?: boolean;
  /** Overrides the profile's own avatar shape (a grid tile is always a circle). */
  shape?: AvatarShape;
  /** The Ultra avatar frame; off where neighbours would clip or overlap its glow. */
  frame?: boolean;
  /** Decorative when the name sits beside it. */
  "aria-hidden"?: boolean;
  alt?: string;
  /** Set false inside a drag source, so the picture doesn't start a drag of its own. */
  draggable?: boolean;
  /** Replaces the initial, for a fallback that says something else (e.g. a pending state). */
  fallback?: ReactNode;
  /** Extra layers inside the avatar (status dots that must be masked with it). */
  children?: ReactNode;
  /** Loops an animated picture plays before holding (`AvatarImage`); a profile's own picture plays on. */
  loops?: number;
}

/**
 * A person's avatar: picture, initial fallback, avatar shape and Ultra frame.
 * Every avatar of a person goes through here, so what a profile carries is
 * drawn the same everywhere; community and app icons use `ui/avatar` directly.
 */
export function UserAvatar(props: UserAvatarProps) {
  // Only read the profile when the caller didn't hand it over.
  const resolved = "metadata" in props;
  const author = useAuthor(resolved ? undefined : props.pubkey);
  const metadata = resolved ? props.metadata : author.data?.metadata;
  const imeta = props.imeta ?? (resolved ? undefined : author.data?.imeta?.picture);
  return <UserAvatarView {...props} metadata={metadata} imeta={imeta} />;
}

function UserAvatarView({
  pubkey,
  metadata,
  imeta,
  name,
  className,
  fallbackClassName,
  fallbackStyle,
  anonymous,
  shape,
  frame = true,
  alt,
  draggable,
  fallback,
  children,
  loops,
  "aria-hidden": ariaHidden,
}: UserAvatarProps) {
  const label = name ?? getDisplayName(metadata, pubkey ?? "");
  const avatarShape = shape ?? getAvatarShape(metadata);
  const frameStyle = useFrameCss(useUltra(frame ? metadata : undefined)?.frame);
  const masked = !!avatarShape && isValidAvatarShape(avatarShape) && isEmoji(avatarShape);

  // A drop-shadow on a masked (emoji-shaped) avatar is cut away by its own mask,
  // so those wear the frame on a wrapper that takes over the layout classes.
  const wrapped = masked && !!frameStyle;
  const avatar = (
    <Avatar
      shape={avatarShape}
      aria-hidden={ariaHidden}
      className={wrapped ? "size-full" : className}
      sizeClassName={wrapped ? cn("h-10 w-10", className) : undefined}
      style={wrapped ? undefined : frameStyle}
    >
      {!anonymous && <AvatarImage src={metadata?.picture} imeta={imeta} alt={alt ?? label} draggable={draggable} loops={loops} />}
      <AvatarFallback className={cn("bg-primary/20 text-primary", fallbackClassName)} style={fallbackStyle}>
        {fallback ?? <AvatarInitial name={label} pubkey={pubkey} />}
      </AvatarFallback>
      {children}
    </Avatar>
  );
  if (!wrapped) return avatar;
  return <span className={cn("flex h-10 w-10 shrink-0", className)} style={frameStyle}>{avatar}</span>;
}
