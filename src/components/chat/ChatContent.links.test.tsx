import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";
import type { AppConfig, AppContextType } from "@/contexts/AppContext";
import type { NostrEvent } from "@nostrify/nostrify";

/**
 * The VIEW half of link canonicalization: that the renderer strips tracking
 * parameters from a URL before it reaches an `href`, and that the setting
 * actually turns it off. `trackingParams.test.ts` covers which parameters go;
 * this covers the wiring, which is the part that can silently come undone.
 *
 * Links are kept mid-sentence on purpose — a URL alone on a line tokenizes as a
 * `link-embed`, which mounts the preview card and would fetch.
 */

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({
  useScopedDisplayName: (pubkey?: string) => (pubkey ?? "").slice(0, 8),
  useScopedIdentity: (pubkey?: string) => ({ displayName: (pubkey ?? "").slice(0, 8) }),
}));
vi.mock("@/hooks/useMentionNameMap", () => ({
  useMentionNameMap: () => ({ byName: new Map(), regex: null }),
}));
vi.mock("@/hooks/useCustomEmojis", () => ({
  useCustomEmojis: () => ({ emojis: [], isLoading: false }),
}));

import { AppContext, defaultConfig } from "@/contexts/AppContext";
import { ChatContent } from "@/components/chat/ChatContent";

afterEach(cleanup);

let nextId = 0;

/** A minimal kind-9 carrying `content`, with an id unique per call so the
 *  module-level token cache never answers for another test's body. */
function message(content: string): NostrEvent {
  return {
    id: (nextId++).toString(16).padStart(64, "0"),
    pubkey: "a".repeat(64),
    created_at: 1700000000,
    kind: 9,
    tags: [],
    content,
    sig: "0".repeat(128),
  };
}

function renderContent(content: string, config?: Partial<AppConfig>) {
  const wrap = (children: ReactNode) =>
    config
      ? (
        <AppContext.Provider
          value={
            {
              config: { ...defaultConfig, ...config },
              updateConfig: () => {},
            } as unknown as AppContextType
          }
        >
          {children}
        </AppContext.Provider>
      )
      : children;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{wrap(<ChatContent event={message(content)} />)}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The `href`s of every rendered link, in order. */
function hrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
}

describe("ChatContent link canonicalization", () => {
  it("strips a YouTube share id from a rendered link", () => {
    const { container } = renderContent("watch https://youtu.be/dQw4w9WgXcQ?si=aBcDeFgH now");
    expect(hrefs(container)).toEqual(["https://youtu.be/dQw4w9WgXcQ"]);
  });

  it("strips campaign tags while keeping the rest of the query", () => {
    const { container } = renderContent(
      "see https://example.com/post?id=7&utm_source=news&utm_medium=email here",
    );
    expect(hrefs(container)).toEqual(["https://example.com/post?id=7"]);
  });

  it("leaves an untracked link untouched", () => {
    const { container } = renderContent("see https://example.com/post?id=7 here");
    expect(hrefs(container)).toEqual(["https://example.com/post?id=7"]);
  });

  it("renders the URL as it arrived when the setting is off", () => {
    const { container } = renderContent(
      "watch https://youtu.be/dQw4w9WgXcQ?si=aBcDeFgH now",
      { stripTrackingParams: false },
    );
    expect(hrefs(container)).toEqual(["https://youtu.be/dQw4w9WgXcQ?si=aBcDeFgH"]);
  });

  it("keeps the surrounding text and the sentence's punctuation", () => {
    const { container } = renderContent("watch https://youtu.be/abc12345678?si=xy, then reply");
    expect(container.textContent).toContain("watch ");
    expect(container.textContent).toContain(", then reply");
    expect(hrefs(container)).toEqual(["https://youtu.be/abc12345678"]);
  });

  it("ends a Discord-style <url> at the bracket and hides the brackets", () => {
    const { container } = renderContent("see <https://example.com/post?id=7> here");
    expect(hrefs(container)).toEqual(["https://example.com/post?id=7"]);
    expect(container.textContent).toBe("see https://example.com/post?id=7 here");
  });

  it("renders a bracketed link alone on its line inline, without a preview card", () => {
    const { container } = renderContent("<https://example.com/post>");
    expect(hrefs(container)).toEqual(["https://example.com/post"]);
    expect(container.textContent).toBe("https://example.com/post");
  });

  it("keeps an unmatched bracket as text", () => {
    const { container } = renderContent("see <https://example.com/post here");
    expect(hrefs(container)).toEqual(["https://example.com/post"]);
    expect(container.textContent).toContain("see <");
  });

  it("defaults to stripping when mounted without an AppProvider", () => {
    const { container } = renderContent("watch https://youtu.be/dQw4w9WgXcQ?si=aBcDeFgH now");
    expect(hrefs(container)).toEqual(["https://youtu.be/dQw4w9WgXcQ"]);
  });
});

describe("ChatContent magnet links", () => {
  const MAGNET =
    "magnet:?xt=urn:btih:D0F23C109D8662A3FE9338F75839AF8D57E5D4A9&dn=Ubuntu+MATE+16.04.2&tr=udp%3A%2F%2Ftracker.openbittorrent.com%3A80%2Fannounce";

  it("links the whole URI, mid-sentence, leaving trailing punctuation as text", () => {
    const { container } = renderContent(`grab ${MAGNET}. thanks`);
    expect(hrefs(container)).toEqual([MAGNET]);
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe(MAGNET);
    // No new window: the click is a top-frame navigation, the one path the desktop shell hands on.
    expect(link.hasAttribute("target")).toBe(false);
    expect(container.textContent).toContain(". thanks");
  });

  it("leaves a closing quote around the URI as text", () => {
    const { container } = renderContent(`try "${MAGNET}"`);
    expect(hrefs(container)).toEqual([MAGNET]);
    expect(container.textContent).toContain(`"${MAGNET}"`);
  });

  it("leaves a magnet: that names no content hash as text", () => {
    const { container } = renderContent("magnet:?dn=nothing-here");
    expect(hrefs(container)).toEqual([]);
    expect(container.textContent).toContain("magnet:?dn=nothing-here");
  });
});

describe("ChatContent nsite links", () => {
  const NSITE = "nsite://npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg/docs";

  it("links the URL as a top-frame navigation, leaving trailing punctuation as text", () => {
    const { container } = renderContent(`see ${NSITE}. thanks`);
    expect(hrefs(container)).toEqual([NSITE]);
    const link = container.querySelector("a")!;
    expect(link.textContent).toBe(NSITE);
    expect(link.hasAttribute("target")).toBe(false);
    expect(container.textContent).toContain(". thanks");
  });

  it("leaves an nsite: URL that names no key as text", () => {
    const { container } = renderContent("see nsite://example.com/ now");
    expect(hrefs(container)).toEqual([]);
    expect(container.textContent).toContain("nsite://example.com/");
  });
});
