import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

const decrypted = vi.hoisted(() => vi.fn((pointer: unknown) => (pointer ? "blob:art" : undefined)));
vi.mock("@/concord/hooks/useDecryptedImage", () => ({ useDecryptedImage: decrypted }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useFollowList", () => ({ useFollowList: () => ({ data: undefined }) }));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/DisplayName", () => ({ DisplayName: () => <span>name</span> }));
vi.mock("@/concord/hooks/useGuestbook", () => ({ useGuestbook: () => ({ coalesced: new Map() }) }));

import { InviteDetail } from "@/concord/pages/InvitesPage";

import type { InviteBundle } from "@/concord/lib/invite";

const bundle = { name: "Room", relays: [], channels: [], icon: { url: "https://x/icon" }, banner: { url: "https://x/banner" } } as unknown as InviteBundle;

function mount(isRequest: boolean) {
  decrypted.mockClear();
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <InviteDetail bundle={bundle} communityId={"c".repeat(64)} name="Room" sender={"a".repeat(64)} isRequest={isRequest}
          accepting={false} declining={false} onAccept={() => {}} onDecline={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("InviteDetail community art", () => {
  it("fetches no art for a stranger's invite until asked", () => {
    mount(true);
    expect(decrypted.mock.calls.every(([pointer]) => pointer === undefined)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Show the community’s images/ }));
    expect(decrypted).toHaveBeenCalledWith(bundle.icon);
  });

  it("shows a known sender's invite art at once", () => {
    mount(false);
    expect(decrypted).toHaveBeenCalledWith(bundle.icon);
    expect(screen.queryByRole("button", { name: /Show the community’s images/ })).toBeNull();
  });
});
