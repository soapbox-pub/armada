import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RoleEditor, RolesView } from "@/concord/components/RolesView";
import { hexToBytes } from "@/concord/lib/derive";
import type { CommunityRoles, Role } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));

const OWNER = "f".repeat(64);
const CUT = "1".repeat(64);
const STAYS = "2".repeat(64);
const SECRET = "aa".repeat(32);
const TESTER = "a".repeat(64);
const AUDIT = "b".repeat(64);

const roles = vi.hoisted(() => ({
  setMemberRoles: vi.fn(async () => {}),
  saveRole: vi.fn(async () => "role"),
  rekeyChannel: vi.fn(async () => {}),
  roster: undefined as unknown as CommunityRoles,
  ranked: false,
  activate: vi.fn(async () => [] as string[]),
  deleteRole: vi.fn(async () => {}),
  moveRole: vi.fn(async () => {}),
}));

vi.mock("@/concord/hooks/useRoles", () => ({
  useRoles: () => ({
    folded: {
      ownerHex: OWNER,
      roster: roles.roster,
      ...(roles.ranked ? { rankedRoster: true } : {}),
      banned: new Set<string>(),
      channels: new Map([[SECRET, { channelIdHex: SECRET, name: "secret", isPrivate: true, deleted: false }]]),
    },
    saveRole: roles.saveRole,
    isSavingRole: false,
    setMemberRoles: roles.setMemberRoles,
    isSettingRoles: false,
    newRoleId: () => "new",
  }),
}));
vi.mock("@/concord/hooks/useRankedRoles", () => ({
  useRankedRoles: () => ({
    folded: { ownerHex: OWNER, roster: roles.roster, rankedRoster: true, banned: new Set<string>(), channels: new Map(), heads: new Map(), headEditions: new Map() },
    activate: roles.activate,
    isActivating: false,
    deleteRole: roles.deleteRole,
    moveRole: roles.moveRole,
    reorderRoles: roles.moveRole,
    createRole: vi.fn(),
    editRole: vi.fn(),
    setEveryone: vi.fn(),
    isSaving: false,
  }),
}));
vi.mock("@/concord/hooks/useRekey", () => ({
  useChannelRekey: () => ({ rekeyChannel: roles.rekeyChannel, isRekeyingChannel: false, canRekeyChannel: true }),
}));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: OWNER } }) }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({ useScopedDisplayName: () => "" }));

