/**
 * Pure model and operations for the community rail: ordered items (NIP-29
 * servers by normalized relay URL, `c2:<id>` communities, `dm:<pubkey>` DMs)
 * and folders. Persisted in AppConfig and synced via NIP-78 (`${APP_ID}/rail`).
 *
 * The layout is the sole record of which DMs are on the rail. Keys that aren't
 * currently live (still loading) are kept, never dropped, so an early drag
 * can't destroy another device's folders — except via {@link removeKey} when
 * the user leaves.
 */

import { nip19 } from "nostr-tools";

import { relayToRouteParam } from "@/lib/platform";

/** A single ungrouped community/server in the rail. */
export interface RailItemNode {
  type: "item";
  key: string;
}

/** A named folder grouping several items (Discord server-folder analog). */
export interface RailFolderNode {
  type: "folder";
  id: string;
  name: string;
  keys: string[];
}

export type RailLayoutNode = RailItemNode | RailFolderNode;

/** What is being dragged: a single item, or a whole folder. */
export type RailDragSource = { kind: "item"; key: string } | { kind: "folder"; id: string };

export type RailDropTarget =
  /** Insert at the top level, before the node with this anchor. */
  | { type: "before"; anchor: string }
  /** Append at the end of the top level. */
  | { type: "end" }
  /** Merge the dragged item with a top-level item into a NEW folder. */
  | { type: "combine"; withKey: string }
  /** Insert the dragged item into an existing folder (before a child, or appended). */
  | { type: "into-folder"; folderId: string; beforeKey?: string };

/** Stable rail key for a direct-message conversation with `pubkey` (hex). */
export function dmRailKey(pubkey: string): string {
  return `dm:${pubkey}`;
}

/** Peer pubkey of a `dm:` key, or `null`. Hex is checked: the key round-trips through synced settings. */
export function railKeyDmPubkey(key: string): string | null {
  if (!key.startsWith("dm:")) return null;
  const pubkey = key.slice("dm:".length);
  return /^[0-9a-f]{64}$/.test(pubkey) ? pubkey : null;
}

/** DM peers on the rail in visual order, read from the stored layout. */
export function railDmPubkeys(stored: RailLayoutNode[]): string[] {
  const out: string[] = [];
  for (const key of flattenLayout(stored)) {
    const pubkey = railKeyDmPubkey(key);
    if (pubkey && !out.includes(pubkey)) out.push(pubkey);
  }
  return out;
}

/** Stable DOM/target anchor for a top-level node. */
export function itemAnchor(key: string): string {
  return `item:${key}`;
}
export function folderAnchor(id: string): string {
  return `folder:${id}`;
}
export function nodeAnchor(node: RailLayoutNode): string {
  return node.type === "item" ? itemAnchor(node.key) : folderAnchor(node.id);
}

/** All item keys in visual order (folders flattened in place). */
export function flattenLayout(nodes: RailLayoutNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type === "item") out.push(node.key);
    else out.push(...node.keys);
  }
  return out;
}

/** React Router path for a rail key (relay URL, `c2:`, `dm:`), or `null`. */
export function railKeyToRoute(key: string): string | null {
  if (key.startsWith("c2:")) {
    return `/c/${encodeURIComponent(key.slice("c2:".length))}`;
  }
  if (key.startsWith("dm:")) {
    const pubkey = railKeyDmPubkey(key);
    // The peer route, not `/dm`: on mobile the list would make the rail icon a dead end.
    return pubkey ? `/dm/${nip19.npubEncode(pubkey)}` : null;
  }
  return `/s/${relayToRouteParam(key)}`;
}

/**
 * The route `/` lands a signed-in user on: the first rail item that is a live
 * NIP-29 server or a Concord community that isn't blocklisted, else `null`.
 * A blocked community stays in the layout, so landing on it would bounce
 * every trip home straight back to its blocked page.
 */
export function firstRailRoute(
  stored: RailLayoutNode[],
  liveServers: string[],
  isBlocked: (communityId: string) => boolean,
): string | null {
  const servers = new Set(liveServers);
  for (const key of flattenLayout(mergeLayout(stored, liveServers))) {
    if (key.startsWith("c2:")) {
      if (isBlocked(key.slice("c2:".length))) continue;
    } else if (!servers.has(key)) {
      // A NIP-29 server the user no longer has (or not yet loaded), or a DM.
      continue;
    }
    const route = railKeyToRoute(key);
    if (route) return route;
  }
  return null;
}

/**
 * History state the `/` redirect hands its landing: the communities it already
 * found inaccessible on this trip. The rail layout outlives a membership, and
 * the list resolves after the redirect, so the community page reports a miss
 * by bouncing home with itself appended; the list only grows, so it terminates.
 */
export interface HomeLandingState {
  homeSkipped: string[];
}

/** The skipped communities if `state` came from the `/` redirect, else `null`. */
export function homeSkippedOf(state: unknown): string[] | null {
  if (!state || typeof state !== "object") return null;
  const skipped = (state as Partial<HomeLandingState>).homeSkipped;
  return Array.isArray(skipped) && skipped.every((id) => typeof id === "string") ? skipped : null;
}

