/**
 * NIP-46 `perms` asked for in a `nostrconnect://` URI: the event kinds Armada
 * signs in normal use, so a signer can grant them once at connect instead of
 * prompting per kind.
 */
const SIGNED_KINDS = [
  0, // profile
  3, // follows
  5, // deletions
  7, // reactions
  13, // NIP-17 seals
  20013, // Concord seals: messages, Joins
  20014, // Concord control editions
  22242, // NIP-42 relay auth
  24242, // Blossom upload auth
  27235, // NIP-98 HTTP auth
  30078, // app settings
  33302, // Concord membership list
  10002, // relay list
  10050, // DM relays
  10009, // server list
];

export const NOSTR_CONNECT_PERMS = [
  "nip44_encrypt",
  "nip44_decrypt",
  "nip04_encrypt",
  "nip04_decrypt",
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
