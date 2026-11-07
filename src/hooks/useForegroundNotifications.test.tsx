/**
 * The foreground notifier holds a candidate dated ahead and judges it once it
 * comes due, as if it arrived then (CORD-03 §3). The in-page sound is the cue
 * observed: it fires once a candidate clears every gate, with no OS permission.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NotifyCandidate } from "@/wire/notify";

import { useForegroundNotifications } from "./useForegroundNotifications";

const h = vi.hoisted(() => ({
  sink: undefined as ((c: NotifyCandidate[]) => void) | undefined,
  sounds: 0,
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { automaticSettingsSync: false, pushPrefs: { dmRequests: "full" } } }),
}));
vi.mock("@/lib/notificationSettingsAuthority", () => ({
  useNotificationSettingsReady: () => true,
  notificationPolicyIsAuthoritative: () => true,
}));
vi.mock("@/hooks/useEventStore", () => ({ useEventStore: () => undefined }));
vi.mock("@/hooks/useReadState", async (orig) => ({
  ...(await orig<typeof import("@/hooks/useReadState")>()),
  useReadState: () => ({ readState: {} }),
}));
vi.mock("@/hooks/useNotifLevels", () => ({
  useNotifLevels: () => ({ channelLevel: () => "all", concordChannelLevel: () => "all", dmLevel: () => "all" }),
}));
vi.mock("@/hooks/useKnownDmPeers", () => ({ useKnownDmPeers: () => ({ isKnown: () => true, knownConversationKeys: [] }) }));
vi.mock("@/hooks/useUserGroupList", () => ({ useUserGroupList: () => ({ data: undefined }) }));
vi.mock("@/hooks/useMuteList", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: new Set() }) }));
vi.mock("@/hooks/useMediaPolicy", () => ({ useMediaPolicy: () => ({}) }));
vi.mock("@/hooks/useBlossomServers", () => ({ useBlossomServers: () => [] }));
vi.mock("@/wire/useWireNip29Groups", () => ({ useWireNip29Groups: () => [] }));
vi.mock("@/concord/hooks/useCommunityList", () => ({ useCommunityList: () => ({ data: undefined }) }));
vi.mock("@/hooks/useForegroundNotificationSettings", () => ({ isForegroundNotifyReady: () => false }));
vi.mock("@/lib/nip17/dm17Store", () => ({ queryDm17Conversations: async () => [] }));
vi.mock("@/lib/notificationSounds", () => ({
  loadNotificationSoundSettings: () => ({ enabled: true }),
  playNotificationSound: () => {
    h.sounds += 1;
  },
}));
vi.mock("@/wire/notify", async (orig) => ({
  ...(await orig<typeof import("@/wire/notify")>()),
  registerNotifySink: (next: (c: NotifyCandidate[]) => void) => {
    h.sink = next;
    return () => {
      h.sink = undefined;
    };
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    </MemoryRouter>
  );
}

const NOW = 1_800_000_000_000;

function candidate(createdAt: number, eventId: string): NotifyCandidate {
  return {
    plane: "nip29",
    author: "b".repeat(64),
    createdAt,
    mention: false,
    kind: 9,
    content: "hi",
    roomKey: "",
    readKey: "",
    path: "",
    relayUrl: "wss://relay.test",
    groupId: "g",
    eventId,
  };
}

describe("useForegroundNotifications: a candidate dated ahead (CORD-03 §3)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    h.sounds = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("waits until it is due, then notifies once", async () => {
    renderHook(() => useForegroundNotifications(), { wrapper });
    expect(h.sink).toBeDefined();
    act(() => h.sink!([candidate(NOW / 1000 + 30, "e".repeat(64))]));
    expect(h.sounds).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(24_000);
    });
    expect(h.sounds).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(h.sounds).toBe(1);
    // It re-arriving while held or after doesn't notify twice.
    act(() => h.sink!([candidate(NOW / 1000 + 30, "e".repeat(64))]));
    expect(h.sounds).toBe(1);
  });

  it("doesn't hold one dated more than an hour ahead", async () => {
    renderHook(() => useForegroundNotifications(), { wrapper });
    act(() => h.sink!([candidate(NOW / 1000 + 3_700, "f".repeat(64))]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_700_000);
    });
    expect(h.sounds).toBe(0);
  });
});
