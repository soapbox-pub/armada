/**
 * What a member may write at a restricted Channel's writer address (CORD-03 §1, Vector
 * `Rights`): everything, with Send Messages, or, in a Locked Channel, only reactions and
 * calls by their own bits and deletions, on a scoped certificate.
 */
import type { FoldedControl } from "@/concord/lib/control";
import { channelPermissions, everyoneLocked, Permissions } from "@/concord/lib/roles";
import { SCOPED_BITS, writerBit } from "@/concord/lib/writers";

/** `"full"`: every write. A bigint: only the writes those CORD-04 bits name, and deletions. */
export type Rights = "full" | bigint;

/** Whether `a` holds every write `b` does. */
export function rightsCover(a: Rights, b: Rights): boolean {
  if (a === "full") return true;
  if (b === "full") return false;
  return (a & b) === b;
}

/** Both rights at once: what either covers. */
export function widenRights(a: Rights | undefined, b: Rights): Rights {
  if (a === undefined) return b;
  return a === "full" || b === "full" ? "full" : a | b;
}

/** Whether a Roster locks a Channel: `@everyone` may write nothing there (Vector `locks`). */
export function locksChannel(control: FoldedControl, channelIdHex: string): boolean {
  return everyoneLocked(control.roster, channelIdHex);
}

/**
 * What `member` may write in a Channel by `control` when it is `locked` (Vector `rights_of`):
 * everything with Send; in a Locked Channel reactions and calls by their own bits, and a
 * moderator's deletions. Undefined for nothing.
 */
export function rightsOf(control: FoldedControl, member: string, channelIdHex: string, locked: boolean): Rights | undefined {
  const isPrivate = control.channels.get(channelIdHex)?.isPrivate ?? false;
  const p = channelPermissions(control.roster, control.ownerHex, member, channelIdHex, isPrivate);
  if ((p & Permissions.SEND_MESSAGES) !== 0n) return "full";
  const bits = p & SCOPED_BITS;
  return locked && (bits !== 0n || (p & Permissions.MANAGE_MESSAGES) !== 0n) ? bits : undefined;
}

/** Whether `member` may send a write of `kind` in a Channel (Vector `may_send_kind`). */
export function maySendKind(control: FoldedControl, member: string, channelIdHex: string, kind: number): boolean {
  const bit = writerBit(kind);
  if (bit === undefined) return rightsOf(control, member, channelIdHex, true) !== undefined;
  const isPrivate = control.channels.get(channelIdHex)?.isPrivate ?? false;
  return (channelPermissions(control.roster, control.ownerHex, member, channelIdHex, isPrivate) & bit) !== 0n;
}
