import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NostrEvent } from "@nostrify/nostrify";

/**
 * Chat's Discord-flavored block markdown, end to end through ChatContent:
 * headings and lists render as such without the document flag, the deeper
 * heading levels stay document-only, and a fenced block with a language comes
 * out highlighted.
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

import { ChatContent } from "@/components/chat/ChatContent";

afterEach(cleanup);

let nextId = 0;

/** A minimal kind-9 carrying `content`, with an id unique per call so the
 *  module-level token cache never answers for another test's body. */
function message(content: string): NostrEvent {
  return {
    id: (nextId++).toString(16).padStart(64, "0"),
    pubkey: "b".repeat(64),
    created_at: 1700000000,
    kind: 9,
    tags: [],
    content,
    sig: "0".repeat(128),
  };
}

function renderContent(content: string, documentMarkdown = false, everyoneMention = false) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ChatContent event={message(content)} documentMarkdown={documentMarkdown} everyoneMention={everyoneMention} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChatContent chat markdown", () => {
  it("renders # / ## / ### headings in a chat message", () => {
    const { container } = renderContent("# Title\n## Subtitle\n### Section\nbody **bold**");
    const headings = Array.from(container.querySelectorAll('[role="heading"]'));
    expect(headings.map((h) => h.getAttribute("aria-level"))).toEqual(["1", "2", "3"]);
    expect(headings.map((h) => h.textContent)).toEqual(["Title", "Subtitle", "Section"]);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
  });

  it("keeps a level-4 heading literal in chat and renders it in document mode", () => {
    const chat = renderContent("#### deep");
    expect(chat.container.querySelector('[role="heading"]')).toBeNull();
    expect(chat.container.textContent).toContain("#### deep");
    cleanup();
    const doc = renderContent("#### deep", true);
    expect(doc.container.querySelector('[role="heading"]')?.getAttribute("aria-level")).toBe("4");
  });

  it("renders bullet and numbered lists in a chat message", () => {
    const { container } = renderContent("- one\n- two\n\n1. first\n2. second");
    expect(Array.from(container.querySelectorAll("ul > li")).map((li) => li.textContent)).toEqual(["one", "two"]);
    expect(Array.from(container.querySelectorAll("ol > li")).map((li) => li.textContent)).toEqual(["first", "second"]);
  });

  it("renders a nested list inside its parent item", () => {
    const { container } = renderContent("- one\n  - inner **bold**\n- two");
    const outer = container.querySelector("ul")!;
    expect(Array.from(outer.querySelectorAll(":scope > li")).length).toBe(2);
    const inner = outer.querySelector(":scope > li > ul");
    expect(inner?.textContent).toBe("inner bold");
    expect(inner?.querySelector("strong")?.textContent).toBe("bold");
  });

  it("leaves a hashtag alone", () => {
    const { container } = renderContent("#nostr is neat");
    expect(container.querySelector('[role="heading"]')).toBeNull();
    expect(container.textContent).toContain("#nostr is neat");
  });

  it("highlights a fenced block that names a language", async () => {
    const { container } = renderContent('```json\n{"name": "Eduardo"}\n```');
    const pre = container.querySelector("pre");
    expect(pre?.dataset.lang).toBe("json");
    await waitFor(() => expect(pre?.querySelector(".hljs-attr")).not.toBeNull());
    expect(pre?.textContent).toBe('{"name": "Eduardo"}');
  });

  it("chips an authorized @everyone but leaves code and unauthorized text literal", () => {
    const authorized = renderContent("Heads up @everyone\n`@everyone`", false, true);
    const chips = authorized.container.querySelectorAll(".bg-primary\\/15");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe("@everyone");
    expect(authorized.container.querySelector("code")?.textContent).toBe("@everyone");
    cleanup();

    const unauthorized = renderContent("Heads up @everyone");
    expect(unauthorized.container.querySelector(".bg-primary\\/15")).toBeNull();
    expect(unauthorized.container.textContent).toContain("@everyone");
  });

  it("formats across a link and inline code", () => {
    const { container } = renderContent("**see https://example.com/page and `x`** after");
    const strong = container.querySelector("strong");
    expect(strong?.querySelector("a")?.getAttribute("href")).toBe("https://example.com/page");
    expect(strong?.querySelector("code")?.textContent).toBe("x");
    expect(container.textContent).not.toContain("**");
  });

  it("renders a [text](url) link in a chat message, showing a spoofed host", () => {
    const { container } = renderContent("see [the docs](https://example.com/docs) and [github.com](https://evil.example/x)");
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.com/docs", "https://evil.example/x"]);
    expect(links[0].textContent).toBe("the docs (example.com)");
    expect(links[0].querySelector(".touch\\:inline")?.textContent).toBe(" (example.com)");
    expect(links[1].textContent).toBe("github.com (evil.example)");
    expect(container.textContent).not.toContain("](");
  });

  it("shows a [text](url) link's full URL in a tooltip on focus", async () => {
    const { container, findByRole } = renderContent("[click](https://evil.example/claim?x=1)");
    act(() => container.querySelector("a")!.focus());
    expect((await findByRole("tooltip")).textContent).toBe("https://evil.example/claim?x=1");
  });

  it("renders blocks inside a quote, nested quotes, and a divider", () => {
    const { container } = renderContent("> ## Inside\n> - item\n>> deeper\n\n---\nafter");
    const quote = container.querySelector("blockquote");
    expect(quote?.querySelector('[role="heading"]')?.textContent).toBe("Inside");
    expect(quote?.querySelector("li")?.textContent).toBe("item");
    expect(quote?.querySelector("blockquote")?.textContent).toBe("deeper");
    expect(container.querySelector("hr")).not.toBeNull();
  });

  it("drops the backslash of an escape", () => {
    const { container } = renderContent("\\*not italic\\*");
    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe("*not italic*");
  });
});
