import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const writeClipboardText = vi.fn(async (_text: string) => {});
const downloadBinaryFile = vi.fn(async (_name: string, _bytes: Uint8Array) => undefined);

vi.mock("@/lib/clipboard", () => ({ writeClipboardText: (t: string) => writeClipboardText(t) }));
vi.mock("@/lib/downloadFile", () => ({
  downloadBinaryFile: (n: string, b: Uint8Array) => downloadBinaryFile(n, b),
  savedDescription: () => "",
}));
vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));

import { MagnetAttachment } from "@/components/chat/TorrentAttachment";
import { parseTorrent } from "@/lib/torrent";

const TORRENT = new TextEncoder().encode(
  `d4:infod6:lengthi42e4:name9:guide.pdf12:piece lengthi16384e6:pieces20:${"x".repeat(20)}ee`,
);
const HASH = parseTorrent(TORRENT).btih!;
const MAGNET = `magnet:?xt=urn:btih:${HASH}&dn=guide.pdf&xl=42&tr=udp%3A%2F%2Ftracker.test%3A80`;
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  writeClipboardText.mockClear();
  downloadBinaryFile.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MagnetAttachment", () => {
  it("opens and copies the magnet, and shows its details on request, fetching nothing", async () => {
    render(<MagnetAttachment uri={MAGNET} />);
    expect(screen.getByText("Magnet link · 42 B")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /open/i })).toHaveAttribute("href", MAGNET);
    fireEvent.click(screen.getByRole("button", { name: /copy magnet link/i }));
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith(MAGNET));

    expect(screen.queryByText(HASH)).toBeNull();
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText(HASH)).toBeInTheDocument();
    expect(screen.getByText("tracker.test:80")).toBeInTheDocument();
    // No `xs`: there is no .torrent to offer.
    expect(screen.queryByRole("button", { name: /download/i })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves the xs .torrent only when it hashes to the magnet", async () => {
    const xs = "https://releases.test/guide.pdf.torrent";
    render(<MagnetAttachment uri={`${MAGNET}&xs=${encodeURIComponent(xs)}`} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fetchMock.mockResolvedValue(new Response(TORRENT.slice()));
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    await waitFor(() => expect(downloadBinaryFile).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe(xs);
    expect(downloadBinaryFile.mock.calls[0][0]).toBe("guide.pdf.torrent");
  });

  it("refuses an xs .torrent for other content", async () => {
    const xs = encodeURIComponent("https://evil.test/x.torrent");
    render(<MagnetAttachment uri={`magnet:?xt=urn:btih:${"0".repeat(40)}&xs=${xs}`} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fetchMock.mockResolvedValue(new Response(TORRENT.slice()));
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(downloadBinaryFile).not.toHaveBeenCalled();
  });
});
