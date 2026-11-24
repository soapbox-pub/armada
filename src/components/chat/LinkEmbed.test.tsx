import { nip19 } from "nostr-tools";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  platform: "web",
  pluginAvailable: false,
  open: vi.fn(async (_options: { videoId: string }): Promise<void> => {}),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => native.platform,
    isNativePlatform: () => native.platform !== "web",
    isPluginAvailable: () => native.pluginAvailable,
  },
  registerPlugin: () => ({ open: native.open }),
}));

const preview = vi.hoisted(() => ({
  embed: null as RichEmbed | null,
  oembed: null as { title?: string; thumbnail_url?: string; thumbnail_width?: number; thumbnail_height?: number } | null,
}));

vi.mock("@/hooks/useLinkPreview", () => ({
  useLinkPreview: () => ({ data: preview.oembed, isLoading: false }),
  useRichEmbed: () => ({ data: preview.embed, isLoading: false }),
}));

const nostrData = vi.hoisted(() => ({
  addr: null as NostrRumor | null,
  event: null as NostrRumor | null,
  addrCalls: [] as unknown[][],
}));

vi.mock("@/hooks/useEvent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useEvent")>()),
  useAddrEvent: (...args: unknown[]) => {
    nostrData.addrCalls.push(args);
    return { data: args[0] ? nostrData.addr : null };
  },
  useEvent: (id: string | undefined) => ({ data: id ? nostrData.event : null }),
}));

vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));

vi.mock("@/hooks/useMediaPolicy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useMediaPolicy")>()),
  useMediaSrc: (src: string | undefined) => src,
}));

import { LinkEmbed, YouTubeEmbed } from "@/components/chat/LinkEmbed";
import { oembedDescription } from "@/lib/linkEmbed";
import type { NostrRumor } from "@/lib/nostrRumor";
import { BlueskyPostSchema, extractBlueskyPost, fromBlueskyPost, fromOEmbed, type RichEmbed } from "@/lib/richEmbed";

const BLUESKY_HTML =
  '<blockquote class="bluesky-embed"><p lang="en">discord casually admitting &amp; more</p>&mdash; ' +
  '<a href="https://bsky.app/profile/x">Gulumunkus</a></blockquote>' +
  '<script async src="https://embed.bsky.app/static/embed.js"></script>';

describe("oembedDescription", () => {
  it("reads the post text out of a blockquote embed", () => {
    expect(oembedDescription(BLUESKY_HTML)).toBe("discord casually admitting & more");
  });

  it("returns nothing for html with no quoted paragraphs", () => {
    expect(oembedDescription('<iframe src="https://example.com"></iframe>')).toBeUndefined();
    expect(oembedDescription(undefined)).toBeUndefined();
  });
});

