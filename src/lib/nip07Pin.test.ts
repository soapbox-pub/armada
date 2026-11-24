import { afterEach, describe, expect, it, vi } from "vitest";

import { NBrowserSignerBtc } from "@/lib/bitcoin-signers";

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

/** A NIP-07 provider acting as `pubkey`, tagging what it returns with it. */
function provider(pubkey: string) {
  return {
    getPublicKey: vi.fn(async () => pubkey),
    signEvent: vi.fn(async (event: object) => ({ ...event, id: "1".repeat(64), pubkey, sig: "2".repeat(128) })),
    nip44: {
      encrypt: vi.fn(async (_pk: string, text: string) => `${pubkey}:${text}`),
      decrypt: vi.fn(async (_pk: string, text: string) => `${pubkey}:${text}`),
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("NBrowserSignerBtc pinned to its login's account", () => {
  it("acts as the login's account through getSigner while Din's account is another", async () => {
    const getSigner = vi.fn(async (pk: string) => provider(pk));
    vi.stubGlobal("nostr", { ...provider(BOB), getSigner });
    const signer = new NBrowserSignerBtc({ pubkey: ALICE });

    expect(await signer.getPublicKey()).toBe(ALICE);
    const signed = await signer.signEvent({ kind: 1, content: "", tags: [], created_at: 0 });
    expect(signed.pubkey).toBe(ALICE);
    expect(await signer.nip44!.decrypt(BOB, "x")).toBe(`${ALICE}:x`);
    expect(getSigner).toHaveBeenCalledTimes(1);
    expect(getSigner).toHaveBeenCalledWith(ALICE);
  });

  it("falls back to the provider itself only when it is the login's account", async () => {
    const notHeld = async () => { throw new DOMException("not held", "NotFoundError"); };
    vi.stubGlobal("nostr", { ...provider(ALICE), getSigner: notHeld });
    const signer = new NBrowserSignerBtc({ pubkey: ALICE });
    expect((await signer.signEvent({ kind: 1, content: "", tags: [], created_at: 0 })).pubkey).toBe(ALICE);

    vi.stubGlobal("nostr", { ...provider(BOB), getSigner: notHeld });
    const other = new NBrowserSignerBtc({ pubkey: ALICE });
    await expect(other.signEvent({ kind: 1, content: "", tags: [], created_at: 0 }))
      .rejects.toMatchObject({ name: "NotFoundError" });
  });

  it("tries getSigner again after a refusal", async () => {
    const getSigner = vi.fn()
      .mockRejectedValueOnce(new DOMException("no", "NotAllowedError"))
      .mockImplementation(async (pk: string) => provider(pk));
    vi.stubGlobal("nostr", { ...provider(BOB), getSigner });
    const signer = new NBrowserSignerBtc({ pubkey: ALICE });

    await expect(signer.nip44!.decrypt(BOB, "x")).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(await signer.nip44!.decrypt(BOB, "x")).toBe(`${ALICE}:x`);
  });

  it("behaves as NBrowserSigner with a provider that has no getSigner", async () => {
    const plain = provider(BOB);
    vi.stubGlobal("nostr", plain);
    const signer = new NBrowserSignerBtc({ pubkey: ALICE });
    expect(await signer.getPublicKey()).toBe(BOB);
    expect(plain.getPublicKey).toHaveBeenCalled();
  });
});
