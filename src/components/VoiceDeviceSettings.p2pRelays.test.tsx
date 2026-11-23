import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VoiceDeviceSettings } from "@/components/VoiceDeviceSettings";

const h = vi.hoisted(() => ({ relays: undefined as string[] | undefined }));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { preferredVoiceServer: "" }, updateConfig: vi.fn() }),
}));
vi.mock("@/concord/hooks/useVoice", () => ({ ownAvServers: () => [] }));
vi.mock("@/concord/lib/voice", () => ({ probeAvBroker: async () => false }));
vi.mock("@/concord/lib/irohVoice", () => ({ deploymentIrohRelays: async () => h.relays }));

function mount() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <VoiceDeviceSettings />
    </QueryClientProvider>,
  );
}

describe("Settings › Voice says which servers carry which calls", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { enumerateDevices: async () => [], addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
  });

  it("marks the voice server as LiveKit and lists this build's iroh relays", async () => {
    h.relays = ["https://euc1-1.relay.n0.iroh.link/"];
    mount();
    expect(screen.getByRole("img", { name: "LiveKit" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "iroh" })).toBeInTheDocument();
    expect(await screen.findByText("https://euc1-1.relay.n0.iroh.link/")).toBeInTheDocument();
  });

  it("says when the deployment set no relays, and when the build has no peer-to-peer calling", async () => {
    h.relays = [];
    const view = mount();
    expect(await screen.findByText(/start only in communities that set their own relays/)).toBeInTheDocument();
    view.unmount();
    h.relays = undefined;
    mount();
    expect(await screen.findByText(/built without peer-to-peer calling/)).toBeInTheDocument();
  });
});
