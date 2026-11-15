// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DM_INBOX_RELAYS } from "@/lib/platform";

const h = vi.hoisted(() => ({
  list: {
    isReady: true,
    event: null as unknown,
    publish: vi.fn<(relays: string[]) => Promise<string[]>>(),
  },
  config: {
    dmsDisabled: false,
    useAppRelays: true,
    appRelays: ["wss://app.example"],
    dmRelays: [] as string[],
  },
  updateConfig: vi.fn(),
  nip44: true,
}));

vi.mock("@/hooks/useDmRelayList", () => ({ useDmRelayList: () => h.list }));
vi.mock("@/hooks/useAppContext", () => ({
  useAppContext: () => ({ config: h.config, updateConfig: h.updateConfig }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({
    user: { pubkey: "a".repeat(64), signer: h.nip44 ? { nip44: {} } : {} },
  }),
}));

import { useDmInboxSetup } from "@/hooks/useDmInboxSetup";

beforeEach(() => {
  localStorage.clear();
  h.list.isReady = true;
  h.list.event = null;
  h.list.publish.mockReset().mockResolvedValue([]);
  h.updateConfig.mockReset();
  h.config.dmsDisabled = false;
  h.config.dmRelays = [];
  h.nip44 = true;
});

describe("useDmInboxSetup", () => {
  it("offers setup only when every account relay confirmed there is no list", () => {
    expect(renderHook(() => useDmInboxSetup()).result.current.missing).toBe(true);

    h.list.isReady = false;
    expect(renderHook(() => useDmInboxSetup()).result.current.missing).toBe(false);

    h.list.isReady = true;
    h.list.event = { kind: 10050, tags: [] };
    expect(renderHook(() => useDmInboxSetup()).result.current.missing).toBe(false);
  });

  it("stays quiet with DMs off or a signer that can't do NIP-17", () => {
    h.config.dmsDisabled = true;
    expect(renderHook(() => useDmInboxSetup()).result.current.missing).toBe(false);
    h.config.dmsDisabled = false;
    h.nip44 = false;
    expect(renderHook(() => useDmInboxSetup()).result.current.missing).toBe(false);
  });

  it("publishes where DMs already arrive plus the default inbox relays", async () => {
    const { result } = renderHook(() => useDmInboxSetup());
    await act(() => result.current.publish());
    const expected = ["wss://app.example", ...DM_INBOX_RELAYS];
    expect(h.list.publish).toHaveBeenCalledWith(expected);
    const next = h.updateConfig.mock.calls[0][0](h.config);
    expect(next).toMatchObject({ dmRelays: expected });
  });

  it("resolves with the relays it published", async () => {
    const { result } = renderHook(() => useDmInboxSetup());
    let published: string[] | undefined;
    await act(async () => { published = await result.current.publish(); });
    expect(published).toEqual(h.list.publish.mock.calls[0][0]);
  });

  it("does not touch config when the publish is refused", async () => {
    h.list.publish.mockRejectedValue(new Error("no relay answered"));
    const { result } = renderHook(() => useDmInboxSetup());
    await expect(act(() => result.current.publish())).rejects.toThrow();
    expect(h.updateConfig).not.toHaveBeenCalled();
  });

  it("remembers a dismissal per account", () => {
    const first = renderHook(() => useDmInboxSetup());
    act(() => first.result.current.dismiss());
    expect(first.result.current.dismissed).toBe(true);
    expect(renderHook(() => useDmInboxSetup()).result.current.dismissed).toBe(true);
  });
});
