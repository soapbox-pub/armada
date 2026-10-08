/**
 * The one place a chat route is spelled (NIP-29/Buzz, Concord, DMs): builder
 * plus parser.
 *
 *     /c/<community>/<channel>                    the channel
 *     /c/<community>/<channel>/m/<id>             a message in its timeline
 *     /c/<community>/<channel>/t/<root>           the thread opened at <root>
 *     /c/<community>/<channel>/t/<root>/m/<id>    a reply INSIDE that thread
 */

import { nip19 } from "nostr-tools";
import { DM_PEER_SEP } from "@/lib/nip17/conversation";
import { relayToRouteParam, routeParamToRelay } from "@/lib/platform";
import { resolvePubkey } from "@/lib/resolvePubkey";
import { shareOrigin } from "@/lib/shareOrigin";

/** Non-channel panes of a Concord community. */
export const CONCORD2_PANES = [
  "all",
  "mentions",
  "threads",
  "projects",
  "audit",
  "invites",
  "banned",
  "members",
  "reports",
  "roles",
  "settings",
  "suspicious",
] as const;
export type Concord2Pane = (typeof CONCORD2_PANES)[number];

/**
 * Non-channel panes of a NIP-29 server, in the group-id position (static
 * segments outrank `:groupId`, so a group named `projects` is unreachable).
 */
export const NIP29_PANES = ["projects", "inbox"] as const;
export type Nip29Pane = (typeof NIP29_PANES)[number];

export interface Nip29Route {
  kind: "nip29";
  relayUrl: string;
  /** Absent ⇒ the server's channel list. Mutually exclusive with `pane`. */
  groupId?: string;
  pane?: Nip29Pane;
  threadRoot?: string;
  messageId?: string;
}

export interface Concord2Route {
  kind: "concord";
  communityId: string;
  /** Mutually exclusive with `pane`. */
  channelId?: string;
  pane?: Concord2Pane;
  threadRoot?: string;
  messageId?: string;
}

export interface DmRoute {
  kind: "dm";
  /**
   * The conversation key (see `dmConvKey`): a bare pubkey for 1:1, so old
   * `/dm/<npub>` links resolve; groups join participants with {@link DM_PEER_SEP}.
   * Absent ⇒ the conversation list.
   */
  peer?: string;
  messageId?: string;
}

export type ChatRoute = Nip29Route | Concord2Route | DmRoute;

function isConcordPane(value: string): value is Concord2Pane {
  return (CONCORD2_PANES as readonly string[]).includes(value);
}

function isNip29Pane(value: string): value is Nip29Pane {
  return (NIP29_PANES as readonly string[]).includes(value);
}

/**
 * The `/dm/` segment for a conversation key: each participant as an npub,
 * joined by a literal separator. Enforces ONE spelling, since route strings
 * are identities (share stash, Direct Share shortcuts, sent-rooms ledger).
 * Non-pubkey segments are URL-escaped and still round-trip.
 */
function dmPathSegment(peer: string): string {
  return peer
    .split(DM_PEER_SEP)
    .map((part) => {
      const pubkey = resolvePubkey(part);
      return pubkey ? nip19.npubEncode(pubkey) : encodeURIComponent(part);
    })
    .join(DM_PEER_SEP);
}

function withFocus(
  base: string,
  focus: { threadRoot?: string; messageId?: string },
): string {
  let path = base;
  if (focus.threadRoot) path += `/t/${encodeURIComponent(focus.threadRoot)}`;
  if (focus.messageId) path += `/m/${encodeURIComponent(focus.messageId)}`;
  return path;
}

export function chatRoute(route: ChatRoute): string {
  switch (route.kind) {
    case "nip29": {
      const base = `/s/${relayToRouteParam(route.relayUrl)}`;
      if (route.pane) return `${base}/${route.pane}`;
      if (!route.groupId) return base;
      return withFocus(`${base}/${encodeURIComponent(route.groupId)}`, route);
    }
    case "concord": {
      const base = `/c/${encodeURIComponent(route.communityId)}`;
      if (route.pane) return `${base}/${route.pane}`;
      if (!route.channelId) return base;
      return withFocus(`${base}/${encodeURIComponent(route.channelId)}`, route);
    }
    case "dm": {
      if (!route.peer) return "/dm";
      return withFocus(`/dm/${dmPathSegment(route.peer)}`, { messageId: route.messageId });
    }
  }
}

