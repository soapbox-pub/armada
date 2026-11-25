import { act, cleanup, render } from "@testing-library/react";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

/** Where MemberList files each member: one row per member, whichever sections claim them. */

const spies = vi.hoisted(() => ({
  useAuthor: vi.fn(),
  useUserStatus: vi.fn(),
  useScopedIdentity: vi.fn(),
  useMemberSearch: vi.fn(),
}));

vi.mock("@/hooks/useAuthor", () => ({
  useAuthor: (pubkey?: string) => {
    spies.useAuthor(pubkey);
    return { data: undefined };
  },
}));
// The mute menu item's mutations reach for the relay pool; this tree has none.
// `useMutedPubkeys` would be safe (it reads a context with a no-mutes default),
// but the module is mocked whole so the two can't disagree about the shape.
vi.mock("@/hooks/useMuteList", () => ({
  useMutedPubkeys: () => ({ mutedPubkeys: new Set<string>(), ready: true }),
  useMuteToggle: () => ({
    muted: false,
    canMute: false,
    pending: false,
    label: "Mute",
    toggle: async () => {},
  }),
}));
// Each row's `useUserModeration` asks who the viewer is; logged out offers no actions.
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useUserStatus", () => ({
  useUserStatus: (pubkey?: string, type = "general") => {
    spies.useUserStatus(pubkey, type);
    return { data: undefined };
  },
  isStatusExpired: () => false,
}));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedIdentity: (pubkey: string) => {
    spies.useScopedIdentity(pubkey);
    return { displayName: pubkey.slice(0, 8) };
  },
}));
vi.mock("@/hooks/useMemberSearch", () => ({
  useMemberSearch: (roster: string[], query: string) => {
    spies.useMemberSearch(roster, query);
    return null; // no search active
  },
  useMemberNameOrder: () => (a: string, b: string) => a.localeCompare(b),
}));
vi.mock("@/components/chat/ProfilePreviewCard", () => ({
  ProfilePreviewCard: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/dialogs/StatusDialog", () => ({ StatusDialog: () => null }));
vi.mock("@/components/BotPill", () => ({ BotPill: () => null }));
vi.mock("@/components/DisplayName", () => ({
  DisplayName: ({ name }: { name?: string }) => <span>{name}</span>,
}));
vi.mock("@/components/chat/CustomEmoji", () => ({
  EmojifiedText: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

import { MemberList } from "@/components/chat/MemberList";

// Controllable IntersectionObserver: it never fires on its own (offscreen), and
// a test can `fireAll()` to simulate every observed row scrolling into view.
const observers: MockIO[] = [];
class MockIO {
  els = new Set<Element>();
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
  constructor(private cb: IntersectionObserverCallback) {
    observers.push(this);
  }
  observe(el: Element) {
    this.els.add(el);
  }
  unobserve(el: Element) {
    this.els.delete(el);
  }
  disconnect() {
    this.els.clear();
  }
  takeRecords() {
    return [];
  }
  fire() {
    const entries = [...this.els].map(
      (target) => ({ isIntersecting: true, target }) as IntersectionObserverEntry,
    );
    this.cb(entries, this as unknown as IntersectionObserver);
  }
}

function fireAll() {
  act(() => {
    for (const io of [...observers]) io.fire();
  });
}

function pubkeys(n: number): string[] {
  return Array.from({ length: n }, () => getPublicKey(generateSecretKey()));
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("IntersectionObserver", MockIO);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("MemberList sections", () => {
  it("lists a member awaiting approval once, under the hoisted Role that holds them", () => {
    const [held, waiting, regular] = pubkeys(3);
    const { container } = render(
      <MemberList
        admins={[]}
        members={[held, waiting, regular]}
        roleSections={[{ id: "artists", name: "Artists", color: 0, members: [held] }]}
        awaiting={[held, waiting]}
      />,
    );
    fireAll();
    expect(container.querySelectorAll(".gutter-tick").length).toBe(3);
  });
});
