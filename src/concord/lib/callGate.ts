/**
 * Who a Concord call lets be heard and seen (CORD-04 §8, CORD-07): every receiver
 * enforces SPEAK and VIDEO from the Roster as it stands, and a running Timeout
 * silences and hides its target. Vector's `may_speak` / `may_video`. On a legacy
 * Roster nobody holds the voice bits, so only a Timeout holds.
 */

import { isEntitled } from "@/concord/lib/channelAccess";
import type { FoldedControl } from "@/concord/lib/control";
import { timeoutRunning, type FoldedTimeout } from "@/concord/lib/guestbook";
import { channelPermissions, Permissions } from "@/concord/lib/roles";

export interface CallAllowance {
  speak: boolean;
  video: boolean;
  /** PRIORITY_SPEAKER: others are ducked while they talk (CORD-07 §7). */
  priority?: boolean;
  /** False for a member {@link mayConnect} keeps out of the call. */
  connect?: boolean;
}

/**
 * Whether `member` may be in a Channel's call: not banned, and the Channel resolves
 * View and Connect for them; on a legacy Roster, a Private Channel's entitled only
 * (CORD-07 §1, Vector `may_connect`).
 */
export function mayConnect(folded: FoldedControl | undefined, channelIdHex: string, isPrivate: boolean, member: string): boolean {
  if (!folded) return true;
  if (folded.banned.has(member)) return false;
  if (folded.roster.everyone === undefined) return !isPrivate || isEntitled(folded.roster, folded.ownerHex, member, channelIdHex);
  const needed = Permissions.VIEW_CHANNEL | Permissions.CONNECT;
  return (channelPermissions(folded.roster, folded.ownerHex, member, channelIdHex, isPrivate) & needed) === needed;
}

/** The gain everyone else plays at while a priority speaker talks (Vector's `DUCK_GAIN`). */
export const DUCK_GAIN = 0.3;

export function callAllowance(
  folded: FoldedControl | undefined,
  channelIdHex: string,
  isPrivate: boolean,
  member: string,
  timeouts: ReadonlyMap<string, FoldedTimeout>,
  nowMs: number,
): CallAllowance {
  if (timeoutRunning(timeouts.get(member), nowMs)) return { speak: false, video: false };
  if (!folded || folded.roster.everyone === undefined) return { speak: true, video: true };
  const p = channelPermissions(folded.roster, folded.ownerHex, member, channelIdHex, isPrivate);
  const priority = (p & Permissions.PRIORITY_SPEAKER) !== 0n;
  return { speak: (p & Permissions.SPEAK) !== 0n, video: (p & Permissions.VIDEO) !== 0n, ...(priority ? { priority } : {}) };
}

/**
 * The live call's gate (CORD-07 §7): {@link callAllowance}, and a moderator's mute or
 * deafen silences its target to everyone, while a deafened viewer hears nobody.
 */
export function callGateFor(
  folded: FoldedControl | undefined,
  channelIdHex: string,
  isPrivate: boolean,
  timeouts: ReadonlyMap<string, FoldedTimeout>,
  present: readonly { author: string; serverMuted?: boolean; serverDeafened?: boolean }[],
  viewer: string | undefined,
  nowMs: number,
): (pubkey: string) => CallAllowance {
  const silenced = new Set(present.filter((p) => p.serverMuted || p.serverDeafened).map((p) => p.author));
  const deafened = viewer !== undefined && present.some((p) => p.author === viewer && p.serverDeafened);
  return (pk) => {
    if (!mayConnect(folded, channelIdHex, isPrivate, pk)) return { speak: false, video: false, connect: false };
    const a = callAllowance(folded, channelIdHex, isPrivate, pk, timeouts, nowMs);
    return deafened || silenced.has(pk) ? { ...a, speak: false } : a;
  };
}

/** The live call's gate, by pubkey; absent outside a Concord call. */
let gate: ((pubkey: string) => CallAllowance) | undefined;
let version = 0;
const listeners = new Set<() => void>();

export function setCallGate(next: ((pubkey: string) => CallAllowance) | undefined): void {
  gate = next;
  version++;
  for (const l of listeners) l();
}

/** Bumped on every gate change, for a `useSyncExternalStore` snapshot. */
export function callGateVersion(): number {
  return version;
}

export function subscribeCallGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether `pubkey` may be in the live call at all. */
export function callConnects(pubkey: string): boolean {
  return gate?.(pubkey).connect ?? true;
}

/** Whether `pubkey` is heard in the live call. */
export function callSpeaks(pubkey: string): boolean {
  return gate?.(pubkey).speak ?? true;
}

/** Whether a member holding PRIORITY_SPEAKER is talking in the live call now. */
let prioritySpeaking = false;

export function setPrioritySpeaking(next: boolean): void {
  if (next === prioritySpeaking) return;
  prioritySpeaking = next;
  version++;
  for (const l of listeners) l();
}

/** Whether `pubkey` holds PRIORITY_SPEAKER in the live call. */
export function callPriority(pubkey: string): boolean {
  return gate?.(pubkey).priority === true;
}

/** The gain `pubkey` plays at: silent when not heard, ducked under a talking priority speaker unless one too. */
export function callGain(pubkey: string): number {
  if (!callSpeaks(pubkey)) return 0;
  return prioritySpeaking && !callPriority(pubkey) ? DUCK_GAIN : 1;
}

/** Whether `pubkey`'s camera or screen is shown in the live call. */
export function callShows(pubkey: string): boolean {
  return gate?.(pubkey).video ?? true;
}
