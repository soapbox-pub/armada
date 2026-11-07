import {
  isAuthorized,
  Permissions,
  type CommunityRoles,
} from "@/concord/lib/roles";

/**
 * Concord reserves MENTION_EVERYONE as a permission bit but defines no Chat Plane
 * tag, so clients use the literal lowercase `@everyone` token (interop with
 * existing clients), authorized server-wide as Vector's `is_authorized` is. Never matches
 * inside a word/email or a longer handle like `@everyone_else`.
 */
export const EVERYONE_MENTION_PATTERN = /(^|[^\p{L}\p{N}_@])@everyone(?![\p{L}\p{N}_])/u;

export function hasEveryoneMention(content: string): boolean {
  return EVERYONE_MENTION_PATTERN.test(content);
}

/**
 * Whether `author` may issue a mass mention: the owner, or MENTION_EVERYONE among
 * `@everyone`'s bits and every Role held. The bit is not overwritable, so it holds
 * in every channel (`channelIdHex` is kept for callers that judge per channel).
 */
export function canMentionEveryone(
  roles: CommunityRoles,
  ownerHex: string | undefined,
  author: string,
  _channelIdHex?: string,
): boolean {
  return isAuthorized(roles, author, ownerHex, Permissions.MENTION_EVERYONE);
}

/** Whether `@everyone` itself holds MENTION_EVERYONE, so any member's mass mention counts. */
export function everyoneMayMention(roles: CommunityRoles): boolean {
  return roles.everyone !== undefined && (roles.everyone & Permissions.MENTION_EVERYONE) !== 0n;
}

/** A literal mass mention whose author is authorized in its channel. */
export function isEveryoneMention(
  content: string,
  roles: CommunityRoles,
  ownerHex: string | undefined,
  author: string,
  channelIdHex: string,
): boolean {
  return hasEveryoneMention(content)
    && canMentionEveryone(roles, ownerHex, author, channelIdHex);
}

/**
 * Authors worth scanning for literal mass mentions across these channels.
 * The owner is implicit in the role graph; everyone else comes from Grants.
 */
export function everyoneMentionAuthors(
  roles: CommunityRoles,
  ownerHex: string | undefined,
  channelIdsHex: readonly string[],
): string[] {
  const candidates = new Set<string>();
  if (ownerHex) candidates.add(ownerHex);
  for (const grant of roles.grants) candidates.add(grant.member);
  return [...candidates]
    .filter((author) =>
      channelIdsHex.some((channelIdHex) =>
        canMentionEveryone(roles, ownerHex, author, channelIdHex),
      ),
    )
    .sort();
}
