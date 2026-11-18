import { cleanup, render, screen } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NostrRumor } from "@/lib/nostrRumor";

const events = new Map<string, NostrRumor>();
const useEvent = vi.fn((id?: string) => ({ data: id ? events.get(id) ?? null : null }));
const held = new Set<string>();
const banned = new Set<string>();

vi.mock("@/hooks/useEvent", () => ({
  publicRelayHints: (relays?: string[]) => relays ?? [],
  useEvent: (id?: string) => useEvent(id),
}));
vi.mock("@/components/chat/mediaHold", () => ({
  useMediaHeld: (pubkey?: string) => !!pubkey && held.has(pubkey),
}));
vi.mock("@/lib/blocklistStore", () => ({
  useIsUserBanned: () => (pubkey: string) => banned.has(pubkey),
}));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ pubkey }: { pubkey?: string }) => <span>{pubkey?.slice(0, 4)}</span>,
}));

import { ReplyPreview } from "@/components/chat/ChatMessage";

const PARENT = "a".repeat(64);
const QUOTED = "b".repeat(64);
const ID = "c".repeat(64);

function note(over: Partial<NostrRumor> = {}): NostrRumor {
  return { id: ID, pubkey: QUOTED, created_at: 1_700_000_000, kind: 1, content: "You can already disable DMs", tags: [], ...over };
}

beforeEach(() => {
  events.clear();
  held.clear();
  banned.clear();
  useEvent.mockClear();
});
afterEach(cleanup);

describe("ReplyPreview quoted notes", () => {
  it("shows a quoted nevent's own text instead of the identifier", () => {
    events.set(ID, note());
    const nevent = nip19.neventEncode({ id: ID, author: QUOTED });
    const { container } = render(<ReplyPreview content={`nostr:${nevent}`} quotesBy={PARENT} />);
    expect(container.textContent).toBe("You can already disable DMs");
    expect(container.textContent).not.toContain("nevent1");
  });

  it("resolves a bare note1 alongside the parent's own words", () => {
    events.set(ID, note());
    const { container } = render(<ReplyPreview content={`see ${nip19.noteEncode(ID)}`} quotesBy={PARENT} />);
    expect(container.textContent).toBe("see You can already disable DMs");
  });

  it("names a quote it hasn't loaded rather than printing the identifier", () => {
    const { container } = render(<ReplyPreview content={`nostr:${nip19.noteEncode(ID)}`} quotesBy={PARENT} />);
    expect(screen.getByText("Quoted post")).toBeTruthy();
    expect(container.textContent).not.toContain("note1");
  });

  it("fetches nothing when the parent's author is held", () => {
    events.set(ID, note());
    render(<ReplyPreview content={`nostr:${nip19.noteEncode(ID)}`} />);
    expect(useEvent).not.toHaveBeenCalled();
    expect(screen.getByText("Quoted post")).toBeTruthy();
  });

  it("does not resolve a quote inside a quote", () => {
    const inner = "d".repeat(64);
    events.set(ID, note({ content: `nostr:${nip19.noteEncode(inner)}` }));
    render(<ReplyPreview content={`nostr:${nip19.noteEncode(ID)}`} quotesBy={PARENT} />);
    expect(useEvent).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Quoted post")).toBeTruthy();
  });

  it("uses a card kind's title, or its label, never its content", () => {
    events.set(ID, note({ kind: 30023, content: "# long markdown", tags: [["title", "An article"]] }));
    const { container, rerender } = render(<ReplyPreview content={`nostr:${nip19.noteEncode(ID)}`} quotesBy={PARENT} />);
    expect(container.textContent).toBe("An article");
    events.set(ID, note({ kind: 0, content: '{"name":"x"}' }));
    useEvent.mockClear();
    rerender(<ReplyPreview content={`nostr:${nip19.neventEncode({ id: ID })}`} quotesBy={PARENT} />);
    expect(container.textContent).toBe("Profile");
  });

  it("hides a banned author's quoted text", () => {
    events.set(ID, note());
    banned.add(QUOTED);
    const { container } = render(<ReplyPreview content={`nostr:${nip19.noteEncode(ID)}`} quotesBy={PARENT} />);
    expect(container.textContent).toBe("Quoted post");
  });

  it("labels an naddr by its kind without fetching it", () => {
    const naddr = nip19.naddrEncode({ kind: 30023, pubkey: QUOTED, identifier: "post" });
    const { container } = render(<ReplyPreview content={`nostr:${naddr}`} quotesBy={PARENT} />);
    expect(useEvent).not.toHaveBeenCalled();
    expect(container.textContent).toBe("Article");
  });

  it("keeps a string that does not decode as text", () => {
    const { container } = render(<ReplyPreview content="nevent1qqqq" quotesBy={PARENT} />);
    expect(container.textContent).toBe("nevent1qqqq");
  });
});
