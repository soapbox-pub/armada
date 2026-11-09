import { parseChatRoute } from "@/lib/routes";

/**
 * Whether the page at `pathname` opens the boot gate itself: a message timeline on its
 * first rows, the DM list on its first paint, `/` by redirecting to one. Every other page
 * has no first read for background ingest to delay, so it opens the gate on its first frame
 * rather than holding the wire for the gate's fallback.
 */
export function routeOpensBootGate(pathname: string): boolean {
  if (pathname === "/") return true;
  const route = parseChatRoute(pathname);
  if (!route) return false;
  switch (route.kind) {
    case "dm":
      return true;
    case "concord":
      // No channel and no pane lands on a channel; `all` is itself a merged timeline.
      return route.pane === undefined || route.pane === "all";
    case "nip29":
      // The server root lands on a group, or shows its channel list in a timeline's place.
      return route.pane === undefined;
    default:
      return true;
  }
}
