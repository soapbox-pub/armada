import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Community } from "@/concord/lib/types";
import { VoiceRelaysSection, VoiceServersSection } from "./CommunitySettingsView";

const h = vi.hoisted(() => ({ updateMetadata: vi.fn(async () => undefined), probed: [] as string[] }));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/concord/hooks/useRoles", () => ({ useMetadataActions: () => ({ updateMetadata: h.updateMetadata }) }));
vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));
vi.mock("@/concord/lib/irohVoice", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/irohVoice")>()),
  probeVoiceRelay: async (url: string) => {
    h.probed.push(url);
    return true;
  },
}));

const community = { idHex: "community" } as Community;

function mount(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("a Community's call servers say what they are", () => {
  beforeEach(() => {
    h.updateMetadata.mockClear();
    h.probed = [];
  });

  it("heads the voice servers with LiveKit's mark and the relays with iroh's", () => {
    mount(
      <>
        <VoiceServersSection community={community} brokers={["https://voice.example"]} canManage={false} />
        <VoiceRelaysSection community={community} relays={["https://relay.example"]} canManage={false} />
      </>,
    );
    expect(screen.getByRole("img", { name: "LiveKit" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "iroh" })).toBeInTheDocument();
    expect(screen.getByText(/on a LiveKit server/)).toBeInTheDocument();
    expect(screen.getByText(/to each other over iroh/)).toBeInTheDocument();
  });

  it("probes a typed relay and saves it as voice_relays in origin form", async () => {
    mount(<VoiceRelaysSection community={community} relays={[]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit peer-to-peer relays" }));
    fireEvent.change(screen.getByPlaceholderText("https://relay.example.com"), { target: { value: "Relay.Example.com" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add peer-to-peer relay" }));
    });
    expect(h.probed).toEqual(["https://relay.example.com"]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save peer-to-peer relays" }));
    });
    expect(h.updateMetadata).toHaveBeenCalledWith({ voice_relays: ["https://relay.example.com"] });
  });
});
