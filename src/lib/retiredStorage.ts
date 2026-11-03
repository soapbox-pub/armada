/**
 * Pre-ArmadaDB databases. Upgraded installs may still hold them (undrained, with
 * decrypted data), so logout keeps deleting them.
 */
export const RETIRED_DATABASES = [
  "armada-concord-cache",
  "armada-decrypt-cache",
  "armada-concord-invites",
  "armada-dm17-rumors",
  "armada-concord-rumors",
  "armada-events",
  "armada-relay-provenance",
  "armada-concord-pending",
];

/** The retired SQLite-WASM store's OPFS directory. */
export const RETIRED_OPFS_DIR = ".armada-sqlite";