describe("LinkPreview", () => {
  it("shows the post text and the whole image, not a cropped banner", () => {
    preview.embed = fromOEmbed({
      title: "Gulumunkus (@gulumunkus.bsky.social)",
      author_name: "Gulumunkus (@gulumunkus.bsky.social)",
      provider_name: "Bluesky Social",
      html: BLUESKY_HTML,
      thumbnail_url: "https://cdn.example/img.jpg",
      thumbnail_width: 600,
      thumbnail_height: 806,
    });
    render(<LinkEmbed url="https://bsky.app/profile/x/post/y" />);

    expect(screen.getByText("discord casually admitting & more")).toBeInTheDocument();
    // The author line is dropped when it only repeats the title.
    expect(screen.getAllByText("Gulumunkus (@gulumunkus.bsky.social)")).toHaveLength(1);

    const img = screen.getByRole("button", { name: "View image" }).querySelector("img")!;
    expect(img.className).not.toContain("max-h-[180px]");
    // 600×806 fitted into 400×320 without distortion.
    expect(img.style.aspectRatio).toBe("600 / 806");
    expect(img.style.width).toBe("238px");
  });

  it("opens the image in the lightbox instead of following the link", () => {
    preview.embed = fromOEmbed({
      title: "Artwork",
      thumbnail_url: "https://cdn.example/art.jpg",
      thumbnail_width: 849,
      thumbnail_height: 1200,
    });
    render(<LinkEmbed url="https://example.com/art" />);

    // fireEvent returns false when the default (following the link) was prevented.
    expect(fireEvent.click(screen.getByRole("button", { name: "View image" }))).toBe(false);
    expect(document.querySelector("[data-lightbox-content]")).toBeInTheDocument();
  });

  it("shows a small image as a side thumbnail", () => {
    preview.embed = fromOEmbed({
      title: "A repo",
      thumbnail_url: "https://cdn.example/logo.png",
      thumbnail_width: 128,
      thumbnail_height: 128,
    });
    render(<LinkEmbed url="https://example.com/repo" />);
    expect(screen.getByRole("button", { name: "View image" }).querySelector("img")!.className).toContain("size-20");
  });

  it("shows a Bluesky post's counts, every image and a timestamped footer", () => {
    preview.embed = fromBlueskyPost(
      BlueskyPostSchema.parse({
        author: { handle: "gulumunkus.bsky.social", displayName: "Gulumunkus", avatar: "https://cdn.example/a.jpg" },
        record: { text: "post body" },
        embed: {
          $type: "app.bsky.embed.images#view",
          images: [
            { thumb: "https://cdn.example/1.jpg", fullsize: "https://cdn.example/1-full.jpg", aspectRatio: { width: 600, height: 806 } },
            { thumb: "https://cdn.example/2.jpg" },
          ],
        },
        repostCount: 1318,
        likeCount: 4149,
        quoteCount: 110,
        indexedAt: "2026-09-24T02:39:31.757Z",
      }),
    );
    render(<LinkEmbed url="https://bsky.app/profile/gulumunkus.bsky.social/post/3mwaa3bueuk2z" />);

    expect(screen.getByText("Gulumunkus (@gulumunkus.bsky.social)")).toBeInTheDocument();
    expect(screen.getByText("post body")).toBeInTheDocument();
    expect(screen.getByText("Likes").nextSibling).toHaveTextContent((4149).toLocaleString());
    expect(screen.getByText("Reposts")).toBeInTheDocument();
    expect(screen.getByText("Quotes")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "View image" })).toHaveLength(2);
    expect(screen.getByText(/^Bluesky •/)).toBeInTheDocument();
  });

  it("recognizes only bsky.app post URLs", () => {
    expect(extractBlueskyPost("https://bsky.app/profile/a.bsky.social/post/3mwaa3bueuk2z")).toEqual({
      actor: "a.bsky.social",
      rkey: "3mwaa3bueuk2z",
    });
    expect(extractBlueskyPost("https://bsky.app/profile/did:plc:abc/post/3m")).toEqual({ actor: "did:plc:abc", rkey: "3m" });
    expect(extractBlueskyPost("https://bsky.app/profile/a.bsky.social")).toBeNull();
    expect(extractBlueskyPost("https://evil.example/profile/a/post/b")).toBeNull();
  });

  it("drops the media of a Bluesky post labelled adult", () => {
    const embed = fromBlueskyPost(
      BlueskyPostSchema.parse({
        author: { handle: "a.bsky.social" },
        record: { text: "x" },
        embed: { $type: "app.bsky.embed.images#view", images: [{ thumb: "https://cdn.example/1.jpg" }] },
        labels: [{ val: "porn" }],
      }),
    );
    expect(embed.images).toEqual([]);
  });
});

