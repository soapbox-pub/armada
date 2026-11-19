import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_PUBKEY_KEY, _resetActiveAccountForTests } from "@/lib/activeAccount";

const BOOT = "a".repeat(64);
const FRESH = "b".repeat(64);

const h = vi.hoisted(() => ({
  user: undefined as { pubkey: string } | undefined,
}));

vi.mock("@/hooks/useCurrentUser", () => ({
  useCurrentUser: () => ({ user: h.user }),
}));

vi.mock("@/components/SignedInServices", () => ({
  SignedInServices: () => <div>signed-in services</div>,
  SignedInPushServices: () => null,
}));

import { SignedInServicesGate } from "@/App";

afterEach(() => {
  localStorage.clear();
  _resetActiveAccountForTests();
  h.user = undefined;
});

describe("SignedInServicesGate", () => {
  it("covers the app while the services load after a fresh login only", async () => {
    // A restored session: the boot account is signed in. The chunk is still loading.
    localStorage.setItem(ACTIVE_PUBKEY_KEY, BOOT);
    _resetActiveAccountForTests();
    h.user = { pubkey: BOOT };
    const restored = render(<SignedInServicesGate variant="core" />);
    expect(screen.queryByRole("status")).toBeNull();
    restored.unmount();

    // A fresh login: nobody was signed in at boot.
    localStorage.clear();
    _resetActiveAccountForTests();
    h.user = { pubkey: FRESH };
    render(<SignedInServicesGate variant="core" />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

    // Past React's ~300 ms throttle on a suspended reveal.
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(screen.getByText("signed-in services")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
