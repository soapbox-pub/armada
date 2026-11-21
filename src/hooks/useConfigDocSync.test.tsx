import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultConfig, type AppConfig } from "@/contexts/AppContext";
import { useConfigDocSync } from "@/hooks/useConfigDocSync";

const h = vi.hoisted(() => ({
  config: {} as AppConfig,
  publish: vi.fn(),
  updateConfig: vi.fn(),
  docs: {} as Record<string, unknown>,
  notificationsReady: true,
}));

vi.mock("@/lib/notificationSettingsAuthority", () => ({
  markNotificationSettingsReady: vi.fn(),
  useNotificationSettingsReady: () => h.notificationsReady,
}));

vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config, updateConfig: h.updateConfig }),
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: { pubkey: "a".repeat(64) } }),
}));

vi.mock("@/hooks/useSettingsDoc", () => ({
  // Name-aware so a `dms` test can present a different document than the
  // `metadata` gate. The metadata stub is rebuilt on every call on purpose:
  // the delivery tests rely on its per-render identity churn to re-run the
  // publish effect. A test opts a document in by setting `h.docs[name]`.
  useSettingsDoc: (name: string) =>
    h.docs[name] ?? {
      doc: { theme: "light" },
      event: { id: "settings-v1", created_at: 1 },
      sources: [],
      isFetched: true,
      update: h.publish,
      hasNip44Support: true,
    },
}));

