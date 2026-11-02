import { useEffect, useRef } from "react";

import { useAppContext } from "@/hooks/useAppContext";
import { useIntl } from "@/i18n";
import { applyPaneWidth, clampPaneWidth, currentPaneWidth, PANES, type Pane } from "@/lib/paneWidth";
import { cn } from "@/lib/utils";

const CONFIG_KEY = { channel: "channelListWidth", member: "memberListWidth" } as const;
const KEY_STEP = 16;

/**
 * Drag handle on a desktop pane's inner edge. The drag writes the CSS variable
 * directly; the width reaches config (which crosses the KV bridge) once, on release.
 * Double-click restores the default.
 */
export function PaneResizeHandle({ pane, className }: { pane: Pane; className?: string }) {
  const intl = useIntl();
  const { config, updateConfig } = useAppContext();
  const drag = useRef<{ x: number; width: number } | null>(null);
  // The member list sits right of the chat, so dragging LEFT widens it.
  const sign = pane === "member" ? -1 : 1;

  const saved = useRef<number | undefined>(undefined);
  saved.current = config[CONFIG_KEY[pane]];
  /** Abandon a drag in progress: the pane goes back to its saved width. */
  const cancel = useRef(() => {});
  cancel.current = () => {
    if (!drag.current) return;
    drag.current = null;
    delete document.documentElement.dataset.paneResizing;
    applyPaneWidth(pane, saved.current);
  };
  // The pane can hide mid-drag (member list toggle, a narrowing window), taking this handle with it.
  useEffect(() => () => cancel.current(), []);

  const commit = (px: number | undefined) => {
    updateConfig((current) => ({ ...current, [CONFIG_KEY[pane]]: px === undefined ? undefined : clampPaneWidth(pane, px) }));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={
        pane === "channel"
          ? intl.formatMessage({ id: "paneResizeHandle.channel", defaultMessage: "Resize channel list" })
          : intl.formatMessage({ id: "paneResizeHandle.member", defaultMessage: "Resize member list" })
      }
      aria-valuemin={PANES[pane].min}
      aria-valuemax={PANES[pane].max}
      aria-valuenow={config[CONFIG_KEY[pane]] ?? PANES[pane].fallback}
      tabIndex={0}
      className={cn(
        // A gutter-wide grab area around a thinner visible bar.
        "absolute inset-y-0 z-30 w-3 cursor-col-resize touch-none focus-visible:outline-none",
        // The channel list sits beside the chat on any desktop window; on a phone
        // it is a full-width drill-down, and the member list is an overlay below `sidebar`.
        pane === "channel" ? "touch:max-sidebar:hidden" : "hidden sidebar:block",
        "before:absolute before:inset-y-0 before:left-1/2 before:w-1.5 before:-translate-x-1/2 before:transition-colors",
        "hover:before:bg-primary/30 focus-visible:before:bg-primary/40",
        // The channel list's scrollbar is on this edge, so its handle sits in the gutter beside it.
        pane === "channel" ? "-right-3" : "-left-1.5",
        className,
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width: currentPaneWidth(pane) };
        document.documentElement.dataset.paneResizing = "";
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        applyPaneWidth(pane, drag.current.width + sign * (e.clientX - drag.current.x));
      }}
      onPointerUp={(e) => {
        if (!drag.current) return;
        const moved = e.clientX - drag.current.x;
        const px = drag.current.width + sign * moved;
        drag.current = null;
        delete document.documentElement.dataset.paneResizing;
        // A click is not a resize: it would pin today's default as a chosen width.
        if (moved !== 0) commit(px);
      }}
      onPointerCancel={() => cancel.current()}
      onLostPointerCapture={() => cancel.current()}
      onDoubleClick={() => commit(undefined)}
      onKeyDown={(e) => {
        const step = e.key === "ArrowRight" ? KEY_STEP : e.key === "ArrowLeft" ? -KEY_STEP : 0;
        if (!step) return;
        e.preventDefault();
        commit(currentPaneWidth(pane) + sign * step);
      }}
    />
  );
}
