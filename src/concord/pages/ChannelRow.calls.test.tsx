/** Which Channel rows offer a call: on ranked roles only a voice Channel does (Vector), unless one is running. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Channel, Community } from "@/concord/lib/types";

const presence = vi.hoisted(() => ({ value: { present: [] as unknown[], claims: [], otherTransport: [] } }));
const spies = vi.hoisted(() => ({
  useVoiceBroker: vi.fn(),
  useVoicePresence: vi.fn(),
}));

vi.mock("@/concord/hooks/useVoice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/concord/hooks/useVoice")>();
  return {
    ...actual,
    useVoiceBroker: (channel?: Channel, brokers?: string[]) => {
      spies.useVoiceBroker(channel, brokers);
      return { data: undefined, isLoading: false };
    },
    useVoicePresence: (community?: Community, channel?: Channel) => {
      spies.useVoicePresence(community, channel);
      return presence.value;
    },
  };
});
vi.mock("@/hooks/useVoiceActivity", () => ({
  useVoiceActivity: () => ({
    voiceRoomPubkeys: undefined,
    speakingPubkeys: new Set<string>(),
    mutedPubkeys: new Set<string>(),
  }),
}));
vi.mock("@/hooks/useMutes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useMutes")>();
  return {
    ...actual,
    useMutes: () => ({ isConcordChannelMuted: () => false }),
  };
});
vi.mock("@/hooks/useNotifLevels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useNotifLevels")>();
  return {
    ...actual,
    useNotifLevels: () => ({ concordChannelLevel: () => "all", setLevel: () => {} }),
  };
});

vi.mock("@/concord/hooks/useVoiceActions", async (orig) => ({ ...(await orig<typeof import("@/concord/hooks/useVoiceActions")>()), useVoiceActionsFor: () => undefined }));
vi.mock("@nostrify/react", async (orig) => ({ ...(await orig<typeof import("@nostrify/react")>()), useNostr: () => ({ nostr: {} }) }));

import { ChannelRow } from "@/concord/pages/ConcordPage";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

const community = { idHex: "c0ffee", relays: [], name: "Test" } as unknown as Community;

function channel(i: number): Channel {
  return {
    idHex: `chan${i}`,
    name: `channel-${i}`,
    isPrivate: false,
  } as unknown as Channel;
}

const row = (view: string | undefined, voiceOnlyCalls: boolean) =>
  render(
    <ChannelRow
      community={community}
      channel={{ ...channel(1), ...(view ? { view } : {}) } as Channel}
      active={false}
      inCall={false}
      onSelect={() => {}}
      onJoinVoice={() => {}}
      voiceOnlyCalls={voiceOnlyCalls}
    />,
    { wrapper },
  );
const callButton = () => screen.queryByRole("button", { name: /Start call|Join call/ });

afterEach(() => {
  cleanup();
  presence.value = { present: [], claims: [], otherTransport: [] };
});

describe("the call button on a Channel row", () => {
  it("shows on no idle row on ranked roles, voice included: a voice Channel joins on click", () => {
    row(undefined, true);
    expect(callButton()).toBeNull();
    cleanup();
    row("voice", true);
    expect(callButton()).toBeNull();
  });

  it("still shows on a legacy text Channel, never on a forum", () => {
    row(undefined, false);
    expect(callButton()).not.toBeNull();
    cleanup();
    row("forum", false);
    expect(callButton()).toBeNull();
  });
});
