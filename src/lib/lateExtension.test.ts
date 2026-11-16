/**
 * A NIP-07 extension injects `window.nostr` after the page boots (Keys.Band
 * does it at document_end), and until it does, Nostrify's browser signer claims
 * NIP-44 because it can't tell otherwise. The app's signer is built before
 * that, so it must ask what the extension lacks on every read, not once: copied
 * at construction, an extension with no NIP-44 kept looking capable, and every
 * pending-join retry failed on it.
 */

import { NBrowserSigner } from "@nostrify/nostrify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppSigner } from "@/lib/AppSigner";
import { signerWithNudge } from "@/lib/signerWithNudge";

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn(() => ({ id: "t", dismiss: vi.fn(), update: vi.fn() })) }));

const SELF = "ab".repeat(32);
const g = globalThis as { nostr?: unknown };

afterEach(() => {
  delete g.nostr;
});

function appSigner() {
  return signerWithNudge(new AppSigner(new NBrowserSigner(), SELF));
}

describe("a signer built before the extension injects", () => {
  it("stops claiming NIP-44 once an extension without it arrives", () => {
    const signer = appSigner();
    expect(signer.nip44).toBeDefined();

    g.nostr = { getPublicKey: async () => SELF, signEvent: async () => ({}), nip04: { encrypt: async () => "", decrypt: async () => "" } };

    expect(signer.nip44).toBeUndefined();
    expect(signer.nip04).toBeDefined();
  });

  it("keeps NIP-44 when the extension has it, and calls through to it", async () => {
    const signer = appSigner();
    const encrypt = vi.fn(async (_pk: string, plaintext: string) => `ct:${plaintext}`);
    g.nostr = { getPublicKey: async () => SELF, signEvent: async () => ({}), nip44: { encrypt, decrypt: async () => "" } };

    await expect(signer.nip44!.encrypt(SELF, "hi")).resolves.toBe("ct:hi");
    expect(encrypt).toHaveBeenCalledWith(SELF, "hi");
  });
});
