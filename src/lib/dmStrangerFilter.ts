import { LINK_TOKEN_PATTERN } from "@/lib/linkPattern";
import { KIND_DM_FILE } from "@/lib/nip17/protocol";

// The renderer's flags (`SEGMENT_RE`), so what counts is exactly what it would link.
const LINK_RE = new RegExp(LINK_TOKEN_PATTERN, "iu");

/** Whether message text carries a link, read the way the message renderer reads one. */
export function containsLink(content: string): boolean {
  return LINK_RE.test(content);
}

/**
 * What the filter knows about one conversation's stored messages: who wrote in it
 * (never the viewer) and which of them sent a message carrying a link. A file
 * message's content is its own URL, so it never counts as one.
 */
export interface DmScreen {
  authors: readonly string[];
  linkAuthors: readonly string[];
}

/**
 * Past this many stored messages a conversation's older ones are not read, and every
 * author in it is treated as having sent a link: no request legitimately runs that long
 * unanswered, and a flood must not push its first link out of the window.
 */
export const DM_SCREEN_WINDOW = 500;

export const EMPTY_DM_SCREEN: DmScreen = { authors: [], linkAuthors: [] };

export function dmScreenOf(
  messages: Iterable<{ author: string; kind: number; content: string }>,
  self: string,
  overflow = false,
): DmScreen {
  const authors = new Set<string>();
  const linkAuthors = new Set<string>();
  for (const { author, kind, content } of messages) {
    if (author === self) continue;
    authors.add(author);
    if (overflow || (kind !== KIND_DM_FILE && containsLink(content))) linkAuthors.add(author);
  }
  return { authors: [...authors].sort(), linkAuthors: [...linkAuthors].sort() };
}

/** Both screens' facts. Appending messages only ever adds to a screen. */
export function mergeDmScreens(a: DmScreen, b: DmScreen): DmScreen {
  if (b.authors.length === 0) return a;
  if (a.authors.length === 0) return b;
  return {
    authors: [...new Set([...a.authors, ...b.authors])].sort(),
    linkAuthors: [...new Set([...a.linkAuthors, ...b.linkAuthors])].sort(),
  };
}

/** What the filter needs besides the conversation; absent while memberships load. */
export interface StrangerFilterPolicy {
  /** Everyone sharing a Concord community with the viewer. */
  communityPeers: ReadonlySet<string>;
  /** `AppConfig.blockNonMemberDms`. */
  blockNonMembers: boolean;
}

/**
 * Whether a REQUEST-tier conversation (no participant followed, accepted, pinned or
 * written to) is filtered: someone outside the viewer's communities wrote in it, and
 * either sent a link or the viewer filters every non-member. Judged on every stored
 * message rather than the first, so neither a harmless opener nor a backdated one
 * slips a link past it. Callers only ask about request-tier conversations, so it
 * cannot hide anyone the viewer trusts.
 */
export function strangerDmFiltered(
  screen: DmScreen | undefined,
  policy: StrangerFilterPolicy | undefined,
): boolean {
  if (!screen || !policy) return false;
  const suspects = policy.blockNonMembers ? screen.authors : screen.linkAuthors;
  return suspects.some((author) => !policy.communityPeers.has(author));
}
