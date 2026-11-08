/** Reordering the vsk-13 Roster's Roles by drag (CORD-04 §2, Vector `RolesSection`). */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ reorders: [] as string[][] }));
const roles = [
  { roleId: "a".repeat(64), name: "Admins", position: 0, permissions: 0n, color: 0, scope: { kind: "server" } },
  { roleId: "b".repeat(64), name: "Mods", position: 1, permissions: 0n, color: 0, scope: { kind: "server" } },
  { roleId: "c".repeat(64), name: "Helpers", position: 2, permissions: 0n, color: 0, scope: { kind: "server" } },
];
vi.mock("@/concord/hooks/useRankedRoles", () => ({
  useRankedRoles: () => ({
    folded: { roster: { roles, grants: [] } },
    reorderRoles: async ({ ordered }: { ordered: string[] }) => void h.reorders.push(ordered),
    isSaving: false,
  }),
}));
vi.mock("@/concord/lib/rankedWrites", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/rankedWrites")>()),
  rankedOrder: () => roles,
  // The editor sits at Admins' rank: Mods and Helpers are beneath them, Admins isn't.
  roleAuthor: () => ({ outranks: (p: number) => p > 0, supports: () => true }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "e".repeat(64) } }) }));

const { RankedRolesBody } = await import("./RankedRolesView");

beforeAll(() => {
  // jsdom has no PointerEvent, and a plain Event drops `clientY`.
  if (!("PointerEvent" in window)) {
    (window as unknown as { PointerEvent: unknown }).PointerEvent = class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    };
  }
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
});

describe("dragging a Role", () => {
  it("never drops it above a Role the editor doesn't outrank", async () => {
    render(<RankedRolesBody community={{ idHex: "cc".repeat(32) } as never} />);
    document.querySelectorAll("[data-role-row]").forEach((row, i) => {
      row.getBoundingClientRect = () => ({ top: i * 40, bottom: i * 40 + 39 }) as DOMRect;
    });
    const grip = screen.getByRole("button", { name: "Reorder Helpers" });
    const drag = async (toY: number) => {
      act(() => void fireEvent.pointerDown(grip, { pointerId: 1, clientY: 90 }));
      act(() => void fireEvent.pointerMove(grip, { pointerId: 1, clientY: toY }));
      await act(async () => void fireEvent.pointerUp(grip, { pointerId: 1, clientY: toY }));
    };
    // Baseline: above Mods, whom the editor outranks.
    await drag(50);
    expect(h.reorders).toEqual([["a".repeat(64), "c".repeat(64), "b".repeat(64)]]);
    h.reorders = [];
    await drag(10);
    for (const ordered of h.reorders) expect(ordered[0]).toBe("a".repeat(64));
  });
});