/** The location with thread/message focus stripped (closing a thread, a dead permalink, sending). */
export function roomRoute(route: ChatRoute): ChatRoute {
  switch (route.kind) {
    case "nip29":
      return { kind: "nip29", relayUrl: route.relayUrl, groupId: route.groupId, pane: route.pane };
    case "concord":
      return {
        kind: "concord",
        communityId: route.communityId,
        channelId: route.channelId,
        pane: route.pane,
      };
    case "dm":
      return { kind: "dm", peer: route.peer };
  }
}

/** The room path with thread/message focus stripped. Shorthand for the pair. */
export function roomPath(route: ChatRoute): string {
  return chatRoute(roomRoute(route));
}

/** Drop only the message focus; an open `/t/<root>` thread panel stays. */
export function withoutMessage(route: ChatRoute): ChatRoute {
  if (route.kind === "dm") return { kind: "dm", peer: route.peer };
  const { messageId: _dropped, ...rest } = route;
  return rest;
}

/** Parse the `/t/<root>` + `/m/<id>` suffix; `null` for anything else. */
function parseFocus(
  rest: readonly string[],
): { threadRoot?: string; messageId?: string } | null {
  if (rest.length === 0) return {};
  if (rest.length === 2) {
    const [marker, value] = rest;
    if (marker === "t") return { threadRoot: decodeURIComponent(value) };
    if (marker === "m") return { messageId: decodeURIComponent(value) };
    return null;
  }
  if (rest.length === 4 && rest[0] === "t" && rest[2] === "m") {
    return {
      threadRoot: decodeURIComponent(rest[1]),
      messageId: decodeURIComponent(rest[3]),
    };
  }
  return null;
}

/** Parse a chat path, or `null` when it names no chat location. */
export function parseChatRoute(pathname: string): ChatRoute | null {
  const seg = pathname.split("/").filter(Boolean);
  if (seg.length === 0) return null;

  switch (seg[0]) {
    case "s": {
      if (seg.length < 2) return null;
      const relayUrl = routeParamToRelay(seg[1]);
      if (!relayUrl) return null;
      if (seg.length === 2) return { kind: "nip29", relayUrl };
      const room = decodeURIComponent(seg[2]);
      if (seg.length === 3 && isNip29Pane(room)) return { kind: "nip29", relayUrl, pane: room };
      const focus = parseFocus(seg.slice(3));
      if (!focus) return null;
      return { kind: "nip29", relayUrl, groupId: room, ...focus };
    }
    case "c": {
      if (seg.length < 2) return null;
      const communityId = decodeURIComponent(seg[1]);
      if (seg.length === 2) return { kind: "concord", communityId };
      const room = decodeURIComponent(seg[2]);
      if (seg.length === 3 && isConcordPane(room)) {
        return { kind: "concord", communityId, pane: room };
      }
      const focus = parseFocus(seg.slice(3));
      if (!focus) return null;
      return { kind: "concord", communityId, channelId: room, ...focus };
    }
    // Pre-rename DM path: stale push subscriptions and notifications can still land here.
    case "dm":
    case "dms": {
      if (seg.length === 1) return { kind: "dm" };
      const peer = seg[1]
        .split(DM_PEER_SEP)
        .map(decodeURIComponent)
        .join(DM_PEER_SEP);
      if (seg.length === 2) return { kind: "dm", peer };
      const focus = parseFocus(seg.slice(2));
      if (!focus || focus.threadRoot) return null;
      return { kind: "dm", peer, messageId: focus.messageId };
    }
    default:
      return null;
  }
}

/** Absolute shareable URL; `shareOrigin()` is the public web origin even on native. */
export function chatUrl(route: ChatRoute): string {
  return `${shareOrigin()}${chatRoute(route)}`;
}
