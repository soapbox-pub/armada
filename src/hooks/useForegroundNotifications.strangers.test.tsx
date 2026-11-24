/**
 * The foreground notifier and the DM stranger filter: a stranger's DM is judged
 * on the conversation's stored messages plus itself, once the community
 * memberships are in hand (or a bounded wait has passed). The in-page sound is
 * the cue observed.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DmScreen, StrangerFilterPolicy } from "@/lib/dmStrangerFilter";
import type { NotifyCandidate } from "@/wire/notify";

import { useForegroundNotifications } from "./useForegroundNotifications";

const h = vi.hoisted(() => ({
  sink: undefined as ((c: NotifyCandidate[]) => void) | undefined,
  sounds: 0,
  policy: undefined as StrangerFilterPolicy | undefined,
  stored: new Map<string, DmScreen>(),
  dmRequests: "full" as "off" | "generic" | "full",
}));

vi.mock("@nostrify/react", () => ({ useNostr: () => ({ nostr: {} }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }) }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: { automaticSettingsSync: false, pushPrefs: { dmRequests: h.dmRequests } } }),
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
vi.mock("@/hooks/useKnownDmPeers", () => ({ useKnownDmPeers: () => ({ isKnown: () => false, knownConversationKeys: [] }) }));
vi.mock("@/hooks/useDmStrangerFilter", () => ({ useStrangerFilterPolicy: () => h.policy }));
vi.mock("@/hooks/useUserGroupList", () => ({ useUserGroupList: () => ({ data: undefined }) }));
vi.mock("@/hooks/useMuteList", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: new Set() }) }));
vi.mock("@/hooks/useMediaPolicy", () => ({ useMediaPolicy: () => ({}) }));
vi.mock("@/hooks/useBlossomServers", () => ({ useBlossomServers: () => [] }));
vi.mock("@/wire/useWireNip29Groups", () => ({ useWireNip29Groups: () => [] }));
vi.mock("@/concord/hooks/useCommunityList", () => ({ useCommunityList: () => ({ data: undefined }) }));
vi.mock("@/hooks/useForegroundNotificationSettings", () => ({ isForegroundNotifyReady: () => false }));
vi.mock("@/lib/nip17/dm17Store", () => {
  const read = new Map<string, DmScreen>();
  return {
    queryDm17Conversations: async () => [],
    queryDm17Screen: async (_self: string, peers: string[]) => {
      const screen = h.stored.get(peers.join(",")) ?? { authors: [], linkAuthors: [] };
      read.set(peers.join(","), screen);
      return screen;
    },
    peekDm17Screen: (_self: string, conversation: string) => read.get(conversation),
  };
});
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
let seq = 0;

function dm(stranger: string, content: string): NotifyCandidate {
  seq += 1;
  return {
    plane: "dm",
    author: stranger,
    createdAt: NOW / 1000 + 1,
    mention: true,
    kind: 14,
    content,
    roomKey: "",
    readKey: "",
    path: "",
    peer: stranger,
    eventId: seq.toString(16).padStart(64, "0"),
  };
}

const settle = () => act(async () => {
  await vi.advanceTimersByTimeAsync(10);
});

describe("useForegroundNotifications: the DM stranger filter", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
    h.sounds = 0;
    h.policy = { communityPeers: new Set(["c".repeat(64)]), blockNonMembers: false };
    h.stored.clear();
    h.dmRequests = "full";
  });
  afterEach(() => vi.useRealTimers());

  it("raises nothing for a non-member's link, and a request for a plain message", async () => {
    renderHook(() => useForegroundNotifications(), { wrapper });
    act(() => h.sink!([dm("d".repeat(64), "claim at spam.example/now")]));
    await settle();
    expect(h.sounds).toBe(0);
    act(() => h.sink!([dm("e".repeat(64), "hi, we met at the meetup")]));
    await settle();
    expect(h.sounds).toBe(1);
  });

  it("stays silent for a conversation that carried a link before", async () => {
    const stranger = "d".repeat(64);
    h.stored.set(stranger, { authors: [stranger], linkAuthors: [stranger] });
    renderHook(() => useForegroundNotifications(), { wrapper });
    act(() => h.sink!([dm(stranger, "hello?")]));
    await settle();
    expect(h.sounds).toBe(0);
  });

  it("lets a community member's link through", async () => {
    renderHook(() => useForegroundNotifications(), { wrapper });
    act(() => h.sink!([dm("c".repeat(64), "agenda: https://docs.example/a")]));
    await settle();
    expect(h.sounds).toBe(1);
  });

  it("waits for the memberships rather than notifying without them", async () => {
    h.policy = undefined;
    const view = renderHook(() => useForegroundNotifications(), { wrapper });
    act(() => h.sink!([dm("d".repeat(64), "https://spam.example/x")]));
    await settle();
    expect(h.sounds).toBe(0);
    h.policy = { communityPeers: new Set(), blockNonMembers: false };
    view.rerender();
    await settle();
    expect(h.sounds).toBe(0);
  });

  it("notifies a plain request once the wait for memberships runs out", async () => {
    h.policy = undefined;
    renderHook(() => useForegroundNotifications(), { wrapper });
    act(() => h.sink!([dm("d".repeat(64), "hi")]));
    await settle();
    expect(h.sounds).toBe(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(h.sounds).toBe(1);
  });

  it.each(["generic", "off"] as const)("raises nothing for a stranger's message under `%s`", async (level) => {
    h.dmRequests = level;
    renderHook(() => useForegroundNotifications(), { wrapper });
    act(() => h.sink!([dm("e".repeat(64), "hi, we met at the meetup")]));
    await settle();
    expect(h.sounds).toBe(0);
  });
});
