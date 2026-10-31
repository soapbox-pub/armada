/**
 * The draggable desktop panes: the channel list and the member list. Widths are
 * CSS variables on <html>, so a drag repaints without re-rendering React; the
 * per-device config holds the committed value.
 */

export type Pane = "channel" | "member";

interface PaneSpec {
  property: string;
  /** px; the layout's former fixed width (w-60, 16.5rem). */
  fallback: number;
  min: number;
  max: number;
}

export const PANES: Record<Pane, PaneSpec> = {
  channel: { property: "--channel-list-w", fallback: 240, min: 180, max: 400 },
  member: { property: "--member-list-w", fallback: 264, min: 200, max: 400 },
};

export function clampPaneWidth(pane: Pane, px: number): number {
  const { min, max } = PANES[pane];
  return Math.round(Math.min(max, Math.max(min, px)));
}

/** Set (or, for `undefined`, clear back to the default) a pane's width. */
export function applyPaneWidth(pane: Pane, px: number | undefined): void {
  const root = document.documentElement;
  if (px === undefined || !Number.isFinite(px)) root.style.removeProperty(PANES[pane].property);
  else root.style.setProperty(PANES[pane].property, `${clampPaneWidth(pane, px)}px`);
}

export function currentPaneWidth(pane: Pane): number {
  const raw = parseFloat(document.documentElement.style.getPropertyValue(PANES[pane].property));
  return Number.isFinite(raw) ? raw : PANES[pane].fallback;
}
