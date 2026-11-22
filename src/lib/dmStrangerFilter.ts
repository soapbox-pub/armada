import { LINK_TOKEN_PATTERN } from "@/lib/linkPattern";
import { KIND_DM_CHAT } from "@/lib/nip17/protocol";

const LINK_RE = new RegExp(LINK_TOKEN_PATTERN, "i");

/** Whether message text carries a link, read the way the message renderer reads one. */
export function containsLink(content: string): boolean {
  return LINK_RE.test(content);
}

/** The first message of a conversation: who wrote it, and whether it was a link. */
export interface DmOpener {
  author: string;
  /** A chat message with a link; a file message's content is its URL and never counts. */
  link: boolean;
}

export function dmOpenerOf(rumor: { author: string; kind: number; content: string }): DmOpener {
  return { author: rumor.author, link: rumor.kind === KIND_DM_CHAT && containsLink(rumor.content) };
}

/** What the filter needs besides the conversation; absent while memberships load. */
export interface StrangerFilterPolicy {
  /** Everyone sharing a community with the viewer. */
  communityPeers: ReadonlySet<string>;
  /** `AppConfig.blockNonMemberDms`. */
  blockNonMembers: boolean;
}

/**
 * Whether a REQUEST-tier conversation (no participant followed, accepted, pinned or
 * written to) is dropped without a trace: its opener shares no community with the
 * viewer and either opened with a link or the viewer blocks all non-members. Known
 * conversations never reach this, so it cannot hide anyone the viewer trusts.
 */
export function strangerDmFiltered(
  opener: DmOpener | undefined,
  policy: StrangerFilterPolicy | undefined,
): boolean {
  if (!opener || !policy) return false;
  if (policy.communityPeers.has(opener.author)) return false;
  return policy.blockNonMembers || opener.link;
}
