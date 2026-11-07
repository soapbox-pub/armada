import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Channel, Community } from "@/concord/lib/types";

/**
 * Effect-verification for the Concord channel sidebar's per-row mount cost.
 *
 * A Concord room ↔ DMs switch remounts the whole page (AppRouter has no
 * keepalive), so the channel sidebar mounts every `ChannelRow` synchronously in
 * one React commit. A CPU profile of that switch was dominated by TanStack
 * Query observer creation/subscription; each `ChannelRow` used to stand up a
 * `useVoiceBroker` query purely to pre-warm the join click, so N channels meant
 * N query observers created in that single commit — and the channel list is not
 * viewport-gated (its rows are drag-reorder targets measured out of the DOM),
 * so nothing bounded N.
 *
 * The broker is only ever consumed by the join handler, which already resolves
 * it lazily (`resolveVoiceBroker`) when the row hands it `null`. So the row need
 * not carry the query at all. This test pins that: the sidebar mounts ZERO
 * broker query observers, while STILL subscribing presence per row (the live
 * "someone's in a call here" indicator, which genuinely is per-channel and is
 * already coalesced to one REQ per relay under the hood).
 *
 * The data hooks are stubbed to counting spies so the assertion is about which
 * observers each row stands up, isolated from the query/relay stack.
 */

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
      return { present: [], claims: [], otherTransport: [] };
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

function renderSidebar(n: number, onJoinVoice = () => {}) {
  return render(
    <>
      {Array.from({ length: n }, (_, i) => (
        <ChannelRow
          key={i}
          community={community}
          channel={channel(i)}
          active={false}
          inCall={false}
          onSelect={() => {}}
          onJoinVoice={onJoinVoice}
        />
      ))}
    </>,
    { wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
});

describe("Concord channel sidebar per-row observers", () => {
  it("mounts NO broker query observers, however many channels", () => {
    const N = 200;
    renderSidebar(N);

    // The whole point: not one av-broker query is stood up on the sidebar's
    // synchronous mount, whatever the channel count.
    expect(spies.useVoiceBroker).not.toHaveBeenCalled();

    // Presence is still per-row — the live-call indicator is genuinely a
    // per-channel fact, and it is coalesced to one shared REQ per relay below
    // this seam — so it must NOT have been dropped by the same change.
    expect(spies.useVoicePresence).toHaveBeenCalledTimes(N);
  });

  it("defers broker resolution to the join handler (passes null)", () => {
    const onJoinVoice = vi.fn();
    renderSidebar(1, onJoinVoice);

    // The row no longer knows a broker, so the join button hands the handler
    // `null` and the handler resolves it live (resolveVoiceBroker).
    fireEvent.click(document.querySelector('[aria-label="Start call"]')!);
    expect(onJoinVoice).toHaveBeenCalledTimes(1);
    expect(onJoinVoice.mock.calls[0][1]).toBeNull();
  });
});
