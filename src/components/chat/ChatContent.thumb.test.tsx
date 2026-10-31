import { cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";


/**
 * An image with a sender-made preview (imeta `thumb`) loads the preview in the
 * timeline and the full image only when it is opened.
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
vi.mock("@/hooks/useCustomEmojis", () => ({
  useCustomEmojis: () => ({ emojis: [], isLoading: false }),
}));

import { ChatContent } from "@/components/chat/ChatContent";

afterEach(cleanup);

const IMAGE = "https://blossom.example.com/" + "a".repeat(64) + ".jpg";
const THUMB = "https://blossom.example.com/" + "b".repeat(64) + ".jpg";

let seq = 0;
function renderImage(tags: string[][]) {
  // Distinct ids: ChatContent memoizes its parse per event.
  const id = String(++seq).padStart(64, "0");
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ChatContent
          event={{ id, pubkey: "c".repeat(64), created_at: 1700000000, kind: 9, tags, content: IMAGE }}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const srcs = (root: ParentNode) => [...root.querySelectorAll("img")].map((img) => img.getAttribute("src"));

describe("ChatContent image previews", () => {
  it("shows the preview inline and the full image in the lightbox", () => {
    const { container } = renderImage([["imeta", `url ${IMAGE}`, "m image/jpeg", `thumb ${THUMB}`]]);
    expect(srcs(container)).toEqual([THUMB]);
    fireEvent.click(container.querySelector("button")!);
    expect(srcs(document.body)).toContain(IMAGE);
  });

  it("falls back to the image when the preview won't load", () => {
    const { container } = renderImage([["imeta", `url ${IMAGE}`, "m image/jpeg", `thumb ${THUMB}`]]);
    // The preview fails on its host and on every mirror of its blob.
    for (let i = 0; i < 10 && !srcs(container).includes(IMAGE); i++) {
      fireEvent.error(container.querySelector("img")!);
    }
    expect(srcs(container)).toEqual([IMAGE]);
  });

  it("loads the image itself without a preview", () => {
    const { container } = renderImage([["imeta", `url ${IMAGE}`, "m image/jpeg"]]);
    expect(srcs(container)).toEqual([IMAGE]);
  });
});

describe("ChatContent unsized images", () => {
  it("takes the image's own shape once it loads, rather than keeping the 4:3 placeholder", () => {
    const url = "https://example.com/" + "d".repeat(16) + ".png";
    const id = String(++seq).padStart(64, "0");
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <ChatContent event={{ id, pubkey: "c".repeat(64), created_at: 1700000000, kind: 9, tags: [], content: `look ${url} here` }} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const img = container.querySelector("img")!;
    const box = img.parentElement!;
    expect(box.style.aspectRatio).toBe("4 / 3");

    Object.defineProperty(img, "naturalWidth", { value: 1000, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 250, configurable: true });
    fireEvent.load(img);

    expect(box.style.aspectRatio).toBe("1000 / 250");
  });
});
