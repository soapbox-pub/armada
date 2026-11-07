import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { describe, expect, it, vi } from "vitest";

import { ChannelPermissionsDialog } from "@/concord/components/ChannelPermissionsDialog";
import { Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";

const OWNER = "f".repeat(64);
const CHANNEL = "c".repeat(64);
const ROLE = "a".repeat(64);

const env = vi.hoisted(() => ({
  setOverwrite: vi.fn(async () => {}),
  setSync: vi.fn(async () => {}),
  overwrites: [] as unknown[],
}));

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({ useScopedDisplayName: () => "" }));
vi.mock("@/components/DisplayName", () => ({ DisplayName: ({ name }: { name: string }) => <span>{name}</span> }));
const JOINED = "d".repeat(64);
vi.mock("@/concord/hooks/useGuestbook", () => ({
  useGuestbook: () => ({ coalesced: new Map([[JOINED, { pubkey: JOINED, state: "join" }]]) }),
}));
vi.mock("@/concord/hooks/useRankedRoles", () => ({
  useRankedRoles: () => ({
    folded: {
      ownerHex: OWNER,
      rankedRoster: true,
      roster: {
        roles: [{ roleId: ROLE, name: "Mods", position: 1, rank: "a", permissions: 0n, scope: { kind: "server" }, color: 0 }],
        grants: [],
        everyone: 0n,
        overwrites: env.overwrites,
      },
      categories: new Map(),
    },
    setOverwrite: env.setOverwrite,
    setSync: env.setSync,
    isSaving: false,
  }),
}));

describe("ChannelPermissionsDialog (CORD-04 §8)", () => {
  it("denies a channel bit to @everyone", async () => {
    render(
      <ChannelPermissionsDialog
        community={{ owner: OWNER } as unknown as Community}
        scope={{ idHex: CHANNEL, kind: "channel", name: "general" }}
        onOpenChange={() => undefined}
      />,
    );
    const denies = screen.getAllByRole("button", { name: "Deny" });
    fireEvent.click(denies[1]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(env.setOverwrite).toHaveBeenCalled());
    const call = env.setOverwrite.mock.calls[0] as unknown as [{ scope: string; target: unknown; allow: bigint; deny: bigint }];
    expect(call[0].scope).toBe(CHANNEL);
    expect(call[0].target).toEqual({ kind: "everyone" });
    expect(call[0].allow).toBe(0n);
    expect(call[0].deny !== 0n && (call[0].deny & ~(Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES | Permissions.MANAGE_MESSAGES)) === 0n).toBe(true);
  });

  it("shows an existing rule's target and clears it", async () => {
    env.overwrites.push({ scope: CHANNEL, target: { kind: "role", id: ROLE }, allow: Permissions.SEND_MESSAGES, deny: 0n });
    env.setOverwrite.mockClear();
    render(
      <ChannelPermissionsDialog
        community={{ owner: OWNER } as unknown as Community}
        scope={{ idHex: CHANNEL, kind: "channel", name: "general" }}
        onOpenChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "Mods" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove rule" }));
    await waitFor(() => expect(env.setOverwrite).toHaveBeenCalledWith({ scope: CHANNEL, target: { kind: "role", id: ROLE }, allow: 0n, deny: 0n }));
  });

  it("names any member, typed as an npub", async () => {
    env.setOverwrite.mockClear();
    const member = "e".repeat(64);
    render(
      <ChannelPermissionsDialog
        community={{ owner: OWNER } as unknown as Community}
        scope={{ idHex: CHANNEL, kind: "category", name: "Text" }}
        onOpenChange={() => undefined}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Or a member's npub" }), { target: { value: nip19.npubEncode(member) } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Allow" })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(env.setOverwrite).toHaveBeenCalled());
    expect((env.setOverwrite.mock.calls[0] as unknown as [{ target: unknown }])[0].target).toEqual({ kind: "member", id: member });
  });
});