beforeEach(() => {
  native.platform = "web";
  native.pluginAvailable = false;
  native.open.mockClear().mockResolvedValue();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("YouTubeEmbed", () => {
  it("does not contact YouTube until the viewer clicks play", () => {
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    expect(screen.queryByTitle("YouTube video")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Play video" })).toBeInTheDocument();
  });

  it("lets the browser identify the deployment that actually hosts Armada", () => {
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    const iframe = screen.getByTitle<HTMLIFrameElement>("YouTube video");
    expect(iframe).toHaveAttribute("referrerpolicy", "strict-origin-when-cross-origin");

    const playerUrl = new URL(iframe.src);
    expect(playerUrl.origin).toBe("https://www.youtube-nocookie.com");
    expect(playerUrl.searchParams.get("origin")).toBeNull();
    expect(iframe.outerHTML).not.toContain("buzz.armada.app");
  });

  it("keeps Capacitor Android on the HTTPS-referrer iframe path", () => {
    native.platform = "android";
    native.pluginAvailable = true;
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    expect(screen.getByTitle("YouTube video")).toHaveAttribute(
      "referrerpolicy",
      "strict-origin-when-cross-origin",
    );
    expect(native.open).not.toHaveBeenCalled();
  });

  it("uses the referrer-bearing native player on Capacitor iOS", async () => {
    native.platform = "ios";
    native.pluginAvailable = true;
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    await waitFor(() => expect(native.open).toHaveBeenCalledWith({ videoId: "dQw4w9WgXcQ" }));
    expect(screen.queryByTitle("YouTube video")).not.toBeInTheDocument();
  });

  it("offers a user-activated watch-page fallback when native presentation fails", async () => {
    native.platform = "ios";
    native.pluginAvailable = true;
    native.open.mockRejectedValue(new Error("presentation failed"));
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    const fallback = await screen.findByRole("button", { name: "Open video on YouTube" });
    expect(openWindow).not.toHaveBeenCalled();
    fireEvent.click(fallback);
    expect(openWindow).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("opens the watch page instead of a broken iframe on older iOS builds", () => {
    native.platform = "ios";
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<YouTubeEmbed videoId="dQw4w9WgXcQ" />);

    fireEvent.click(screen.getByRole("button", { name: "Play video" }));

    expect(openWindow).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "_blank",
      "noopener,noreferrer",
    );
    expect(screen.queryByTitle("YouTube video")).not.toBeInTheDocument();
  });
});

describe("GIF page links", () => {
  it("plays a Tenor page's GIF instead of a page card", () => {
    preview.oembed = {
      title: "Mbison Street Fighter GIF",
      thumbnail_url: "https://api.ditto.pub/link-preview-image/https%3A%2F%2Fmedia.tenor.com%2FNSnx2uRkjAEAAAAN%2Fmbison-bison.png",
      thumbnail_width: 220,
      thumbnail_height: 124,
    };
    const { container } = render(
      <LinkEmbed url="https://tenor.com/view/mbison-bison-street-fighter-yes-anime-gif-3830858880492276737" />,
    );
    preview.oembed = null;
    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe("https://media.tenor.com/NSnx2uRkjAEAAAPo/mbison-bison.mp4");
    expect(video?.hasAttribute("loop")).toBe(true);
  });
});

describe("provider iframe embeds", () => {
  const TWEET = "https://x.com/someone/status/1234567890";

  afterEach(() => vi.useRealTimers());

  it("falls back to a plain link when the frame never reports in", () => {
    vi.useFakeTimers();
    render(<LinkEmbed url={TWEET} />);
    fireEvent.load(screen.getByTitle("Tweet"));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.queryByTitle("Tweet")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: TWEET })).toHaveAttribute("href", TWEET);
  });

  it("keeps a frame that posted its resize", () => {
    vi.useFakeTimers();
    render(<LinkEmbed url={TWEET} />);
    const iframe = screen.getByTitle("Tweet") as HTMLIFrameElement;
    fireEvent.load(iframe);
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://platform.twitter.com",
          source: iframe.contentWindow,
          data: { "twttr.embed": { method: "twttr.private.resize", params: [{ height: 400 }] } },
        }),
      );
    });
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByTitle("Tweet")).toBeInTheDocument();
  });
});

