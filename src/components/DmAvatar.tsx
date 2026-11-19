/**
 * DM avatar: one face for 1:1, a tiled grid clipped to one circle for groups
 * (same footprint as a single avatar). 2 split vertically, 3 = one half + two
 * stacked, 4 = 2×2; past four the last cell is a `+N` count.
 */

import { NoteToSelfAvatar } from "@/components/NoteToSelfAvatar";
import { UserAvatar } from "@/components/UserAvatar";
import { cn } from "@/lib/utils";

const GRID_CELLS = 4;

function DmAvatarCell({
  pubkey,
  tile,
  fallbackClassName,
  /** Never fetch the picture — see ConversationRow. */
  anonymous,
}: {
  pubkey: string;
  /** Grid cell: square, clipped by the grid's rounding (no avatar shape of its own). */
  tile?: boolean;
  fallbackClassName?: string;
  anonymous?: boolean;
}) {
  return (
    <UserAvatar
      pubkey={pubkey}
      anonymous={anonymous}
      // A grid tile is clipped by its neighbours, so only a lone face wears an Ultra frame.
      frame={!tile}
      shape={tile ? "circle" : undefined}
      className={cn("size-full", tile && "rounded-none")}
      fallbackClassName={cn(tile && "rounded-none", fallbackClassName)}
    />
  );
}

export function DmAvatar({
  peers,
  selfPubkey,
  sizePx,
  className,
  anonymous,
}: {
  peers: readonly string[];
  selfPubkey?: string;
  /** Rendered size in px; must match what `className` sets. */
  sizePx: number;
  className?: string;
  anonymous?: boolean;
}) {
  if (peers.length === 1 && peers[0] === selfPubkey) {
    return <NoteToSelfAvatar sizePx={sizePx} className={className} />;
  }

  if (peers.length <= 1) {
    const peer = peers[0];
    if (!peer) {
      return <span className={cn("shrink-0 rounded-full bg-muted", className)} aria-hidden />;
    }
    return (
      <div className={cn("shrink-0", className)}>
        <DmAvatarCell
          pubkey={peer}
          anonymous={anonymous}
          fallbackClassName={sizePx >= 40 ? "text-base" : "text-3xs"}
        />
      </div>
    );
  }

  const faces = peers.length > GRID_CELLS ? peers.slice(0, GRID_CELLS - 1) : peers.slice(0, GRID_CELLS);
  const overflow = peers.length - faces.length;
  const three = faces.length + (overflow > 0 ? 1 : 0) === 3;
  const countPx = Math.max(7, Math.round(sizePx * 0.2));

  return (
    <div
      className={cn(
        "grid shrink-0 gap-px overflow-hidden rounded-full bg-background",
        peers.length === 2 ? "grid-cols-2 grid-rows-1" : "grid-cols-2 grid-rows-2",
        className,
      )}
    >
      {faces.map((peer, i) => (
        <div key={peer} className={cn("overflow-hidden", three && i === 0 && "row-span-2")}>
          <DmAvatarCell
            pubkey={peer}
            tile
            anonymous={anonymous}
            fallbackClassName={sizePx >= 40 ? "text-3xs" : "text-monogram"}
          />
        </div>
      ))}
      {overflow > 0 && (
        <div className="overflow-hidden">
          <span
            className="flex size-full items-center justify-center bg-primary/20 font-medium leading-none text-primary"
            style={{ fontSize: `${countPx}px` }}
          >
            +{overflow}
          </span>
        </div>
      )}
    </div>
  );
}
