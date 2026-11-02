import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProfileSettings } from "@/components/ProfileSettings";

// A profile shaped like one seen in the wild: a bare-domain NIP-05 (which the
// metadata schema parses away), a name spelled in custom emoji shortcodes, a
// non-standard key, and a tag from another client. Hoisted, so the mocked hook
// returns the same objects every render.
const fixture = vi.hoisted(() => {
  const content = JSON.stringify({
    name: ":H::e::n::k::y:!!",
    displayName: "Henky",
    nip05: "Example.com",
    about: "hi",
    fields: [["Site", "https://example.com"]],
  });
  const event = {
    id: "e".repeat(64),
    pubkey: "a".repeat(64),
    kind: 0,
    created_at: 1,
    content,
    sig: "",
    tags: [
      ["emoji", "H", "https://example.com/h.png"],
      ["emoji", "e", "https://example.com/e.png"],
      ["client", "ditto"],
    ],
  };
  return { content, event, publish: undefined as unknown as (...args: unknown[]) => Promise<unknown> };
});
const { event } = fixture;
const publish = vi.fn(async () => event);
fixture.publish = publish;

vi.mock("@/hooks/useCurrentUser", async () => {
  const { metadataSchema } = await import("@/lib/authorCache");
  const profile = {
    user: { pubkey: "a".repeat(64) },
    metadata: metadataSchema.parse(fixture.content),
    event: fixture.event,
    imeta: undefined,
  };
  return { useCurrentUserProfile: () => profile };
});
vi.mock("@/hooks/useNostrPublish", () => ({
  useNostrPublish: () => ({ mutateAsync: (...args: unknown[]) => fixture.publish(...args), isPending: false }),
}));
vi.mock("@/hooks/useUploadFile", () => ({
  useUploadFile: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/useUploadProfileImage", () => ({
  useUploadProfileImage: () => ({ upload: vi.fn(), isPending: false }),
}));
vi.mock("@/components/ProfileCard", () => ({ ProfileCard: () => null }));
vi.mock("@/components/PaymentTargetsEditor", () => ({ PaymentTargetsEditor: () => null }));

describe("ProfileSettings round trip", () => {
  it("saves an unedited profile without changing its NIP-05, name, custom keys or emoji", async () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ProfileSettings />
      </QueryClientProvider>,
    );
    await act(async () => {
      fireEvent.submit(container.querySelector("form")!);
    });
    await waitFor(() => expect(publish).toHaveBeenCalled());

    const sent = (publish.mock.calls[0] as unknown as [{ content: string; tags: string[][] }])[0];
    const saved = JSON.parse(sent.content);
    expect(saved.nip05).toBe("Example.com");
    expect(saved.name).toBe(":H::e::n::k::y:!!");
    expect(saved.displayName).toBe("Henky");
    expect(sent.tags.filter((t) => t[0] === "emoji")).toEqual(event.tags.filter((t) => t[0] === "emoji"));
  });
});