describe("RolesView revoke", () => {
  it("rotates the channel key away from the members a revoke strips", async () => {
    // The stripped holder still has the key; without a rotation they keep reading (CORD-06).
    roles.roster = {
      roles: [
        { roleId: TESTER, name: "Testers", position: 5, permissions: 0n, scope: { kind: "channel", channelId: SECRET }, color: 0 },
        { roleId: AUDIT, name: "Auditors", position: 6, permissions: 0n, scope: { kind: "channel", channelId: SECRET }, color: 0 },
      ],
      grants: [
        { member: CUT, roleIds: [TESTER] },
        { member: STAYS, roleIds: [AUDIT] },
      ],
    };
    const community = { owner: OWNER, privateChannels: [{ id: hexToBytes(SECRET) }] } as unknown as Community;
    render(<RolesView community={community} />);

    fireEvent.click(screen.getByText("Testers"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke role" }));
    fireEvent.click(screen.getByRole("button", { name: "Revoke role" }));

    await waitFor(() => expect(roles.saveRole).toHaveBeenCalled());
    expect(roles.setMemberRoles).toHaveBeenCalledWith({ member: CUT, roleIds: [] });
    expect(roles.rekeyChannel).toHaveBeenCalledTimes(1);
    const [{ channelIdHex, keepRecipients, removedTargets }] = roles.rekeyChannel.mock.calls[0] as unknown as [
      { channelIdHex: string; keepRecipients: string[]; removedTargets: string[] },
    ];
    expect(channelIdHex).toBe(SECRET);
    expect(removedTargets).toEqual([CUT]);
    expect(keepRecipients.sort()).toEqual([OWNER, STAYS].sort());
    // The rotation lands before the role edition, while the cut is still known.
    expect(roles.rekeyChannel.mock.invocationCallOrder[0]).toBeLessThan(roles.saveRole.mock.invocationCallOrder[0]);
  });
});

const LIVE = "11".repeat(32);
const GONE = "22".repeat(32);

const role = (over: Partial<Role> = {}): Role => ({
  roleId: "role-1",
  name: "Helpers",
  position: 3,
  permissions: 0n,
  scope: { kind: "server" },
  color: 0,
  ...over,
});

function setup(r: Role) {
  const onSave = vi.fn();
  render(
    <RoleEditor
      role={r}
      // What RolesView hands over: live channels only, deleted ones filtered.
      channels={[{ idHex: LIVE, name: "general" }]}
      holders={0}
      saving={false}
      error={null}
      canRevoke={false}
      onSave={onSave}
      onRevoke={vi.fn()}
      onCancel={vi.fn()}
    />,
  );
  return { onSave };
}

describe("RoleEditor scope picker", () => {
  it("names a deleted scope without offering it as a channel", () => {
    setup(role({ scope: { kind: "channel", channelId: GONE } }));
    expect(screen.getByRole("combobox")).toHaveTextContent("A deleted channel");
    expect(screen.queryByText(/deleted-channel|# ?deleted channel/i)).not.toBeInTheDocument();
    expect(screen.getByText(/has been deleted\. Saving keeps the role as it is/)).toBeInTheDocument();
  });

  it("writes a deleted channel scope back unchanged on save", () => {
    // Hiding the channel from the picker must not rescope the role: the
    // scope is the data, and a save that silently widened it to the whole
    // community would change what every member's client folds.
    const { onSave } = setup(role({ scope: { kind: "channel", channelId: GONE } }));
    fireEvent.change(screen.getByLabelText("Role name"), { target: { value: "Renamed" } });
    fireEvent.submit(screen.getByLabelText("Role name").closest("form")!);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({
      name: "Renamed",
      scope: { kind: "channel", channelId: GONE },
    });
  });

  it("shows a live channel scope by name", () => {
    setup(role({ scope: { kind: "channel", channelId: LIVE } }));
    expect(screen.getByRole("combobox")).toHaveTextContent("general");
    expect(screen.queryByText("A deleted channel")).not.toBeInTheDocument();
  });
});

describe("RolesView on the vsk-13 Roster", () => {
  const ranked = (): CommunityRoles => ({
    roles: [
      { roleId: AUDIT, name: "Auditors", position: 2, rank: "b", permissions: 0n, scope: { kind: "server" }, color: 0 },
      { roleId: TESTER, name: "Testers", position: 1, rank: "a", permissions: 0n, scope: { kind: "server" }, color: 0 },
    ],
    grants: [{ member: CUT, roleIds: [TESTER] }],
    everyone: 0n,
  });

  it("lists the Roles in rank order above @everyone, and deletes one after asking", async () => {
    roles.ranked = true;
    roles.roster = ranked();
    render(<RolesView community={{ owner: OWNER, privateChannels: [] } as unknown as Community} />);
    const names = screen.getAllByText(/^(Testers|Auditors|@everyone)$/).map((e) => e.textContent);
    expect(names).toEqual(["Testers", "Auditors", "@everyone"]);
    fireEvent.click(screen.getByText("Testers"));
    fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
    await waitFor(() => expect(roles.deleteRole).toHaveBeenCalledWith({ roleId: TESTER }));
  });

  it("offers the owner of a legacy community the switch, and asks before making it", async () => {
    roles.ranked = false;
    roles.roster = { roles: [], grants: [] };
    render(<RolesView community={{ owner: OWNER, privateChannels: [] } as unknown as Community} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch to ranked roles" }));
    expect(roles.activate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Switch now" }));
    await waitFor(() => expect(roles.activate).toHaveBeenCalled());
  });
});
