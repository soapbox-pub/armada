/**
 * NIP-46 `perms` asked for in a `nostrconnect://` URI, so a signer can grant
 * them once at connect instead of prompting per kind. Only what Armada signs or
 * decrypts per message, plus the Concord kinds a signer's basic policy doesn't
 * know: every entry grows the login QR, and the rest are rare enough to approve
 * when they come up.
 */
const SIGNED_KINDS = [
  13, // NIP-17 seals
  20013, // Concord seals: messages, Joins
  20014, // Concord control editions
  22242, // NIP-42 relay auth
  33302, // Concord membership list
];

export const NOSTR_CONNECT_PERMS = [
  "nip44_encrypt",
  "nip44_decrypt",
  ...SIGNED_KINDS.map((k) => `sign_event:${k}`),
].join(",");

/**
 * `uri` with Armada's requested permissions appended. Left unescaped: `,` and
 * `:` are legal in a query (RFC 3986) and decode the same, while escaping
 * them makes the login QR markedly denser.
 */
export function withConnectPerms(uri: string): string {
  return `${uri}${uri.includes("?") ? "&" : "?"}perms=${NOSTR_CONNECT_PERMS}`;
}
