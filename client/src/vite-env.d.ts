/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME?: string;
  readonly VITE_PLATFORM_RELAYS?: string;
  readonly VITE_APP_RELAYS?: string;
  readonly VITE_SANDBOX_DOMAIN?: string;
  /** Hex pubkey of the shared nostr-push server (enables Android FCM push). */
  readonly VITE_NOSTR_PUSH_PUBKEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
