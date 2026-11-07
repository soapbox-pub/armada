/**
 * Role mentions (CORD-03 §3, CORD-04 §8): a `["role", "<role_id>"]` tag beside text
 * naming the Role as `@` and its current name. Vector's `community/mentions.rs`.
 */

import { isAuthorized, Permissions, rolesOf, type CommunityRoles } from "@/concord/lib/roles";

/** The most Role tags a message carries; a reader takes the first this many distinct ones. */
export const MAX_ROLE_MENTIONS = 16;

const ROLE_ID = /^[0-9a-f]{64}$/;

/** The Roles a rumor mentions: 64 lowercase hex characters, once each, in tag order, capped. */
export function roleMentionIds(tags: readonly string[][]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    if (t.length < 2 || t[0] !== "role" || !ROLE_ID.test(t[1])) continue;
    if (out.length === MAX_ROLE_MENTIONS) break;
    if (!out.includes(t[1])) out.push(t[1]);
  }
  return out;
}

/** A message's Role tags: each picked Role whose `@Name` is still in the text, at most 16 (CORD-03 §3). */
export function roleMentionTags(
  text: string,
  roles: readonly { id: string; name: string }[],
  picked: ReadonlySet<string>,
): string[][] {
  const out: string[][] = [];
  for (const role of roles) {
    if (out.length === MAX_ROLE_MENTIONS) break;
    if (picked.has(role.id) && text.includes(`@${role.name}`)) out.push(["role", role.id]);
  }
  return out;
}

/** A Role the reader holds, as a mention of it is judged: its current name, and whether any author may ping it. */
export interface HeldRoleMention {
  id: string;
  name: string;
  /** `mentionable`, or `@everyone` holds MENTION_EVERYONE. */
  anyone: boolean;
}

/** The standing Roles `reader` holds, for {@link rolePings}. */
export function heldRoleMentions(roles: CommunityRoles, reader: string): HeldRoleMention[] {
  const everyone = ((roles.everyone ?? 0n) & Permissions.MENTION_EVERYONE) !== 0n;
  return rolesOf(roles, reader).map((r) => ({ id: r.roleId, name: r.name, anyone: everyone || r.mentionable === true }));
}

/** The Roles `author` may ping: mentionable ones, or every Role when they hold MENTION_EVERYONE server-wide. */
export function pingableRoles(roles: CommunityRoles, author: string, ownerHex: string | undefined): { id: string; name: string }[] {
  const any = isAuthorized(roles, author, ownerHex, Permissions.MENTION_EVERYONE);
  return roles.roles.filter((r) => any || r.mentionable === true).map((r) => ({ id: r.roleId, name: r.name }));
}

/** Who may mention a Role that isn't `mentionable`: MENTION_EVERYONE server-wide, the owner always. */
export function roleMentionAuthors(roles: CommunityRoles, ownerHex: string | undefined): string[] {
  const out = new Set<string>();
  if (ownerHex) out.add(ownerHex);
  for (const g of roles.grants) {
    if (isAuthorized(roles, g.member, ownerHex, Permissions.MENTION_EVERYONE)) out.add(g.member);
  }
  return [...out].sort();
}

/**
 * Whether a message's Role mentions ping a reader holding `held`: one names a Role
 * they hold in its tags and, byte for byte as `@Name`, in its text, and the Role is
 * mentionable or its author may mention any Role. A banned author is the caller's to drop.
 */
export function rolePings(
  content: string,
  tags: readonly string[][],
  held: readonly HeldRoleMention[],
  authorMentionsAny: boolean,
): boolean {
  if (held.length === 0) return false;
  return roleMentionIds(tags).some((id) => {
    const role = held.find((r) => r.id === id);
    return role !== undefined && content.includes(`@${role.name}`) && (role.anyone || authorMentionsAny);
  });
}
