import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ missing: true }));

vi.mock("@/hooks/useDmInboxSetup", () => ({
  recommendedDmInbox: () => [],
  useDmInboxSetup: () => ({ missing: h.missing, dismissed: true, publishing: false, publish: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({
    config: {
      useAppRelays: true,
      useUserRelays: false,
      appRelays: ["wss://app.example"],
      dmRelays: [],
      searchRelays: [],
      communityRelays: [],
      broadcastRelays: [],
      relayMetadata: { relays: [], updatedAt: 0 },
      blossomServerMetadata: { servers: [], updatedAt: 0 },
    },
    updateConfig: vi.fn(),
  }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }) }));
vi.mock("@/hooks/useDmRelayList", () => ({ useDmRelayList: () => ({ publish: vi.fn() }) }));
vi.mock("@/hooks/useBlossomServerList", () => ({ useBlossomServerList: () => ({ publish: vi.fn() }) }));
vi.mock("@/hooks/useSearchRelayList", () => ({ useSearchRelayList: () => ({ publish: vi.fn() }) }));
vi.mock("@/components/RelayListEditor", () => ({ RelayListEditor: () => null }));
vi.mock("@/components/BlossomServerListEditor", () => ({ BlossomServerListEditor: () => null }));
vi.mock("@/components/RelayBootstrapForm", () => ({ RelayBootstrapForm: () => null }));
vi.mock("@/components/RelayLed", () => ({ RelayLed: () => null, BlossomLed: () => null, StatusLed: () => null, SLOW_MS: 1000 }));

import { RelaysSettings } from "@/components/settings/RelaysSettings";

const BODY = "People using other Nostr apps can't message you yet.";

beforeEach(() => {
  h.missing = true;
});

describe("RelaysSettings DM inbox setup", () => {
  it("opens Messages with the setup in view while the account has no kind 10050", () => {
    render(<RelaysSettings />);
    expect(screen.getByText(BODY)).toBeInTheDocument();
  });

  it("stays closed once the user closes it", () => {
    render(<RelaysSettings />);
    fireEvent.click(screen.getByRole("button", { name: /Messages/ }));
    expect(screen.queryByText(BODY)).toBeNull();
  });

  it("opens the list the user picks instead", () => {
    render(<RelaysSettings />);
    fireEvent.click(screen.getByRole("button", { name: /Search/ }));
    expect(screen.queryByText(BODY)).toBeNull();
  });

  it("starts with every list closed when the inbox is set up", () => {
    h.missing = false;
    render(<RelaysSettings />);
    expect(screen.queryByText(BODY)).toBeNull();
    expect(screen.queryByText(/Other apps deliver your direct messages here\. Armada/)).toBeNull();
  });
});
