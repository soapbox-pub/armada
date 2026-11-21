// @vitest-environment jsdom
/**
 * Muting a whole Concord community on Android must stop its background
 * notifications. A mute reaches `concordSubs` only as an omission, and an
 * unready plane MERGES its snapshot into the stored subscriptions, so the
 * payload carries the level policy (`concordLevels`) for native to apply to the
 * entries a merge keeps. The native half is `NotificationLevelTest`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConcordSub } from "@/concord/lib/concordNotifications";
import { DEFAULT_PUSH_PREFS } from "@/lib/pushPrefs";

const SOAPBOX = "52".repeat(32);
const OTHER = "0a".repeat(32);
const ME = "ab".repeat(32);

const h = vi.hoisted(() => ({
  configure: vi.fn(async (_payload: Record<string, unknown>) => {}),
  config: {} as Record<string, unknown>,
  concord: { subs: [] as unknown[], ready: true, left: [] as string[] },
}));

vi.mock("@/lib/platform", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/platform")>()),
  hasNativeNotificationService: () => true,
}));

vi.mock("@/lib/nativeNotifications", () => ({
  ArmadaNotification: {
    configure: h.configure,
    checkPermission: async () => ({ granted: true }),
    // A same-account service already running from an earlier configure.
    getHealth: async () => ({
      serviceRunning: true,
      configEnabled: true,
      configRevision: 1,
      loadedConfigRevision: 1,
    }),
    addListener: async () => ({ remove: () => {} }),
    submitAuth: async () => {},
    openNotificationSettings: async () => {},
    requestPermission: async () => ({ granted: true }),
  },
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: ME } }),
}));
vi.mock("@/lib/notificationSettingsAuthority", () => ({
  useNotificationSettingsReady: () => true,
}));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config, updateConfig: () => {} }),
}));
vi.mock("@/contexts/AppContext", async (importActual) => ({
  ...(await importActual<typeof import("@/contexts/AppContext")>()),
  effectiveDmRelays: () => [],
  selfStateRelays: () => ["wss://self.example"],
}));
vi.mock("@/hooks/useUserGroupList", () => ({
  useUserGroupList: () => ({ data: { groups: [], servers: [], wireReady: true } }),
}));
vi.mock("@/hooks/useKnownDmPeers", () => ({
  useKnownDmPeers: () => ({
    knownPeers: [],
    knownConversationKeys: [],
    mutedPeers: [],
    configurationReady: true,
  }),
}));
vi.mock("@/hooks/useDmRelayList", () => ({
  useDmRelayList: () => ({ relays: [], isReady: true }),
}));
vi.mock("@/hooks/useMediaPolicy", () => ({ useMediaPolicyConfig: () => undefined }));
vi.mock("@/hooks/useSettingsKeys", () => ({
  useSettingsKeys: () => ({ keys: { keyring: null, previous: [] }, isFetched: true, ensure: async () => undefined }),
}));
vi.mock("@nostrify/react/login", () => ({ useNostrLogin: () => ({ logins: [] }) }));
vi.mock("@/hooks/useWireGitTicketRoots", () => ({ useWireGitTicketRoots: () => [] }));
vi.mock("@/hooks/useEventStore", () => ({ useEventStore: () => new Promise(() => {}) }));
vi.mock("@/lib/backgroundQuiet", () => ({ setNativeServiceWatching: () => {} }));
vi.mock("@/lib/beforeAccountExit", () => ({ registerBeforeAccountExit: () => () => {} }));
vi.mock("@/concord/lib/streamAuth", () => ({ signStreamAuthsChunked: async function* () {} }));
vi.mock("@/concord/hooks/useConcordSubs", () => ({
  useConcordSubsState: () => h.concord,
}));

function sub(communityId: string, channelId: string, name: string): ConcordSub {
  return {
    relays: ["wss://relay.ditto.pub"],
    communityId,
    communityName: name,
    channelId,
    channelName: "general",
    streams: [],
    gitAttachments: [],
  } as unknown as ConcordSub;
}

const SOAPBOX_GENERAL = "11".repeat(32);
const SOAPBOX_MEMES = "22".repeat(32);
const OTHER_GENERAL = "33".repeat(32);

async function lastConfigure(ready: boolean) {
  h.concord = {
    subs: [
      sub(SOAPBOX, SOAPBOX_GENERAL, "Soapbox Community"),
      sub(SOAPBOX, SOAPBOX_MEMES, "Soapbox Community"),
      sub(OTHER, OTHER_GENERAL, "Other"),
    ],
    ready,
    left: [],
  };
  // Module state (enablement, the configure dedupe) must not leak between cases.
  vi.resetModules();
  const { useNativeNotifications } = await import("@/hooks/useNativeNotifications");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  renderHook(() => useNativeNotifications(), { wrapper });
  await waitFor(() => expect(h.configure).toHaveBeenCalled());
  const payload = h.configure.mock.calls.at(-1)![0] as {
    concordPlaneReady: boolean;
    concordSubs: Array<{ communityId: string; channelId: string; mentionOnly: boolean }>;
    concordLeftCommunities: string[];
    concordLevels?: unknown;
  };
  return payload;
}

// Each case re-imports the hook's whole module graph after `resetModules`;
// under a full parallel run that cold import alone can outlast the default 5s.
describe("muting a Concord community, as the Android service is told", { timeout: 20_000 }, () => {
  beforeEach(() => {
    h.configure.mockClear();
    h.config = {
      pushPrefs: DEFAULT_PUSH_PREFS,
      // "Mute community" from the header or the rail writes the community scope.
      notifLevels: { [`c2:${SOAPBOX}`]: "nothing" },
      mutedCommunities: [`c2:${SOAPBOX}`],
      mutedChannels: [],
      automaticSettingsSync: true,
      dmsDisabled: false,
    };
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("control: with the Concord plane ready, the muted community is left out of a REPLACING config", async () => {
    const payload = await lastConfigure(true);
    expect(payload.concordPlaneReady).toBe(true);
    expect(payload.concordSubs.map((s) => s.channelId)).toEqual([OTHER_GENERAL]);
    // Native replaces `concord2Subs` wholesale, so the Soapbox entries are gone.
  });

  it("with the Concord plane unready, the mute reaches native as policy a merge applies", async () => {
    const payload = await lastConfigure(false);
    // The bridge merges an unready plane into what it stored last time…
    expect(payload.concordPlaneReady).toBe(false);
    // …where the snapshot's omission of the muted community proves nothing,
    expect(payload.concordSubs.map((s) => s.channelId)).toEqual([OTHER_GENERAL]);
    // …so the policy names it, for native to resolve the entries it kept.
    expect(payload.concordLevels).toEqual({
      default: "all",
      communities: { [SOAPBOX]: "nothing" },
      channels: {},
    });
  });

  it("the policy carries community and channel levels, lower-cased", async () => {
    const { concordLevelPolicy } = await import("@/hooks/useNotifLevels");
    expect(concordLevelPolicy(
      {
        [`c2:${OTHER.toUpperCase()}`]: "mentions",
        [`c2:${SOAPBOX}`]: "nothing",
        [`c2:${SOAPBOX}::${SOAPBOX_GENERAL}`]: "all",
        [`c2:${OTHER}::${OTHER_GENERAL}`]: "nothing",
        "wss://relay.example": "nothing",
      },
      { ...DEFAULT_PUSH_PREFS, allGroupMessages: false, mentions: true },
    )).toEqual({
      default: "mentions",
      communities: { [SOAPBOX]: "nothing", [OTHER]: "mentions" },
      channels: { [`${SOAPBOX}:${SOAPBOX_GENERAL}`]: "all", [`${OTHER}:${OTHER_GENERAL}`]: "nothing" },
    });
  });
});