describe("useConfigDocSync automatic delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.config = { ...defaultConfig, theme: "light" };
    h.publish.mockReset();
    h.updateConfig.mockReset();
    h.docs = {};
    h.notificationsReady = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("neither applies nor publishes settings when this device opts out", async () => {
    h.config = {
      ...h.config,
      automaticSettingsSync: false,
      theme: "dark",
    };
    renderHook(() => useConfigDocSync("metadata"));

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(h.updateConfig).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("cancels a queued automatic publish when the switch is turned off", async () => {
    const { rerender } = renderHook(() => useConfigDocSync("metadata"));

    h.config = { ...h.config, theme: "dark" };
    rerender();
    h.config = { ...h.config, automaticSettingsSync: false };
    rerender();

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("retries a durable config edit after relay delivery fails", async () => {
    h.publish
      .mockRejectedValueOnce(new Error("relay down"))
      .mockResolvedValueOnce({});
    const { rerender } = renderHook(() => useConfigDocSync("metadata"));

    h.config = { ...h.config, theme: "dark" };
    rerender();
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(h.publish).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(h.publish).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(h.publish).toHaveBeenCalledTimes(2);
  });

  it("doubles the retry delay while delivery keeps failing", async () => {
    h.publish
      .mockRejectedValueOnce(new Error("relay down"))
      .mockRejectedValueOnce(new Error("relay down"))
      .mockResolvedValueOnce({});
    const { rerender } = renderHook(() => useConfigDocSync("metadata"));

    h.config = { ...h.config, theme: "dark" };
    rerender();
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(h.publish).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(h.publish).toHaveBeenCalledTimes(2);

    await act(() => vi.advanceTimersByTimeAsync(9_999));
    expect(h.publish).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(h.publish).toHaveBeenCalledTimes(3);
  });

  it("publishes the latest snapshot when config changes during delivery", async () => {
    let finishFirst!: () => void;
    h.publish
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        finishFirst = resolve;
      }))
      .mockResolvedValueOnce({});
    const { rerender } = renderHook(() => useConfigDocSync("metadata"));

    h.config = { ...h.config, theme: "dark" };
    rerender();
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(h.publish).toHaveBeenCalledTimes(1);

    h.config = { ...h.config, currencyDisplay: "sats" };
    rerender();
    await act(async () => finishFirst());
    await act(() => vi.advanceTimersByTimeAsync(800));

    expect(h.publish).toHaveBeenCalledTimes(2);
    expect(h.publish.mock.calls[1]![0]).toMatchObject({
      theme: "dark",
      currencyDisplay: "sats",
    });
  });

  // Vector 1: two devices (e.g. Android + web) each publish the `dms` document
  // as one last-writer-wins blob. A device that unpins/edits anything in it
  // while holding a stale `closedDms` republishes its whole map, so a hide the
  // OTHER device just made — but this doc predates — is dropped when the peer
  // pulls it. The apply direction must therefore keep a locally-held hide that
  // the incoming document omits, or the hide is wiped.
  it("keeps a locally-held DM hide when an incoming dms doc omits it", () => {
    const localMarker = { eventId: "msgA", createdAt: 100 };
    const remoteMarker = { eventId: "msgB", createdAt: 200 };
    h.config = { ...h.config, closedDms: { peerA: localMarker } };
    h.docs.dms = {
      doc: { closedDms: { peerB: remoteMarker } },
      event: { id: "dms-v1", created_at: 2 },
      isFetched: true,
      update: h.publish,
      hasNip44Support: true,
    };

    renderHook(() => useConfigDocSync("dms"));

    // The apply effect folds the incoming document into config.
    expect(h.updateConfig).toHaveBeenCalled();
    const updater = h.updateConfig.mock.calls[0]![0] as (c: AppConfig) => AppConfig;
    const next = updater(h.config);

    // Both hides must survive: the local one (not on the incoming doc yet) and
    // the remote one. Wholesale replace drops `peerA`; a per-peer merge keeps it.
    expect(next.closedDms).toEqual({ peerA: localMarker, peerB: remoteMarker });
  });

  it("keeps a notification choice an incoming document lacks, and writes the merge back", async () => {
    const mute = { until: -1, at: 5_000_000, op: "local" };
    h.config = { ...h.config, notifMuteRecords: { "dm:peer": mute }, notifLevels: { "dm:peer": "nothing" } };
    h.docs.notifications = {
      doc: {
        notifLevelRecords: { "c2:x": { v: "mentions", at: 1_000, op: "remote" } },
        notifMuteRecords: {},
        notifLevels: { "c2:x": "mentions" },
        mutedCommunities: [],
        mutedChannels: [],
      },
      event: { id: "notif-v1", created_at: 2 },
      sources: [],
      isFetched: true,
      update: h.publish,
      hasNip44Support: true,
    };
    h.publish.mockResolvedValue({});
    const { rerender } = renderHook(() => useConfigDocSync("notifications"));

    const updater = h.updateConfig.mock.calls[0]![0] as (c: AppConfig) => AppConfig;
    h.config = updater(h.config);
    expect(h.config.notifMuteRecords).toEqual({ "dm:peer": mute });
    expect(h.config.notifLevels).toEqual({ "c2:x": "mentions", "dm:peer": "nothing" });

    rerender();
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(h.publish).toHaveBeenCalledTimes(1);
    expect(h.publish.mock.calls[0]![0]).toMatchObject({
      notifMuteRecords: { "dm:peer": mute },
      notifLevelRecords: { "c2:x": { v: "mentions", at: 1_000, op: "remote" } },
    });
  });

  it("does not write back a notifications document that already holds everything", async () => {
    const level = { v: "mentions" as const, at: 1_000, op: "remote" };
    h.config = { ...h.config, notifLevelRecords: { "c2:x": level }, notifLevels: { "c2:x": "mentions" } };
    h.docs.notifications = {
      doc: {
        notifLevelRecords: { "c2:x": level },
        notifMuteRecords: {},
        notifLevels: { "c2:x": "mentions" },
        mutedCommunities: [],
        mutedChannels: [],
        pushPrefs: h.config.pushPrefs,
      },
      event: { id: "notif-v1", created_at: 2 },
      sources: [],
      isFetched: true,
      update: h.publish,
      hasNip44Support: true,
    };
    const { rerender } = renderHook(() => useConfigDocSync("notifications"));
    const updater = h.updateConfig.mock.calls[0]![0] as (c: AppConfig) => AppConfig;
    h.config = updater(h.config);
    rerender();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("does not publish a slice before its stored document has been read", async () => {
    h.docs.notifications = {
      doc: null,
      event: null,
      sources: [],
      isFetched: false,
      update: h.publish,
      hasNip44Support: true,
    };
    const { rerender } = renderHook(() => useConfigDocSync("notifications"));

    h.config = { ...h.config, pushPrefs: { ...h.config.pushPrefs, reactions: false } };
    rerender();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("does not publish notification settings an empty store has not proven absent", async () => {
    h.notificationsReady = false;
    h.docs.notifications = {
      doc: null,
      event: null,
      sources: [],
      isFetched: true,
      update: h.publish,
      hasNip44Support: true,
    };
    const { rerender } = renderHook(() => useConfigDocSync("notifications"));

    h.config = { ...h.config, pushPrefs: { ...h.config.pushPrefs, reactions: false } };
    rerender();
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(h.publish).not.toHaveBeenCalled();
  });
});
