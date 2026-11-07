/** What a Concord reaction may say, shared by the timeline and every notifier. */

/**
 * Whether a reaction's content is one a row can show (Vector `is_renderable_reaction`):
 * a like or dislike, a clean `:shortcode:` of at most 48 bytes, or a single token of at
 * most 12 characters with no URL in it.
 */
export function isRenderableReaction(content: string): boolean {
  if (content === "" || content === "+" || content === "-") return true;
  const code = /^:(.+):$/.exec(content)?.[1];
  if (code !== undefined && code.length <= 48 && /^[A-Za-z0-9_~+-]+$/.test(code)) return true;
  return [...content].length <= 12 && !/\p{White_Space}/u.test(content) && !content.includes("://");
}