/** Canonicalize: dedupe keys (first wins), drop empty folders, dissolve single-item folders (Discord behavior). */
export function normalizeLayout(nodes: RailLayoutNode[]): RailLayoutNode[] {
  const seenKeys = new Set<string>();
  const seenFolders = new Set<string>();
  const out: RailLayoutNode[] = [];
  for (const node of nodes) {
    if (node.type === "item") {
      if (seenKeys.has(node.key)) continue;
      seenKeys.add(node.key);
      out.push(node);
    } else {
      if (seenFolders.has(node.id)) continue;
      seenFolders.add(node.id);
      const keys = node.keys.filter((k) => {
        if (seenKeys.has(k)) return false;
        seenKeys.add(k);
        return true;
      });
      if (keys.length === 0) continue;
      if (keys.length === 1) {
        out.push({ type: "item", key: keys[0] });
        continue;
      }
      out.push({ ...node, keys });
    }
  }
  return out;
}

/** Append live keys the layout doesn't know as top-level items. Never removes unknown keys. */
export function mergeLayout(stored: RailLayoutNode[], liveKeys: string[]): RailLayoutNode[] {
  const out = normalizeLayout(stored);
  const known = new Set(flattenLayout(out));
  for (const key of liveKeys) {
    if (!known.has(key)) {
      known.add(key);
      out.push({ type: "item", key });
    }
  }
  return out;
}

/** Remove an item key from everywhere in the layout (without normalizing). */
function detachKey(nodes: RailLayoutNode[], key: string): RailLayoutNode[] {
  const out: RailLayoutNode[] = [];
  for (const node of nodes) {
    if (node.type === "item") {
      if (node.key !== key) out.push(node);
    } else {
      out.push(node.keys.includes(key) ? { ...node, keys: node.keys.filter((k) => k !== key) } : node);
    }
  }
  return out;
}

/**
 * Remove a key entirely when leaving a community/server. Destructive on purpose,
 * or a rejoin would resurrect it in its old folder.
 */
export function removeKey(nodes: RailLayoutNode[], key: string): RailLayoutNode[] {
  return normalizeLayout(detachKey(nodes, key));
}

/**
 * Random folder id. `crypto.randomUUID` is undefined in insecure contexts
 * (plain http over LAN), so fall back to `getRandomValues`.
 */
function generateFolderId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Apply a drop and normalize. `newFolderId` is injectable for tests. */
export function applyDrop(
  nodes: RailLayoutNode[],
  source: RailDragSource,
  target: RailDropTarget,
  newFolderId?: string,
): RailLayoutNode[] {
  const sourceAnchor = source.kind === "item" ? itemAnchor(source.key) : folderAnchor(source.id);
  if (target.type === "before" && target.anchor === sourceAnchor) return normalizeLayout(nodes);

  if (source.kind === "folder") {
    // Folders only move at the top level: no combining, no nesting.
    if (target.type !== "before" && target.type !== "end") return normalizeLayout(nodes);
    const folder = nodes.find(
      (n): n is RailFolderNode => n.type === "folder" && n.id === source.id,
    );
    if (!folder) return normalizeLayout(nodes);
    const without = nodes.filter((n) => !(n.type === "folder" && n.id === source.id));
    return normalizeLayout(insertTopLevel(without, folder, target));
  }

  const key = source.key;
  const detached = detachKey(nodes, key);

  switch (target.type) {
    case "before":
    case "end":
      return normalizeLayout(insertTopLevel(detached, { type: "item", key }, target));
    case "combine": {
      if (target.withKey === key) return normalizeLayout(nodes);
      const idx = detached.findIndex((n) => n.type === "item" && n.key === target.withKey);
      if (idx === -1) {
        // Combine target vanished (raced): fall back to appending.
        return normalizeLayout([...detached, { type: "item", key }]);
      }
      const folder: RailFolderNode = {
        type: "folder",
        id: newFolderId ?? generateFolderId(),
        name: "",
        keys: [target.withKey, key],
      };
      const out = [...detached];
      out.splice(idx, 1, folder);
      return normalizeLayout(out);
    }
    case "into-folder": {
      const out = detached.map((n) => {
        if (n.type !== "folder" || n.id !== target.folderId) return n;
        const keys = [...n.keys];
        const at = target.beforeKey ? keys.indexOf(target.beforeKey) : -1;
        if (at === -1) keys.push(key);
        else keys.splice(at, 0, key);
        return { ...n, keys };
      });
      // Folder vanished (raced): fall back to appending at the top level.
      if (!out.some((n) => n.type === "folder" && n.id === target.folderId && n.keys.includes(key))) {
        return normalizeLayout([...out, { type: "item", key }]);
      }
      return normalizeLayout(out);
    }
  }
}

