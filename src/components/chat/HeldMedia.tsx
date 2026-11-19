import { ChevronDown, Film, ImageIcon, Music, ShieldCheck } from "lucide-react";
import { useId, type ReactNode } from "react";

import { useMediaHoldMode, useTrustMediaHost } from "@/components/chat/mediaHold";
import { FormattedMessage, useIntl } from "@/i18n";
import { cn } from "@/lib/utils";

import type { MouseEvent, PointerEvent } from "react";

/** Keep the row's tap and long-press menu from claiming a press meant for the card. */
const stopClick = (e: MouseEvent) => e.stopPropagation();
const stopPointer = (e: PointerEvent) => e.stopPropagation();

const KIND_ICON = { image: ImageIcon, video: Film, audio: Music } as const;
const actionClass = "flex min-h-9 touch:min-h-11 w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-background/50 px-3 py-2 text-sm font-semibold hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/**
 * Stand-in for media held by the media hold (`components/chat/mediaHold.ts`).
 * Renders nothing of the sender's — no blurhash, no thumbnail, no alt — since
 * all of it is theirs to choose; the media is fetched only once the card is
 * opened. Opened (`children` given), it frames the loaded media, and for a held
 * host offers to trust it.
 */
export function HeldMedia({
  kind,
  count = 1,
  host,
  blocked,
  onLoad,
  onCollapse,
  children,
}: {
  kind: "image" | "video" | "audio";
  count?: number;
  /** Held for where it is hosted rather than who sent it. */
  host?: string;
  /** Held because the viewer blocked the sender. */
  blocked?: boolean;
  onLoad: () => void;
  onCollapse?: () => void;
  /** The loaded media; present once opened. */
  children?: ReactNode;
}) {
  const intl = useIntl();
  const mode = useMediaHoldMode();
  const trustHost = useTrustMediaHost();
  const panelId = useId();
  const open = children !== undefined;
  const values = { kind, count: count > 1 ? count : 1, host };
  const Icon = KIND_ICON[kind];

  let title: string;
  if (blocked) {
    title = intl.formatMessage(
      { id: "heldMedia.blocked", defaultMessage: "{kind, select, video {Video from someone you blocked} audio {Audio from someone you blocked} other {{count, plural, one {Image from someone you blocked} other {# images from someone you blocked}}}}" },
      values,
    );
  } else if (host) {
    title = intl.formatMessage(
      { id: "heldMedia.onHost", defaultMessage: "{kind, select, video {Video on {host}} audio {Audio on {host}} other {{count, plural, one {Image on {host}} other {# images on {host}}}}}" },
      values,
    );
  } else if (mode === "never") {
    title = intl.formatMessage(
      { id: "heldMedia.notLoaded", defaultMessage: "{kind, select, video {Video not loaded} audio {Audio not loaded} other {{count, plural, one {Image not loaded} other {# images not loaded}}}}" },
      values,
    );
  } else {
    title = intl.formatMessage(
      { id: "heldMedia.newMember", defaultMessage: "{kind, select, video {Video from a new member} audio {Audio from a new member} other {{count, plural, one {Image from a new member} other {# images from a new member}}}}" },
      values,
    );
  }

  return (
    <div
      className="my-1.5 w-full max-w-sm rounded-xl bg-secondary/55 p-2 whitespace-normal"
      onClick={stopClick}
      onPointerDown={stopPointer}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={open ? onCollapse : onLoad}
        disabled={open && !onCollapse}
        className="flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2 text-start hover:bg-background/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:hover:bg-transparent"
      >
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-background/50 text-primary">
          <Icon className="size-5" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      <div id={panelId} hidden={!open}>
        {open && (
          <>
            <div className="px-1 [&>*]:max-w-full">{children}</div>
            {host && trustHost && !blocked && (
              <button type="button" className={actionClass} onClick={() => trustHost(host)}>
                <ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden />
                <span className="truncate">
                  <FormattedMessage id="heldMedia.alwaysLoad" defaultMessage="Always load from {host}" values={{ host }} />
                </span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Trailing Load for a held message whose only held content is previews and embeds. */
export function HeldPreviews({ onLoad }: { onLoad: () => void }) {
  return (
    <button
      type="button"
      className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground touch:min-h-11"
      onClick={(e) => {
        stopClick(e);
        onLoad();
      }}
      onPointerDown={stopPointer}
    >
      <ChevronDown className="size-3.5" aria-hidden />
      <FormattedMessage id="heldMedia.loadPreviews" defaultMessage="Load previews" />
    </button>
  );
}
