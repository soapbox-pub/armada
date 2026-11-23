// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ImagePointer } from "@/concord/lib/types";

const decrypted = vi.fn<(image: ImagePointer | undefined) => string | null>();
const makeIconThumb = vi.fn<() => Promise<string | undefined>>();

vi.mock("@/concord/hooks/useDecryptedImage", () => ({
  useDecryptedImage: (image: ImagePointer | undefined) => decrypted(image),
}));
vi.mock("@/hooks/useBlossomServers", () => ({ useBlossomServers: () => [] }));
vi.mock("@/hooks/useMediaPolicy", () => ({ useMediaPolicy: () => ({ proxy: "" }) }));
vi.mock("@/concord/lib/iconThumbs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/concord/lib/iconThumbs")>()),
  makeIconThumb: () => makeIconThumb(),
}));

const { useCommunityIcon } = await import("@/concord/hooks/useCommunityIcon");
const { clearIconThumbMemory, readIconThumb, writeIconThumb } = await import("@/concord/lib/iconThumbs");

const THUMB = "data:image/png;base64,THUMB";
const pointer = (hash: string): ImagePointer => ({ url: `https://b.example/${hash}`, key: "k", nonce: "n", hash });

describe("useCommunityIcon", () => {
  beforeEach(() => {
    localStorage.clear();
    clearIconThumbMemory();
    decrypted.mockReset().mockReturnValue(null);
    makeIconThumb.mockReset().mockResolvedValue(THUMB);
  });

  it("paints the stored thumbnail before the fold is known, without decrypting", () => {
    writeIconThumb("c1", { hash: "h1", url: THUMB });
    const { result } = renderHook(() => useCommunityIcon("c1", undefined));
    expect(result.current).toBe(THUMB);
    expect(decrypted).toHaveBeenLastCalledWith(undefined);
  });

  it("keeps using a thumbnail that matches the current icon", () => {
    writeIconThumb("c1", { hash: "h1", url: THUMB });
    const { result } = renderHook(() => useCommunityIcon("c1", pointer("h1")));
    expect(result.current).toBe(THUMB);
    expect(decrypted).toHaveBeenLastCalledWith(undefined);
    expect(makeIconThumb).not.toHaveBeenCalled();
  });

  it("decrypts and stores a thumbnail on a miss", async () => {
    decrypted.mockReturnValue("blob:live");
    const { result } = renderHook(() => useCommunityIcon("c1", pointer("h1")));
    expect(result.current).toBe("blob:live");
    await waitFor(() => expect(readIconThumb("c1")).toEqual({ hash: "h1", url: THUMB }));
  });

  it("replaces a stale thumbnail when the icon changes", async () => {
    writeIconThumb("c1", { hash: "old", url: "data:image/png;base64,OLD" });
    decrypted.mockReturnValue("blob:new");
    const { result } = renderHook(() => useCommunityIcon("c1", pointer("new")));
    expect(result.current).toBe("blob:new");
    await waitFor(() => expect(readIconThumb("c1")?.hash).toBe("new"));
  });

  it("drops the thumbnail when the community no longer has an icon", async () => {
    writeIconThumb("c1", { hash: "h1", url: THUMB });
    const { result } = renderHook(() => useCommunityIcon("c1", null));
    expect(result.current).toBeNull();
    await waitFor(() => expect(readIconThumb("c1")).toBeUndefined());
  });

  it("ignores a v1 thumbnail, which a fingerprint blocker may have filled with noise", () => {
    localStorage.setItem("armada:c2icon:v1:c1", JSON.stringify({ hash: "h1", url: "data:image/png;base64,STRIPES" }));
    decrypted.mockReturnValue("blob:live");
    makeIconThumb.mockResolvedValue(undefined);
    const { result } = renderHook(() => useCommunityIcon("c1", pointer("h1")));
    expect(result.current).toBe("blob:live");
    expect(decrypted).toHaveBeenLastCalledWith(pointer("h1"));
  });
});
