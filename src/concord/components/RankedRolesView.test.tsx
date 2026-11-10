/** Reordering the vsk-13 Roster's Roles by drag (CORD-04 §2, Vector `RolesSection`). */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ reorders: [] as string[][], activationLeft: 0, activations: 0 }));
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
    activationLeft: h.activationLeft,
    activate: async () => {
      h.activations++;
      return [];
    },
  }),
}));
vi.mock("@/concord/lib/rankedWrites", async (orig) => ({
  ...(await orig<typeof import("@/concord/lib/rankedWrites")>()),
  rankedOrder: () => roles,
  // The editor sits at Admins' rank: Mods and Helpers are beneath them, Admins isn't.
  roleAuthor: () => ({ outranks: (p: number) => p > 0, supports: () => true }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: "e".repeat(64) } }) }));

const { RankedRolesBody, WriteProgress } = await import("./RankedRolesView");

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

describe("a write in progress", () => {
  it("says it is waiting before the first edition lands, and counts them after", () => {
    const { rerender } = render(<WriteProgress published={0} />);
    expect(screen.getByRole("status")).toHaveTextContent(/waiting for your signer/);
    rerender(<WriteProgress published={2} />);
    expect(screen.getByRole("status")).toHaveTextContent("2 changes published");
  });
});

describe("a switch to ranked roles cut short", () => {
  it("offers the owner to finish it", async () => {
    h.activationLeft = 3;
    render(<RankedRolesBody community={{ idHex: "cc".repeat(32) } as never} />);
    expect(screen.getByText(/didn't finish: 3 changes are still to publish/)).toBeInTheDocument();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Finish now/ })));
    expect(h.activations).toBe(1);
    h.activationLeft = 0;
  });
});
