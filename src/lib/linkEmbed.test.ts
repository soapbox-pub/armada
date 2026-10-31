import { describe, expect, it } from "vitest";

import {
  extractInstagramShortcode,
  extractStreamableId,
  giphyMp4FromPageUrl,
  isTenorPageUrl,
  odyseeEmbedUrl,
  peerTubeApiUrl,
  pickPeerTubeFile,
  tenorMp4FromThumbnail,
  youTubeStartSeconds,
} from "@/lib/linkEmbed";

describe("extractInstagramShortcode", () => {
  it("reads the shortcode from a post URL", () => {
    expect(extractInstagramShortcode("https://www.instagram.com/p/CxYz-123_ab/")).toBe(
      "CxYz-123_ab",
    );
  });

  it("handles reels, reels-plural and IGTV paths", () => {
    expect(extractInstagramShortcode("https://instagram.com/reel/AbC123/")).toBe("AbC123");
    expect(extractInstagramShortcode("https://instagram.com/reels/AbC123/")).toBe("AbC123");
    expect(extractInstagramShortcode("https://instagram.com/tv/AbC123/")).toBe("AbC123");
  });

  it("handles the profile-prefixed form", () => {
    expect(extractInstagramShortcode("https://www.instagram.com/someuser/p/CxYz123/")).toBe(
      "CxYz123",
    );
  });

  it("accepts m., instagr.am and the front-end mirrors", () => {
    expect(extractInstagramShortcode("https://m.instagram.com/p/CxYz123/")).toBe("CxYz123");
    expect(extractInstagramShortcode("https://instagr.am/p/CxYz123/")).toBe("CxYz123");
    expect(extractInstagramShortcode("https://ddinstagram.com/p/CxYz123/")).toBe("CxYz123");
    expect(extractInstagramShortcode("https://instagramez.com/p/CxYz123/")).toBe("CxYz123");
  });

  it("returns null for non-post Instagram URLs and other hosts", () => {
    expect(extractInstagramShortcode("https://www.instagram.com/someuser/")).toBeNull();
    expect(extractInstagramShortcode("https://www.instagram.com/")).toBeNull();
    expect(extractInstagramShortcode("https://example.com/p/CxYz123/")).toBeNull();
    expect(extractInstagramShortcode("not a url")).toBeNull();
  });
});

describe("extractStreamableId", () => {
  it("reads the id from a share URL", () => {
    expect(extractStreamableId("https://streamable.com/abc123")).toBe("abc123");
    expect(extractStreamableId("https://www.streamable.com/abc123")).toBe("abc123");
  });

  it("reads the id from an embed URL", () => {
    expect(extractStreamableId("https://streamable.com/e/abc123")).toBe("abc123");
  });

  it("ignores trailing path and query", () => {
    expect(extractStreamableId("https://streamable.com/abc123?t=5")).toBe("abc123");
    expect(extractStreamableId("https://streamable.com/e/abc123/")).toBe("abc123");
  });

  it("returns null for other hosts and non-URLs", () => {
    expect(extractStreamableId("https://example.com/abc123")).toBeNull();
    expect(extractStreamableId("https://streamable.com/")).toBeNull();
    expect(extractStreamableId("not a url")).toBeNull();
  });
});

describe("Tenor page links", () => {
  it("recognizes tenor.com/view pages, with or without a locale", () => {
    expect(isTenorPageUrl("https://tenor.com/view/mbison-bison-street-fighter-yes-anime-gif-3830858880492276737")).toBe(true);
    expect(isTenorPageUrl("https://tenor.com/en-GB/view/foo-gif-123")).toBe(true);
    expect(isTenorPageUrl("https://tenor.com/search/cats")).toBe(false);
    expect(isTenorPageUrl("https://nottenor.com/view/foo-gif-123")).toBe(false);
  });

  it("derives the MP4 from the preview proxy's wrapped thumbnail", () => {
    expect(
      tenorMp4FromThumbnail(
        "https://api.ditto.pub/link-preview-image/https%3A%2F%2Fmedia.tenor.com%2FNSnx2uRkjAEAAAAN%2Fmbison-bison.png",
      ),
    ).toBe("https://media.tenor.com/NSnx2uRkjAEAAAPo/mbison-bison.mp4");
  });

  it("derives the MP4 from a bare media thumbnail, incl. the /m/ form", () => {
    expect(tenorMp4FromThumbnail("https://media1.tenor.com/m/NSnx2uRkjAEAAAAC/mbison-bison.gif"))
      .toBe("https://media.tenor.com/NSnx2uRkjAEAAAPo/mbison-bison.mp4");
  });

  it("refuses thumbnails that are not Tenor media", () => {
    expect(tenorMp4FromThumbnail("https://example.com/NSnx2uRkjAEAAAAN/x.png")).toBeNull();
    expect(tenorMp4FromThumbnail(undefined)).toBeNull();
  });
});

describe("giphyMp4FromPageUrl", () => {
  it("derives the MP4 from a gif page's id", () => {
    expect(giphyMp4FromPageUrl("https://giphy.com/gifs/cat-funny-JIX9t2j0ZTN9S"))
      .toBe("https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4");
    expect(giphyMp4FromPageUrl("https://giphy.com/gifs/JIX9t2j0ZTN9S"))
      .toBe("https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.mp4");
    expect(giphyMp4FromPageUrl("https://giphy.com/explore/cats")).toBeNull();
  });
});

