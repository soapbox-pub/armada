/** Deleting a Category from the channel list (CORD-03 §4). */
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ fail: true }));
vi.mock("@/concord/hooks/useRankedRoles", () => {
  const folded = {
    rankedRoster: true,
    ownerHex: "aa".repeat(32),
    roster: { roles: [], grants: [], everyone: 0n },
    categories: new Map([
      ["11".repeat(32), { idHex: "11".repeat(32), name: "Text", position: "a", deleted: false }],
      ["22".repeat(32), { idHex: "22".repeat(32), name: "Voice", position: "b", deleted: false }],
    ]),
  };
  return {
    useRankedRoles: () => ({
      folded,
      moveCategory: async () => undefined,
      deleteCategory: async () => {
        if (h.fail) throw new Error("No relay accepted the update.");
      },
    }),
  };
});
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "aa".repeat(32) } }) }));
vi.mock("@/concord/components/ChannelPermissionsDialog", () => ({ ChannelPermissionsDialog: () => null }));

const { useRankedCategoryControls } = await import("./RankedCategoryControls");

describe("deleting a Category", () => {
  it("doesn't show one Category's failed delete on the next one opened after Cancel", async () => {
    const { result } = renderHook(() => useRankedCategoryControls({ idHex: "cc".repeat(32) } as never, true));
    const { rerender } = render(<>{result.current.dialog}</>);
    act(() => result.current.actionsFor("11".repeat(32), "Text").onDelete!());
    rerender(<>{result.current.dialog}</>);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete category" })));
    rerender(<>{result.current.dialog}</>);
    expect(screen.getByText("No relay accepted the update.")).toBeInTheDocument();

    act(() => fireEvent.click(screen.getByRole("button", { name: "Cancel" })));
    act(() => result.current.actionsFor("22".repeat(32), "Voice").onDelete!());
    rerender(<>{result.current.dialog}</>);
    expect(screen.queryByText("No relay accepted the update.")).toBeNull();
  });
});