function insertTopLevel(
  nodes: RailLayoutNode[],
  node: RailLayoutNode,
  target: { type: "before"; anchor: string } | { type: "end" },
): RailLayoutNode[] {
  if (target.type === "end") return [...nodes, node];
  const idx = nodes.findIndex((n) => nodeAnchor(n) === target.anchor);
  if (idx === -1) return [...nodes, node];
  const out = [...nodes];
  out.splice(idx, 0, node);
  return out;
}

export function renameFolder(nodes: RailLayoutNode[], id: string, name: string): RailLayoutNode[] {
  return nodes.map((n) => (n.type === "folder" && n.id === id ? { ...n, name } : n));
}

/** Dissolve a folder in place: its items pop back out as top-level items. */
export function dissolveFolder(nodes: RailLayoutNode[], id: string): RailLayoutNode[] {
  const out: RailLayoutNode[] = [];
  for (const node of nodes) {
    if (node.type === "folder" && node.id === id) {
      out.push(...node.keys.map((key): RailItemNode => ({ type: "item", key })));
    } else {
      out.push(node);
    }
  }
  return normalizeLayout(out);
}

/**
 * A rendered rail slot, frozen at drag pickup. `top` and the plan's `indicatorY` share one
 * coordinate space, which the caller picks (the rail uses its scroll container's content).
 */
export interface RailSlot {
  /** `item:<key>` or `folder:<id>`. */
  anchor: string;
  /** Set when this slot is a child inside an expanded folder. */
  parentFolderId?: string;
  top: number;
  height: number;
}

/** The computed landing spot for the pointer's current position. */
export interface RailDropPlan {
  target: RailDropTarget;
  /** Y for the insertion-indicator line (gap drops), in the slots' coordinates. */
  indicatorY?: number;
  /** Anchor of the node to highlight (combine / drop-into-folder). */
  highlightAnchor?: string;
}

/**
 * Centered fraction of an item slot that means "combine"; the rest are reorder
 * zones. Folders accept drops over their full rect (forgiving under a finger).
 */
const ITEM_COMBINE_BAND = 0.7;

/**
 * Where a drop at `y` lands (Discord semantics): over a folder → into
 * it; an item's middle band → combine into a new folder; otherwise insert
 * before the nearest slot below. Folders only reorder at the top level.
 */
export function planDrop(y: number, slots: RailSlot[], source: RailDragSource): RailDropPlan | null {
  // Exclude the dragged node's own slot(s); folders only see top-level slots.
  const eligible = slots.filter((s) => {
    if (source.kind === "item") {
      return s.anchor !== itemAnchor(source.key);
    }
    return s.parentFolderId === undefined && s.anchor !== folderAnchor(source.id);
  });
  if (eligible.length === 0) return null;

  if (source.kind === "item") {
    const band = eligible.find((s) => {
      const frac = s.anchor.startsWith("folder:") ? 1 : ITEM_COMBINE_BAND;
      const inset = (s.height * (1 - frac)) / 2;
      return y >= s.top + inset && y <= s.top + s.height - inset;
    });
    if (band) {
      const center = band.top + band.height / 2;
      if (band.parentFolderId !== undefined) {
        // Middle of a folder child: insert before/after it within the folder.
        if (y < center) {
          return {
            target: { type: "into-folder", folderId: band.parentFolderId, beforeKey: keyOf(band.anchor) },
            indicatorY: band.top - 2,
          };
        }
        const next = nextFolderSibling(eligible, band);
        return {
          target: {
            type: "into-folder",
            folderId: band.parentFolderId,
            beforeKey: next ? keyOf(next.anchor) : undefined,
          },
          indicatorY: band.top + band.height + 2,
        };
      }
      if (band.anchor.startsWith("folder:")) {
        return {
          target: { type: "into-folder", folderId: band.anchor.slice("folder:".length) },
          highlightAnchor: band.anchor,
        };
      }
      return {
        target: { type: "combine", withKey: keyOf(band.anchor) },
        highlightAnchor: band.anchor,
      };
    }
  }

  for (const s of eligible) {
    if (y < s.top + s.height / 2) {
      if (s.parentFolderId !== undefined) {
        return {
          target: { type: "into-folder", folderId: s.parentFolderId, beforeKey: keyOf(s.anchor) },
          indicatorY: s.top - 2,
        };
      }
      return { target: { type: "before", anchor: s.anchor }, indicatorY: s.top - 2 };
    }
  }

  const last = eligible[eligible.length - 1];
  return { target: { type: "end" }, indicatorY: last.top + last.height + 2 };
}

function keyOf(anchor: string): string {
  return anchor.startsWith("item:") ? anchor.slice("item:".length) : anchor;
}

/** The next slot in the same folder after `slot`, if any. */
function nextFolderSibling(slots: RailSlot[], slot: RailSlot): RailSlot | undefined {
  const idx = slots.indexOf(slot);
  for (let i = idx + 1; i < slots.length; i++) {
    if (slots[i].parentFolderId === slot.parentFolderId) return slots[i];
    return undefined; // Left the folder's contiguous run.
  }
  return undefined;
}