describe("odyseeEmbedUrl", () => {
  it("embeds channel and channel-less claim pages", () => {
    expect(odyseeEmbedUrl("https://odysee.com/@Odysee:8/odysee-is-live:a")).toBe(
      "https://odysee.com/$/embed/@Odysee:8/odysee-is-live:a",
    );
    expect(odyseeEmbedUrl("https://odysee.com/some-video:5?r=abc")).toBe(
      "https://odysee.com/$/embed/some-video:5",
    );
    expect(odyseeEmbedUrl("https://odysee.com/$/embed/@a:1/b:2")).toBe("https://odysee.com/$/embed/@a:1/b:2");
  });

  it("keeps a numeric start time", () => {
    expect(odyseeEmbedUrl("https://odysee.com/@a:1/b:2?t=90")).toBe("https://odysee.com/$/embed/@a:1/b:2?t=90");
    expect(odyseeEmbedUrl("https://odysee.com/@a:1/b:2?t=x")).toBe("https://odysee.com/$/embed/@a:1/b:2");
  });

  it("returns null for channel pages, app routes and other hosts", () => {
    expect(odyseeEmbedUrl("https://odysee.com/@Odysee:8")).toBeNull();
    expect(odyseeEmbedUrl("https://odysee.com/$/rewards")).toBeNull();
    expect(odyseeEmbedUrl("https://odysee.com/")).toBeNull();
    expect(odyseeEmbedUrl("https://example.com/some-video:5")).toBeNull();
  });
});

describe("peerTubeApiUrl", () => {
  it("reads short-UUID, UUID and embed links on any instance", () => {
    expect(peerTubeApiUrl("https://framatube.org/w/9c9de5e8-0a1e-484a-b099-e80766180a6d")).toBe(
      "https://framatube.org/api/v1/videos/9c9de5e8-0a1e-484a-b099-e80766180a6d",
    );
    expect(peerTubeApiUrl("https://tilvids.com/w/kkGMgK9ZtnKfYAgnEtQxbv?start=10s")).toBe(
      "https://tilvids.com/api/v1/videos/kkGMgK9ZtnKfYAgnEtQxbv",
    );
    expect(peerTubeApiUrl("https://peertube.tv/videos/watch/kkGMgK9ZtnKfYAgnEtQxbv")).toBe(
      "https://peertube.tv/api/v1/videos/kkGMgK9ZtnKfYAgnEtQxbv",
    );
    expect(peerTubeApiUrl("https://peertube.tv/videos/embed/kkGMgK9ZtnKfYAgnEtQxbv")).toBe(
      "https://peertube.tv/api/v1/videos/kkGMgK9ZtnKfYAgnEtQxbv",
    );
  });

  it("returns null for other paths, non-ids and plain http", () => {
    expect(peerTubeApiUrl("https://framatube.org/w/p/kkGMgK9ZtnKfYAgnEtQxbv")).toBeNull();
    expect(peerTubeApiUrl("https://example.com/w/hello")).toBeNull();
    expect(peerTubeApiUrl("http://tilvids.com/w/kkGMgK9ZtnKfYAgnEtQxbv")).toBeNull();
    expect(peerTubeApiUrl("not a url")).toBeNull();
  });
});

describe("pickPeerTubeFile", () => {
  const f = (id: number, extra: object = {}) => ({ fileUrl: `https://x.test/${id}.mp4`, resolution: { id }, ...extra });

  it("picks the largest muxed rendition up to 720p across Web Videos and HLS", () => {
    const video = {
      files: [f(0, { hasVideo: false })],
      streamingPlaylists: [{ files: [f(1080), f(720), f(480)] }],
    };
    expect(pickPeerTubeFile(video)?.fileUrl).toBe("https://x.test/720.mp4");
  });

  it("falls back to the smallest above 720p", () => {
    expect(pickPeerTubeFile({ files: [f(2160), f(1080)] })?.fileUrl).toBe("https://x.test/1080.mp4");
  });

  it("skips audio-only, split video-only, non-MP4 and non-https files", () => {
    expect(
      pickPeerTubeFile({
        files: [
          { fileUrl: "http://x.test/480.mp4", resolution: { id: 480 } },
          { fileUrl: "https://x.test/480.m3u8", resolution: { id: 480 } },
        ],
        streamingPlaylists: [{ files: [f(720, { hasAudio: false }), f(0)] }],
      }),
    ).toBeNull();
    expect(pickPeerTubeFile({})).toBeNull();
  });

  it("drops malformed files and rejects a non-video response", () => {
    expect(pickPeerTubeFile({ files: [{ fileUrl: 1 }, null, f(480)] })?.fileUrl).toBe("https://x.test/480.mp4");
    expect(pickPeerTubeFile({ files: "x" })).toBeNull();
    expect(pickPeerTubeFile(null)).toBeNull();
  });
});

describe("youTubeStartSeconds", () => {
  it("reads every start-time spelling YouTube links carry", () => {
    expect(youTubeStartSeconds("https://youtu.be/dQw4w9WgXcQ?t=90")).toBe(90);
    expect(youTubeStartSeconds("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s")).toBe(90);
    expect(youTubeStartSeconds("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1h2m3s")).toBe(3723);
    expect(youTubeStartSeconds("https://www.youtube.com/embed/dQw4w9WgXcQ?start=42")).toBe(42);
    expect(youTubeStartSeconds("https://www.youtube.com/watch?v=dQw4w9WgXcQ#t=15s")).toBe(15);
  });

  it("is undefined for none, zero or garbage", () => {
    expect(youTubeStartSeconds("https://youtu.be/dQw4w9WgXcQ")).toBeUndefined();
    expect(youTubeStartSeconds("https://youtu.be/dQw4w9WgXcQ?t=0")).toBeUndefined();
    expect(youTubeStartSeconds("https://youtu.be/dQw4w9WgXcQ?t=abc")).toBeUndefined();
  });
});