describe("PeerTube embeds", () => {
  const LINK = "https://framatube.org/w/e6TjfMBXc5jAsLs1co4zHh";
  const API = "https://framatube.org/api/v1/videos/e6TjfMBXc5jAsLs1co4zHh";
  const respond = (body: object) =>
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

  it("asks the instance nothing until play, then plays its MP4 from that one click", async () => {
    const fetchSpy = respond({ files: [{ fileUrl: "https://framatube.org/v-720.mp4", resolution: { id: 720 } }] });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const { container } = render(<LinkEmbed url={LINK} />);
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Play video from framatube.org" }));
    await waitFor(() => expect(container.querySelector("video")).toHaveAttribute("src", "https://framatube.org/v-720.mp4"));
    expect(fetchSpy.mock.calls[0][0]).toBe(API);
    expect(play).toHaveBeenCalledTimes(1);
    expect(container.querySelector("video")!.muted).toBe(false);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("opens the PeerTube page when there is only HLS", async () => {
    respond({ files: [], streamingPlaylists: [{ playlistUrl: "https://framatube.org/m.m3u8", files: [] }] });
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<LinkEmbed url={LINK} />);

    fireEvent.click(screen.getByRole("button", { name: "Play video from framatube.org" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(LINK, "_blank", "noopener,noreferrer"));
    expect(screen.getByRole("link", { name: "Open on framatube.org" })).toHaveAttribute("href", LINK);
  });
});

describe("GitWorkshop links", () => {
  const OWNER = "a".repeat(64);
  const NPUB = "npub1424242424242424242424242424242424242424242424242424qamrcaj";
  const REPO_URL = `https://gitworkshop.dev/${NPUB}/relay.ngit.dev/armada`;

  beforeEach(() => {
    // The site's generic page card must not be what's shown.
    preview.embed = { provider: "gitworkshop.dev", title: "gitworkshop.dev", images: [{ thumb: "https://gitworkshop.dev/og.png" }] };
    nostrData.addr = null;
    nostrData.event = null;
    nostrData.addrCalls = [];
  });
  afterEach(cleanup);

  it("names the repository from the URL before its announcement arrives", () => {
    render(<LinkEmbed url={REPO_URL} />);
    expect(screen.getByText("armada")).toBeInTheDocument();
    expect(screen.getByText("Repository")).toBeInTheDocument();
    expect(screen.queryByText("gitworkshop.dev")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View image" })).not.toBeInTheDocument();
    expect(nostrData.addrCalls[0]?.[0]).toEqual({ kind: 30617, pubkey: OWNER, identifier: "armada" });
    expect(nostrData.addrCalls[0]?.[1]).toEqual(["wss://relay.ngit.dev"]);
  });

  it("shows the announced name and description", () => {
    nostrData.addr = {
      id: "b".repeat(64),
      pubkey: OWNER,
      created_at: 1,
      kind: 30617,
      content: "",
      tags: [["d", "armada"], ["name", "Armada"], ["description", "Serverless communities"]],
    };
    render(<LinkEmbed url={REPO_URL} />);
    expect(screen.getByText("Armada")).toBeInTheDocument();
    expect(screen.getByText("Serverless communities")).toBeInTheDocument();
  });

  it("labels a repository's pull request list", () => {
    render(<LinkEmbed url={`https://gitworkshop.dev/${NPUB}/armada/prs`} />);
    expect(screen.getByText("Pull requests")).toBeInTheDocument();
    expect(screen.getByText("armada")).toBeInTheDocument();
  });

  it("titles a pull request page with its subject", () => {
    nostrData.event = {
      id: "c".repeat(64),
      pubkey: "d".repeat(64),
      created_at: 1,
      kind: 1618,
      content: "",
      tags: [["a", `30617:${OWNER}:armada`], ["subject", "Show repo names in link previews"]],
    };
    const note = nip19.noteEncode("c".repeat(64));
    render(<LinkEmbed url={`https://gitworkshop.dev/${NPUB}/armada/prs/${note}/files`} />);
    expect(screen.getByText("Show repo names in link previews")).toBeInTheDocument();
    expect(screen.getByText("Pull request")).toBeInTheDocument();
    expect(screen.getByText("armada")).toBeInTheDocument();
  });

  it("leaves GitWorkshop's own pages to the generic card", () => {
    preview.embed = { provider: "gitworkshop.dev", title: "Quick start", images: [] };
    render(<LinkEmbed url="https://gitworkshop.dev/quick-start" />);
    expect(screen.getByText("Quick start")).toBeInTheDocument();
  });
});
