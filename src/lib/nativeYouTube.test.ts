// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn((): string => "ios");
const isPluginAvailable = vi.fn((_name: string): boolean => true);
const open = vi.fn(async (_options: {
  videoId?: string;
  playlistId?: string;
  startSeconds?: number;
  autoplay?: boolean;
}): Promise<void> => {});

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => getPlatform(),
    isPluginAvailable: (name: string) => isPluginAvailable(name),
  },
  registerPlugin: () => ({ open: (options: Parameters<typeof open>[0]) => open(options) }),
}));

const {
  hasNativeYouTubePlayer,
  needsNativeYouTubePlayer,
  openNativeYouTube,
  openYouTubeTargetPage,
} = await import("@/lib/nativeYouTube");

beforeEach(() => {
  getPlatform.mockClear().mockReturnValue("ios");
  isPluginAvailable.mockClear().mockReturnValue(true);
  open.mockClear().mockResolvedValue();
});

afterEach(() => vi.restoreAllMocks());

describe("hasNativeYouTubePlayer", () => {
  it("is true only for an iOS binary with the plugin", () => {
    expect(hasNativeYouTubePlayer()).toBe(true);
    expect(isPluginAvailable).toHaveBeenCalledWith("ArmadaYouTube");
  });

  it("does not claim Android, desktop, or web", () => {
    for (const platform of ["android", "electron", "web"]) {
      getPlatform.mockReturnValue(platform);
      expect(hasNativeYouTubePlayer()).toBe(false);
    }
  });

  it("degrades for an older iOS binary without the plugin", () => {
    isPluginAvailable.mockReturnValue(false);
    expect(hasNativeYouTubePlayer()).toBe(false);
  });
});

describe("needsNativeYouTubePlayer", () => {
  it("is limited to the Capacitor iOS origin", () => {
    expect(needsNativeYouTubePlayer()).toBe(true);
    getPlatform.mockReturnValue("android");
    expect(needsNativeYouTubePlayer()).toBe(false);
    getPlatform.mockReturnValue("web");
    expect(needsNativeYouTubePlayer()).toBe(false);
  });
});

describe("openNativeYouTube", () => {
  it("passes a valid video id to the native player", async () => {
    await expect(openNativeYouTube({ videoId: "dQw4w9WgXcQ" })).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith({ videoId: "dQw4w9WgXcQ", startSeconds: undefined });
  });

  it("opens playlists at a bounded playback position", async () => {
    await expect(openNativeYouTube({
      playlistId: "PL1234567890",
      startSeconds: -30,
      autoplay: false,
    })).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith({
      playlistId: "PL1234567890",
      startSeconds: 0,
      autoplay: false,
    });
  });

  it("clamps extreme positions before crossing the native bridge", async () => {
    await expect(openNativeYouTube({ videoId: "dQw4w9WgXcQ", startSeconds: 1e308 })).resolves.toBe(true);
    expect(open).toHaveBeenCalledWith({
      videoId: "dQw4w9WgXcQ",
      startSeconds: 2_147_483_647,
    });
  });

  it("does not call native code for a malformed id", async () => {
    await expect(openNativeYouTube({ videoId: "https://evil.test" })).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("requires at least one valid target", async () => {
    await expect(openNativeYouTube({})).resolves.toBe(false);
    await expect(openNativeYouTube({ playlistId: "bad" })).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("does not call the iOS bridge on another platform", async () => {
    getPlatform.mockReturnValue("android");
    await expect(openNativeYouTube({ videoId: "dQw4w9WgXcQ" })).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("turns a native presentation failure into a safe fallback signal", async () => {
    open.mockRejectedValue(new Error("presentation failed"));
    await expect(openNativeYouTube({ videoId: "dQw4w9WgXcQ" })).resolves.toBe(false);
  });
});

describe("openYouTubeTargetPage", () => {
  it("opens a validated video on YouTube without embedding it", () => {
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);

    expect(openYouTubeTargetPage({ videoId: "dQw4w9WgXcQ" })).toBe(true);
    expect(openWindow).toHaveBeenCalledWith(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("refuses malformed video ids", () => {
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);

    expect(openYouTubeTargetPage({ videoId: "https://evil.test" })).toBe(false);
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("opens a playlist at the requested position", () => {
    const openWindow = vi.spyOn(window, "open").mockImplementation(() => null);

    expect(openYouTubeTargetPage({ playlistId: "PL1234567890", startSeconds: 42.8 })).toBe(true);
    expect(openWindow).toHaveBeenCalledWith(
      "https://www.youtube.com/playlist?list=PL1234567890&t=42s",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
