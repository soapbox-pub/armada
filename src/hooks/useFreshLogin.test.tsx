import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useFreshLogin, suppressNextSyncGate } from "@/hooks/useFreshLogin";
import {
  ACTIVE_PUBKEY_KEY,
  _resetActiveAccountForTests,
} from "@/lib/activeAccount";

const BOOT = "a".repeat(64);
const FRESH = "b".repeat(64);

// A mutable login list the mocked provider reads. `logins[0]` is the active
// account, matching useCurrentUser.
const h = vi.hoisted(() => ({
  logins: [] as Array<{ pubkey: string }>,
}));

vi.mock("@nostrify/react/login", () => ({
  useNostrLogin: () => ({ logins: h.logins }),
}));

/**
 * Simulate an app boot with `pubkey` signed in: write the synchronous marker
 * and re-read the boot snapshot, exactly as a real module load would. Then seat
 * the login list at that account so the hook mounts already-signed-in — which is
 * the ordering that broke the gate (the lazy per-account chunk mounts after the
 * login resolves).
 */
function bootAs(pubkey: string | null): void {
  if (pubkey) localStorage.setItem(ACTIVE_PUBKEY_KEY, pubkey);
  else localStorage.removeItem(ACTIVE_PUBKEY_KEY);
  _resetActiveAccountForTests();
  h.logins = pubkey ? [{ pubkey }] : [];
}

beforeEach(() => {
  localStorage.clear();
  _resetActiveAccountForTests();
  h.logins = [];
});

afterEach(() => {
  localStorage.clear();
  _resetActiveAccountForTests();
  h.logins = [];
});

describe("useFreshLogin", () => {
  it("does not flag a restored session as a fresh login", () => {
    // A cold boot with an account already in storage: the account is both the
    // boot marker and logins[0] from the first render.
    bootAs(BOOT);
    const { result } = renderHook(() => useFreshLogin());
    expect(result.current.freshPubkey).toBeUndefined();
  });

  it("flags a login the boot marker never saw — even when the hook mounts late", () => {
    // The prod regression: the gate lives in a lazy chunk gated on `user`, so it
    // only mounts AFTER the fresh login is already in `logins`. Boot with nobody
    // signed in, then mount already holding the fresh login.
    bootAs(null);
    h.logins = [{ pubkey: FRESH }];
    const { result } = renderHook(() => useFreshLogin());
    expect(result.current.freshPubkey).toBe(FRESH);
  });

  it("flags a fresh login on its first render", () => {
    // The gate mounts after the route has painted the app, so it has to be up
    // in the same commit, not one effect later.
    bootAs(null);
    h.logins = [{ pubkey: FRESH }];
    const renders: Array<string | undefined> = [];
    renderHook(() => {
      const result = useFreshLogin();
      renders.push(result.freshPubkey);
      return result;
    });
    expect(renders[0]).toBe(FRESH);
  });

  it("does not flag a wizard signup on any render", () => {
    bootAs(null);
    suppressNextSyncGate(FRESH);
    h.logins = [{ pubkey: FRESH }];
    const renders: Array<string | undefined> = [];
    renderHook(() => {
      const result = useFreshLogin();
      renders.push(result.freshPubkey);
      return result;
    });
    expect(renders.every((pubkey) => pubkey === undefined)).toBe(true);
  });

  it("flags an in-session switch to an account not signed in at boot", () => {
    bootAs(BOOT);
    const { result, rerender } = renderHook(() => useFreshLogin());
    expect(result.current.freshPubkey).toBeUndefined();
    act(() => {
      h.logins = [{ pubkey: FRESH }];
    });
    rerender();
    expect(result.current.freshPubkey).toBe(FRESH);
  });

  it("clears the fresh pubkey once acknowledged", () => {
    bootAs(null);
    h.logins = [{ pubkey: FRESH }];
    const { result } = renderHook(() => useFreshLogin());
    expect(result.current.freshPubkey).toBe(FRESH);
    act(() => result.current.acknowledge());
    expect(result.current.freshPubkey).toBeUndefined();
  });

  it("clears the fresh pubkey on logout", () => {
    bootAs(null);
    h.logins = [{ pubkey: FRESH }];
    const { result, rerender } = renderHook(() => useFreshLogin());
    expect(result.current.freshPubkey).toBe(FRESH);
    act(() => {
      h.logins = [];
    });
    rerender();
    expect(result.current.freshPubkey).toBeUndefined();
  });

  it("folds a wizard signup into the baseline without raising the gate", () => {
    bootAs(null);
    suppressNextSyncGate(FRESH);
    h.logins = [{ pubkey: FRESH }];
    const { result } = renderHook(() => useFreshLogin());
    expect(result.current.freshPubkey).toBeUndefined();
  });

  it("consumes the suppression one-shot: a later login for the same key still gates", () => {
    // The suppressed signup is folded in on this boot. On a subsequent boot with
    // nobody signed in, the same key logging in fresh must gate normally.
    bootAs(null);
    suppressNextSyncGate(FRESH);
    h.logins = [{ pubkey: FRESH }];
    const first = renderHook(() => useFreshLogin());
    expect(first.result.current.freshPubkey).toBeUndefined();
    first.unmount();

    bootAs(null);
    h.logins = [{ pubkey: FRESH }];
    const second = renderHook(() => useFreshLogin());
    expect(second.result.current.freshPubkey).toBe(FRESH);
  });
});
