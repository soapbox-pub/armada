import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StorageReport } from "@/lib/storageUsage";

const h = vi.hoisted(() => ({
  report: undefined as unknown as StorageReport,
  measure: vi.fn(),
  clear: vi.fn(async () => {}),
}));

vi.mock("@/lib/storageUsage", () => ({
  measureStorage: h.measure,
  clearStorage: h.clear,
}));
vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));

import { StorageSettings } from "./StorageSettings";

function rowOf(label: string): HTMLElement {
  return screen.getByText(label).closest("div.flex") as HTMLElement;
}

describe("StorageSettings", () => {
  beforeEach(() => {
    h.clear.mockClear();
    h.report = {
      caches: [
        { id: "media", bytes: 12_300_000, count: 40, clearable: true },
        { id: "communityImages", bytes: 0, count: 0, clearable: false },
        { id: "callRecordings", bytes: 2_000_000, count: 1, clearable: true },
      ],
      data: [
        { id: "dms", bytes: 4_500, count: 12, clearable: false },
        { id: "settings", bytes: 900, clearable: false },
      ],
      totalBytes: 20_000_000,
      quotaBytes: 1_000_000_000,
    };
    h.measure.mockReset();
    h.measure.mockImplementation(async () => h.report);
  });

  it("shows each part with its size, and the total", async () => {
    render(<StorageSettings />);

    expect(await screen.findByText("20 MB")).toBeInTheDocument();
    expect(within(rowOf("Media cache")).getByText("12 MB")).toBeInTheDocument();
    expect(within(rowOf("Direct messages")).getByText("4.5 kB")).toBeInTheDocument();
    expect(screen.getByText("12 items")).toBeInTheDocument();
    expect(screen.getByText("This browser lets Armada use up to 1 GB.")).toBeInTheDocument();
  });

  it("clears a cache and measures again", async () => {
    render(<StorageSettings />);
    await screen.findByText("20 MB");

    fireEvent.click(within(rowOf("Media cache")).getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(h.clear).toHaveBeenCalledWith("media"));
    await waitFor(() => expect(h.measure).toHaveBeenCalledTimes(2));
  });

  it("offers no clear for an empty cache or for messages", async () => {
    render(<StorageSettings />);
    await screen.findByText("20 MB");

    expect(within(rowOf("Community icons and banners")).getByRole("button", { name: "Clear" })).toBeDisabled();
    expect(within(rowOf("Direct messages")).queryByRole("button")).toBeNull();
  });

  it("asks before deleting unsaved recordings", async () => {
    render(<StorageSettings />);
    await screen.findByText("20 MB");

    fireEvent.click(within(rowOf("Unsaved call recordings")).getByRole("button", { name: "Clear" }));
    expect(h.clear).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(h.clear).toHaveBeenCalledWith("callRecordings"));
  });
});
