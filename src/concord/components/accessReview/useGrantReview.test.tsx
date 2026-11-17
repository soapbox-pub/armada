import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useGrantReview } from "@/concord/components/accessReview/useGrantReview";
import type { SettleFollow } from "@/concord/hooks/rosterSettle";
import type { WriteProgressSink } from "@/concord/hooks/useRankedRoles";
import type { FoldedControl } from "@/concord/lib/control";
import { emptySettleReport } from "@/concord/lib/keySettle";
import { EVERYONE_DEFAULT, Permissions, type Role } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";

const OWNER = "f".repeat(64);
const ANA = "1".repeat(64);
const VAULT = "a".repeat(64);
const MODS = "b".repeat(64);
const GREEN = "c".repeat(64);

vi.mock("@/hooks/useToast", () => ({ toast: vi.fn() }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({ useScopedDisplayName: () => "" }));
vi.mock("@/components/DisplayName", () => ({ DisplayName: ({ name }: { name: string }) => <span>{name}</span> }));

const role = (roleId: string, name: string, position: number, permissions = 0n): Role => ({
  roleId,
  name,
  position,
  permissions,
  scope: { kind: "server" },
  color: 0,
});

const folded = {
  ownerHex: OWNER,
  rankedRoster: true,
  banned: new Set<string>(),
  roster: {
    roles: [role(MODS, "Mods", 1, Permissions.KICK), role(GREEN, "Green", 2)],
    grants: [],
    everyone: EVERYONE_DEFAULT,
    overwrites: [{ scope: VAULT, target: { kind: "role", id: MODS }, allow: Permissions.VIEW_CHANNEL | Permissions.READ_MESSAGE_HISTORY, deny: 0n }],
    syncs: {},
  },
  channels: new Map([[VAULT, { channelIdHex: VAULT, name: "vault", isPrivate: true, deleted: false, metadata: { name: "vault", private: true } }]]),
} as unknown as FoldedControl;
const community = { owner: OWNER, privateChannels: [] } as unknown as Community;

const toggle = vi.fn(async (_member: string, _roleId: string, _on: boolean, _follow: SettleFollow, _progress: WriteProgressSink) => true);
const onDone = vi.fn();
let ask: ReturnType<typeof useGrantReview>["ask"];

function Host({ held = [] as string[] }) {
  const review = useGrantReview({ community, folded, me: OWNER, rolesFor: () => held, toggle, onDone });
  ask = review.ask;
  return <>{review.dialog}</>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a Role toggle", () => {
  it("is left to the caller when it changes nothing the member can see or do", () => {
    render(<Host />);
    expect(ask(ANA, GREEN, true)).toBe(false);
    expect(ask(OWNER, MODS, true)).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the channels and permissions the Role brings, and writes once applied", async () => {
    render(<Host />);
    act(() => void expect(ask(ANA, MODS, true)).toBe(true));
    const dialog = screen.getByRole("dialog", { name: "Review changes" });
    expect(dialog).toHaveTextContent("Gains access · 1");
    expect(dialog).toHaveTextContent("vault");
    expect(dialog).toHaveTextContent("Through Mods");
    expect(dialog).toHaveTextContent("Kick members");
    expect(toggle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    expect(toggle).toHaveBeenCalledWith(ANA, MODS, true, expect.objectContaining({ onSettled: expect.any(Function) }), expect.anything());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("counts the editions the write signs while it saves", async () => {
    let land!: () => void;
    let sink!: WriteProgressSink;
    toggle.mockImplementationOnce(async (_m, _r, _on, _follow, progress) => {
      sink = progress;
      progress.planned(2);
      await new Promise<void>((done) => (land = done));
      return true;
    });
    render(<Host held={[MODS]} />);
    act(() => void ask(ANA, MODS, false));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    const dialog = screen.getByRole("dialog");
    await waitFor(() => expect(dialog).toHaveTextContent("Signing and publishing change 1 of 2…"));
    act(() => sink.published());
    expect(dialog).toHaveTextContent("Signing and publishing change 2 of 2…");
    await act(async () => land());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(false));
  });

  it("writes nothing when the review is cancelled", () => {
    render(<Host held={[MODS]} />);
    act(() => void ask(ANA, MODS, false));
    expect(screen.getByRole("dialog")).toHaveTextContent("Loses access · 1");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toggle).not.toHaveBeenCalled();
  });

  it("stays up when the key didn't reach the member", async () => {
    toggle.mockImplementationOnce(async (_m, _r, _on, follow) => {
      follow.onSettled({ report: { ...emptySettleReport(), members: [ANA], sendFailed: "No relay accepted the key." } });
      return true;
    });
    render(<Host />);
    act(() => void ask(ANA, MODS, true));
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the key hasn't reached everyone let in yet");
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
