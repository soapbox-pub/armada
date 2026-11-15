import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ consent: "unset" as string, needsApproval: true }));
vi.mock("@/lib/decryptConsent", () => ({ getDecryptConsent: () => h.consent }));
vi.mock("@/lib/bulkDecryptGate", () => ({ signerNeedsApproval: () => h.needsApproval }));
vi.mock("@/concord/lib/inviteRelays", () => ({
  recipientInboxRelays: async () => ["wss://inbox.test"],
  inviteDeliveryRelays: (relays: string[]) => relays,
}));

import { sweepInviteInbox } from "@/concord/hooks/useDirectInvites";

const user = { pubkey: "a".repeat(64), method: "nip55", signer: { nip44: {} } } as never;

describe("sweepInviteInbox()", () => {
  beforeEach(() => {
    h.consent = "unset";
    h.needsApproval = true;
  });

  it("asks no relay while the signer needs approval and none was given", async () => {
    const query = vi.fn(async () => []);
    const nostr = { relay: () => ({ query }) } as never;
    expect(await sweepInviteInbox(nostr, user)).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it("scans once consent is given", async () => {
    h.consent = "allowed";
    const query = vi.fn(async () => []);
    const nostr = { relay: () => ({ query }) } as never;
    await sweepInviteInbox(nostr, user);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("scans the joined Communities' relays too, where a role change's catch-up is sent (Vector `settle_access`)", async () => {
    h.consent = "allowed";
    const asked: string[] = [];
    const nostr = { relay: (url: string) => ({ query: async () => {
      asked.push(url);
      return [];
    } }) } as never;
    await sweepInviteInbox(nostr, user, undefined, ["wss://community.test", "wss://inbox.test"]);
    expect(asked.sort()).toEqual(["wss://community.test", "wss://inbox.test"]);
  });
});
