import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/useCustomEmojis", () => ({ useCustomEmojis: () => ({ emojis: [] }) }));
vi.mock("@/hooks/useMentionLabels", () => ({ useMentionLabels: () => () => "@Alice" }));
vi.mock("@/hooks/useMutedPubkeys", () => ({ useMutedPubkeys: () => ({ mutedPubkeys: new Set() }) }));
vi.mock("@/hooks/useSearchProfiles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useSearchProfiles")>()),
  useSearchProfiles: () => ({ data: [] }),
}));
vi.mock("@/components/UserAvatar", () => ({ UserAvatar: () => null }));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <span>{name ?? "Alice"}</span>,
}));
vi.mock("@/components/BotPill", () => ({ BotPill: () => null }));

import { MessageEditBox } from "@/components/chat/MessageEditBox";
import { MentionRosterContext } from "@/components/chat/mentionRoster";

const alice = "a".repeat(64);
const aliceRef = `nostr:${nip19.npubEncode(alice)}`;

function setup(roster: string[] | undefined) {
  const client = new QueryClient();
  client.setQueryData(["author", alice], { metadata: { name: "Alice" } });
  const onSubmit = vi.fn();
  const onCancel = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MentionRosterContext.Provider value={roster}>{children}</MentionRosterContext.Provider>
    </QueryClientProvider>
  );
  render(<MessageEditBox content="hi" tags={[]} sendOnEnter onSubmit={onSubmit} onCancel={onCancel} />, { wrapper });
  const field = screen.getByRole("textbox") as HTMLTextAreaElement;
  const type = (value: string) => act(() => {
    fireEvent.change(field, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
    fireEvent.input(field);
  });
  return { field, type, onSubmit, onCancel };
}

const menu = () => document.querySelector("[data-autocomplete-dropdown]");

afterEach(cleanup);

describe("MessageEditBox mentions", () => {
  it("suggests the room's members and inserts the picked one instead of saving", () => {
    const { field, type, onSubmit } = setup([alice]);
    type("hi @al");
    expect(menu()?.textContent).toContain("Alice");

    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(menu()).toBeNull();

    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith(`hi ${aliceRef} `);
  });

  it("closes the menu on Escape without cancelling the edit", () => {
    const { field, type, onCancel } = setup([alice]);
    type("hi @al");
    expect(menu()).not.toBeNull();
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it("offers nothing where the room's composer has mentions off", () => {
    const { type } = setup(undefined);
    type("hi @al");
    expect(menu()).toBeNull();
  });
});
