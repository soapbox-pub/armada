/**
 * A link token as the message renderer reads one: a scheme URL, or a bare
 * `domain.tld/path`. Repetitions are BOUNDED (DNS limits) to keep the scan linear
 * on attacker-controlled content. `<`, `>`, `|` and `"` are never literal in a URL
 * (RFC 3986), so `<https://…>`, `||https://…||` and a quoted URL end at them.
 * Use with the `i` flag. No capture groups, so it can sit inside a larger alternation.
 */
export const LINK_TOKEN_PATTERN =
  "(?:(?:https?|wss?):\\/\\/|(?:[\\w-]{1,63}\\.){1,10}[a-z]{2,24}\\/)[^\\s<>|\"]+";
