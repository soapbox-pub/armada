import { EyeOff } from "lucide-react";

import { useMediaHoldMode, useTrustMediaHost } from "@/components/chat/mediaHold";
import { Button } from "@/components/ui/button";
import { FormattedMessage, useIntl } from "@/i18n";

import type { MouseEvent, PointerEvent } from "react";

/** Keep the row's tap and long-press menu from claiming a press meant for the card. */
const stopClick = (e: MouseEvent) => e.stopPropagation();
const stopPointer = (e: PointerEvent) => e.stopPropagation();

/**
 * Stand-in for media held by the media hold (`components/chat/mediaHold.ts`).
 * Renders nothing of the sender's — no blurhash, no thumbnail, no alt — since
 * all of it is theirs to choose; the media is fetched only after "Load".
 */
export function HeldMedia({
  kind,
  count = 1,
  host,
  blocked,
  onLoad,
}: {
  kind: "image" | "video" | "audio";
  count?: number;
  /** Held for where it is hosted rather than who sent it. */
  host?: string;
  /** Held because the viewer blocked the sender. */
  blocked?: boolean;
  onLoad: () => void;
}) {
  const intl = useIntl();
  const mode = useMediaHoldMode();
  const trustHost = useTrustMediaHost();
  const values = { kind, count: count > 1 ? count : 1, host };

  let title: string;
  let detail: string | undefined;
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
    detail = intl.formatMessage({ id: "heldMedia.notLoadedDetail", defaultMessage: "You load community media yourself." });
  } else {
    title = intl.formatMessage(
      { id: "heldMedia.newMember", defaultMessage: "{kind, select, video {Video from a new member} audio {Audio from a new member} other {{count, plural, one {Image from a new member} other {# images from a new member}}}}" },
      values,
    );
    detail = intl.formatMessage({ id: "heldMedia.newMemberDetail", defaultMessage: "Loads on its own once they've been around a day." });
  }

  return (
    <div className="my-1.5 flex max-w-sm items-center gap-3 clip-corner-lg bg-muted/60 px-3 py-2 whitespace-normal">
      <EyeOff className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight">{title}</div>
        {host && trustHost ? (
          <button
            type="button"
            className="text-xs leading-snug text-muted-foreground underline-offset-2 hover:text-foreground hover:underline touch:min-h-11"
            onClick={(e) => {
              stopClick(e);
              trustHost(host);
            }}
            onPointerDown={stopPointer}
          >
            <FormattedMessage id="heldMedia.alwaysLoad" defaultMessage="Always load from {host}" values={{ host }} />
          </button>
        ) : (
          detail && <div className="text-xs leading-snug text-muted-foreground">{detail}</div>
        )}
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="shrink-0 touch:h-11"
        onClick={(e) => {
          stopClick(e);
          onLoad();
        }}
        onPointerDown={stopPointer}
      >
        <FormattedMessage id="heldMedia.load" defaultMessage="Load" />
      </Button>
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
      <EyeOff className="size-3.5" aria-hidden />
      <FormattedMessage id="heldMedia.loadPreviews" defaultMessage="Load previews" />
    </button>
  );
}
