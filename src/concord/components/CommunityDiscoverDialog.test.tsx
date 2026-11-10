import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Boost } from "@/lib/discoverBoost";
import type { Community } from "@/concord/lib/types";

const h = vi.hoisted(() => ({
  listings: [] as Array<{ inviteUrl: string; linkSigner: string; source: { id: string; pubkey: string } }>,
  boosts: [] as Boost[],
  mine: undefined as Boost | undefined,
  boost: vi.fn(async () => {}),
  unboost: vi.fn(async () => {}),
}));

vi.mock("@/concord/hooks/useDiscoverListings", () => ({
  useCommunityDiscoverListings: () => ({ listings: h.listings, isLoading: false }),
}));
vi.mock("@/hooks/useDiscover", () => ({
  useCommunityBoosts: () => ({
    boosts: h.boosts,
    mine: h.mine,
    isLoading: false,
    boost: { mutateAsync: h.boost, isPending: false },
    unboost: { mutateAsync: h.unboost, isPending: false },
  }),
}));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/concord/hooks/useControlPlane", () => ({ useControlFold: () => ({ data: { metadata: { name: "Lounge" } } }) }));
vi.mock("@/concord/hooks/useDecryptedImage", () => ({ useDecryptedImage: () => null }));
vi.mock("@/components/Confetti", () => ({ Confetti: () => <div data-testid="confetti" /> }));
vi.mock("@/components/DisplayName", () => ({ DisplayName: ({ name }: { name: string }) => <>{name}</> }));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({ ProfilePreviewCard: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const { CommunityDiscoverDialog } = await import("./CommunityDiscoverDialog");

const MEMBER_A = "a".repeat(64);
const MEMBER_B = "b".repeat(64);
const OUTSIDER = "9".repeat(64);
const community = { idHex: "c".repeat(64), owner: "1".repeat(64) } as Community;
const LISTING = { inviteUrl: "https://armada.test/invite/x", linkSigner: "2".repeat(64), source: { id: "e".repeat(64), pubkey: "3".repeat(64) } };
const nowS = () => Math.floor(Date.now() / 1000);
const boostBy = (pubkey: string, agoS = 60): Boost => ({
  pubkey,
  event: { id: pubkey, pubkey, created_at: nowS() - agoS, kind: 1985, tags: [], content: "" },
});

function renderDialog() {
  render(<CommunityDiscoverDialog open onOpenChange={() => {}} community={community} members={new Set([MEMBER_A, MEMBER_B])} />);
}

beforeEach(() => {
  h.listings = [];
  h.boosts = [];
  h.mine = undefined;
  h.boost.mockClear();
  h.unboost.mockClear();
});

describe("CommunityDiscoverDialog", () => {
  it("boosts a listed community", async () => {
    h.listings = [LISTING];
    renderDialog();
    expect(screen.getByRole("heading", { name: "Boost Lounge" })).toBeInTheDocument();
    expect(screen.getByText(/On Discover via/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Boost" }));
    await waitFor(() => expect(h.boost).toHaveBeenCalled());
    expect(await screen.findByTestId("confetti")).toBeInTheDocument();
  });

  it("counts members' boosts toward the level, not outsiders'", () => {
    h.listings = [LISTING];
    h.boosts = [boostBy(MEMBER_A), boostBy(MEMBER_B), boostBy(OUTSIDER)];
    renderDialog();

    expect(screen.getByText("2 boosts")).toBeInTheDocument();
    expect(screen.getByText("5 more for level 2")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "2");
  });

  it("removes a boost, and offers renewing only near its end", async () => {
    h.listings = [LISTING];
    h.mine = boostBy(MEMBER_A);
    h.boosts = [h.mine];
    renderDialog();

    expect(screen.getByText(/Boosting until/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Boost again" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove boost" }));
    await waitFor(() => expect(h.unboost).toHaveBeenCalled());
  });

  it("offers boosting again in a boost's last week", () => {
    h.listings = [LISTING];
    h.mine = boostBy(MEMBER_A, 25 * 24 * 60 * 60);
    h.boosts = [h.mine];
    renderDialog();

    expect(screen.getByRole("button", { name: "Boost again" })).toBeInTheDocument();
  });
});
