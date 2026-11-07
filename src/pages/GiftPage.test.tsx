import { act, fireEvent, render, screen } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const GIFTER = "b".repeat(64);
const ME = "a".repeat(64);

const h = vi.hoisted(() => ({
  user: undefined as { pubkey: string } | undefined,
  ultra: undefined as unknown,
  publish: vi.fn(async () => {}),
  thank: vi.fn(),
}));

vi.mock("@/components/layout/ServerRail", () => ({ ServerRail: () => null }));
vi.mock("@/components/Confetti", () => ({ Confetti: () => <div data-testid="confetti" /> }));
vi.mock("@/lib/fanfare", () => ({ playFanfare: vi.fn() }));
vi.mock("@/components/auth/JoinButton", () => ({
  JoinButton: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: h.user }) }));
vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: (pubkey?: string) => ({ data: pubkey === GIFTER ? { metadata: { name: "Ana" } } : undefined }),
}));
vi.mock("@/hooks/useUltra", () => ({
  useMyUltra: () => ({ pubkey: h.user?.pubkey, metadata: h.user ? { name: "Ben" } : undefined, ultra: h.ultra, isLoading: false }),
  usePublishUltra: () => ({ publish: h.publish, isPending: false }),
}));
vi.mock("@/hooks/useUltraGift", () => ({
  useUltraGift: () => ({ url: "https://armada.buzz/gift/x", sendToChat: vi.fn(), sendToPeer: vi.fn(), thank: h.thank }),
}));
vi.mock("@/hooks/useUploadProfileImage", () => ({ useUploadProfileImage: () => ({ upload: vi.fn(), isPending: false }) }));

import { GiftPage } from "@/pages/GiftPage";

function renderGift() {
  return render(
    <MemoryRouter initialEntries={[`/gift/${nip19.npubEncode(GIFTER)}`]}>
      <Routes>
        <Route path="/gift/:from" element={<GiftPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function openGift() {
  fireEvent.click(screen.getAllByRole("button", { name: "Open your gift" }).at(-1)!);
  await act(async () => { await vi.advanceTimersByTimeAsync(600); });
}

describe("GiftPage", () => {
  afterEach(() => {
    vi.useRealTimers();
    h.user = undefined;
    h.ultra = undefined;
    h.publish.mockClear();
  });

  it("opens the box for a signed-out visitor and asks them to join to claim", async () => {
    vi.useFakeTimers();
    renderGift();
    expect(screen.getByText("Ana")).toBeInTheDocument();
    await openGift();
    expect(screen.getByText("Armada Ultra")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Join Armada to claim/ })).toBeInTheDocument();
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("claims the picked look on an explicit press", async () => {
    vi.useFakeTimers();
    h.user = { pubkey: ME };
    renderGift();
    await openGift();
    fireEvent.click(screen.getAllByRole("button", { name: "Gold" })[0]); // the name style, above the glow
    fireEvent.click(screen.getByRole("button", { name: "Hearts" }));
    fireEvent.click(screen.getByRole("button", { name: /Claim my Ultra/ }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(h.publish).toHaveBeenCalledWith(
      expect.objectContaining({ name: "gold", frame: "glow", effect: "hearts" }),
      { picture: undefined },
    );
    expect(screen.getByRole("button", { name: "Thank Ana" })).toBeInTheDocument();
  });

  it("lets an existing member thank the gifter instead of claiming again", async () => {
    vi.useFakeTimers();
    h.user = { pubkey: ME };
    h.ultra = { since: 1, name: "toxic" };
    renderGift();
    await openGift();
    expect(screen.queryByRole("button", { name: /Claim my Ultra/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Thank Ana" }));
    expect(h.thank).toHaveBeenCalledWith(GIFTER);
  });
});
