import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * A held author's media is not in the DOM at all — no <img>, no <video>, no
 * blurhash, no sender emoji — until the reader presses Load.
 */

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useApps", () => ({
  useApps: () => ({ activeApp: null, launchApp: () => {} }),
}));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey?: string) => (pubkey ?? "").slice(0, 8),
  useScopedIdentity: (pubkey?: string) => ({ displayName: (pubkey ?? "").slice(0, 8) }),
}));
vi.mock("@/hooks/useMentionNameMap", () => ({
  useMentionNameMap: () => ({ byName: new Map(), regex: null }),
}));
vi.mock("@/components/BlurhashCanvas", () => ({ BlurhashCanvas: () => <canvas /> }));
vi.mock("@/hooks/useCustomEmojis", () => ({
  useCustomEmojis: () => ({ emojis: [], isLoading: false }),
}));

import { ChatContent } from "@/components/chat/ChatContent";
import { MediaHoldContext } from "@/components/chat/mediaHold";
import { clearRevealedMedia } from "@/components/chat/revealedMedia";
import { MutedPubkeysContext } from "@/contexts/MutedPubkeysContext";

afterEach(() => {
  cleanup();
  clearRevealedMedia();
});

const STRANGER = "f".repeat(64);
const IMAGE = "https://blossom.example.com/x.jpg";
const EMOJI = "https://emoji.example.com/e.png";

function message(content?: string, tags?: string[][]): NostrEvent {
  return {
    id: "6".repeat(64),
    pubkey: STRANGER,
    created_at: 1700000000,
    kind: 9,
    tags: tags ?? [
      ["imeta", `url ${IMAGE}`, "m image/jpeg", "blurhash LEHV6nWB2yk8pyo0adR*.7kCMdnj"],
      ["emoji", "wave", EMOJI],
    ],
    content: content ?? `:wave: ${IMAGE}`,
    sig: "0".repeat(128),
  };
}

function renderWith(
  holds: ((pubkey: string) => boolean) | null,
  event = message(),
  host: (pubkey: string, url: string) => boolean = () => false,
) {
  const hold = holds && { mode: "trusted" as const, media: holds, host };
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <MediaHoldContext.Provider value={hold}>
          <ChatContent event={event} />
        </MediaHoldContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChatContent media hold", () => {
  it("renders nothing fetchable for a held author until Load", () => {
    const { container } = renderWith((pk) => pk === STRANGER);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
    expect(screen.getByText("Image from a new member")).toBeInTheDocument();
    expect(container.textContent).toContain(":wave:");

    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(screen.queryByText("Image from a new member")).toBeNull();
    expect(container.querySelector(`img[src="${EMOJI}"]`)).not.toBeNull();
  });

  it("keeps a loaded message loaded when it mounts again", () => {
    const first = renderWith((pk) => pk === STRANGER);
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    first.unmount();
    renderWith((pk) => pk === STRANGER);
    expect(screen.queryByText("Image from a new member")).toBeNull();
  });

  it("is a no-op without a provider", () => {
    renderWith(null);
    expect(screen.queryByText("Image from a new member")).toBeNull();
  });

  it("holds a blocked author's media without any provider", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <MutedPubkeysContext.Provider value={{ mutedPubkeys: new Set([STRANGER]), ready: true }}>
            <ChatContent event={message()} />
          </MutedPubkeysContext.Provider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Image from someone you blocked")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(container.querySelector(`img[src="${EMOJI}"]`)).not.toBeNull();
  });

  it("holds audio behind Load", () => {
    const audio = "https://blossom.example.com/v.ogg";
    const { container } = renderWith((pk) => pk === STRANGER, message(audio, [["imeta", `url ${audio}`, "m audio/ogg"]]));
    expect(screen.getByText("Audio from a new member")).toBeInTheDocument();
    expect(container.querySelector("audio")).toBeNull();
  });

  it("demotes a held link preview to a link, with a trailing Load", () => {
    const link = "https://news.example.com/story";
    renderWith((pk) => pk === STRANGER, message(`look ${link}`, []));
    expect(screen.getByRole("link", { name: link })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load previews" })).toBeInTheDocument();
  });

  it("holds a trusted sender's image on an unknown host, naming the host", () => {
    const { container } = renderWith(
      () => false,
      message(),
      (_pk, url) => !url.startsWith("https://emoji.example.com/"),
    );
    expect(container.querySelector("img[src*='x.jpg']")).toBeNull();
    expect(screen.getByText("Image on blossom.example.com")).toBeInTheDocument();
    // The sender isn't held, so their emoji still render.
    expect(container.querySelector(`img[src="${EMOJI}"]`)).not.toBeNull();
  });
});
