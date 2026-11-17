import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { nip19 } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChannelEditor, ChannelEditorPane } from "@/concord/components/channelEditor/ChannelEditor";
import type { EditorScope } from "@/concord/components/channelEditor/useChannelEditor";
import { hexToBytes } from "@/concord/lib/derive";
import { emptySettleReport, type SettleReport } from "@/concord/lib/keySettle";
import { Permissions } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";

const OWNER = "f".repeat(64);
const CHANNEL = "c".repeat(64);
const ROLE = "a".repeat(64);
const JOINED = "d".repeat(64);
const CATEGORY = "b".repeat(64);
const SYNCED = "1".repeat(64);
const OWN = "2".repeat(64);
const STAFF = "3".repeat(64);

const env = vi.hoisted(() => ({
  applyRules: vi.fn(async (_: unknown) => {}),
  syncChannels: vi.fn(async (_: unknown) => {}),
  renameCategory: vi.fn(async (_: unknown) => {}),
  deleteCategory: vi.fn(async (_: unknown) => {}),
  renameChannel: vi.fn(async (_: unknown) => {}),
  setChannelTopic: vi.fn(async (_: unknown) => {}),
  setChannelView: vi.fn(async (_: unknown) => {}),
  setChannelCategory: vi.fn(async (_: unknown) => {}),
  privatiseChannel: vi.fn(async (_: unknown) => {}),
  publiciseChannel: vi.fn(async (_: unknown) => {}),
  deleteChannel: vi.fn(async (_: unknown) => {}),
  toast: vi.fn(),
  rotate: vi.fn(async (_: string) => {}),
  overwrites: [] as unknown[],
  grants: [] as unknown[],
  roles: [] as unknown[],
  /** Private Channels this device holds a key for. */
  held: [] as Array<{ id: Uint8Array }>,
  privateIds: new Set<string>(),
  me: "f".repeat(64),
  ranked: true,
}));

vi.mock("@/hooks/useToast", () => ({ toast: env.toast }));
vi.mock("@/hooks/useAuthor", () => ({ useAuthor: () => ({ data: undefined }) }));
vi.mock("@/hooks/useScopedDisplayName", () => ({ useScopedDisplayName: () => "" }));
vi.mock("@/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ user: { pubkey: env.me } }) }));
vi.mock("@/components/DisplayName", () => ({ DisplayName: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock("@/concord/components/channelEditor/useMemberSearch", () => ({
  useMemberSearch: (pubkeys: readonly string[], query: string) => pubkeys.filter((pk) => !query.trim() || pk.startsWith(query.trim())),
}));
vi.mock("@/concord/hooks/useGuestbook", () => ({
  useGuestbook: () => ({ coalesced: new Map([["d".repeat(64), { pubkey: "d".repeat(64), state: "join" }]]) }),
}));
vi.mock("@/concord/hooks/useControlPlane", () => ({
  useChannels: () => [
    { idHex: "1".repeat(64), name: "lounge", view: "chat", categoryId: "b".repeat(64), category: "Text" },
    { idHex: "2".repeat(64), name: "own", view: "chat", categoryId: "b".repeat(64), category: "Text" },
    { idHex: "c".repeat(64), name: "general", view: "chat", topic: "Welcome" },
    { idHex: "3".repeat(64), name: "staff", view: "chat", isPrivate: true },
  ],
}));
vi.mock("@/concord/hooks/useCommunityActions", () => ({
  useCommunityManagement: () => ({
    renameChannel: env.renameChannel,
    setChannelTopic: env.setChannelTopic,
    setChannelView: env.setChannelView,
    setChannelCategory: env.setChannelCategory,
    privatiseChannel: env.privatiseChannel,
    publiciseChannel: env.publiciseChannel,
    deleteChannel: env.deleteChannel,
    nameCategory: vi.fn(async () => {}),
  }),
}));
vi.mock("@/concord/hooks/useRankedRoles", () => ({
  useRankedRoles: () => ({
    applyRules: env.applyRules,
    syncChannels: env.syncChannels,
    renameCategory: env.renameCategory,
    deleteCategory: env.deleteCategory,
    published: 0,
    planned: 0,
    isSaving: false,
    folded: {
      ownerHex: "f".repeat(64),
      rankedRoster: env.ranked,
      roster: {
        roles: env.roles,
        grants: env.grants,
        everyone: 0n,
        overwrites: env.overwrites,
        syncs: { ["1".repeat(64)]: "b".repeat(64) },
      },
      categories: new Map([["b".repeat(64), { idHex: "b".repeat(64), name: "Text", position: "a", deleted: false }]]),
      channels: new Map(["1", "2", "c", "3"].map((c) => [c.repeat(64), { channelIdHex: c.repeat(64), isPrivate: env.privateIds.has(c.repeat(64)), deleted: false }])),
      banned: new Set<string>(),
    },
  }),
}));

const community = {
  owner: OWNER,
  get privateChannels() {
    return env.held;
  },
} as unknown as Community;
const channel = (over: Partial<EditorScope> = {}): EditorScope => ({ idHex: CHANNEL, kind: "channel", name: "general", ...over });
const category: EditorScope = { idHex: CATEGORY, kind: "category", name: "Text" };

function pane(scope: EditorScope, onRemoved = () => undefined) {
  return render(<ChannelEditorPane community={community} scope={scope} onRemoved={onRemoved} />);
}
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));
type Follow = { watch?: (phase: "rotate" | "send") => void; onSettled: (outcome: { report?: SettleReport; error?: string }) => void };
const written = () => env.applyRules.mock.calls.map((c) => c[0] as { follow?: Follow } & Record<string, unknown>);
/** What was written, less the hooks a reviewed write is followed through. */
const rulesWritten = () => written().map(({ follow: _follow, ...rules }) => rules);
const report = (over: Partial<SettleReport> = {}): SettleReport => ({ ...emptySettleReport(), ...over });

const MODS = { roleId: ROLE, name: "Mods", position: 1, rank: "a", permissions: 0n, scope: { kind: "server" }, color: 0 };

beforeEach(() => {
  env.overwrites.length = 0;
  env.grants.length = 0;
  env.roles = [MODS];
  env.held = [{ id: hexToBytes(STAFF) }];
  env.privateIds = new Set([STAFF]);
  env.me = OWNER;
  env.ranked = true;
  vi.clearAllMocks();
});

describe("a channel's fields", () => {
  it("has nothing to save until something changes", () => {
    pane(channel());
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "lobby" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("writes the name and the topic that changed, and says so", async () => {
    pane(channel());
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "lobby" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Topic" }), { target: { value: "Say hi" } });
    save();
    await waitFor(() => expect(env.toast).toHaveBeenCalledWith({ title: "Changes saved" }));
    expect(env.renameChannel).toHaveBeenCalledWith({ channelIdHex: CHANNEL, name: "lobby" });
    expect(env.setChannelTopic).toHaveBeenCalledWith({ channelIdHex: CHANNEL, topic: "Say hi" });
    expect(env.setChannelView).not.toHaveBeenCalled();
    expect(env.applyRules).not.toHaveBeenCalled();
  });

  it("shows a failed write, and a retry skips what landed", async () => {
    env.setChannelTopic.mockRejectedValueOnce(new Error("No relay accepted the update."));
    pane(channel());
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "lobby" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Topic" }), { target: { value: "Say hi" } });
    save();
    expect(await screen.findByRole("alert")).toHaveTextContent("No relay accepted the update.");
    expect(env.toast).not.toHaveBeenCalled();
    save();
    await waitFor(() => expect(env.toast).toHaveBeenCalledWith({ title: "Changes saved" }));
    expect(env.renameChannel).toHaveBeenCalledTimes(1);
    expect(env.setChannelTopic).toHaveBeenCalledTimes(2);
  });

  it("drops the draft on Cancel", () => {
    pane(channel());
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "lobby" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("general");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("deletes the channel only once confirmed", async () => {
    const onRemoved = vi.fn();
    pane(channel(), onRemoved);
    fireEvent.click(screen.getByRole("button", { name: "Delete channel" }));
    expect(screen.getByText("Delete #general? Its id is never reused.")).toBeInTheDocument();
    expect(env.deleteChannel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(env.deleteChannel).toHaveBeenCalledWith({ channelIdHex: CHANNEL });
  });

  it("says a channel that isn't there is gone", () => {
    pane(channel({ idHex: "9".repeat(64) }));
    expect(screen.getByText("This channel is gone.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("a channel's permissions (CORD-04 §8)", () => {
  it("denies a channel bit to @everyone", async () => {
    pane(channel({ tab: "permissions" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Send messages" })).getByRole("button", { name: "Deny" }));
    expect(env.applyRules).not.toHaveBeenCalled();
    save();
    await waitFor(() => expect(env.applyRules).toHaveBeenCalled());
    expect(rulesWritten()).toEqual([
      { scope: CHANNEL, sync: undefined, overwrites: [{ target: { kind: "everyone" }, allow: 0n, deny: Permissions.SEND_MESSAGES }] },
    ]);
  });

  it("shows an existing rule's target and clears it", async () => {
    env.overwrites.push({ scope: CHANNEL, target: { kind: "role", id: ROLE }, allow: Permissions.SEND_MESSAGES, deny: 0n });
    pane(channel({ tab: "permissions" }));
    fireEvent.click(screen.getByRole("button", { name: /^Mods/ }));
    expect(within(screen.getByRole("group", { name: "Send messages" })).getByRole("button", { name: "Allow" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByRole("button", { name: /^Mods/ })).toBeNull();
    save();
    await waitFor(() => expect(env.applyRules).toHaveBeenCalled());
    expect(rulesWritten()).toEqual([{ scope: CHANNEL, sync: undefined, overwrites: [{ target: { kind: "role", id: ROLE }, allow: 0n, deny: 0n }] }]);
  });

  it("adds a role and a member from the picker", async () => {
    pane(channel({ tab: "permissions" }));
    fireEvent.click(screen.getByRole("button", { name: "Add role or member" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Mods/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: JOINED.slice(0, 8) }));
    fireEvent.click(screen.getByRole("button", { name: "Add 2" }));
    // The first one added is the one shown.
    fireEvent.click(within(screen.getByRole("group", { name: "Speak" })).getByRole("button", { name: "Deny" }));
    save();
    await waitFor(() => expect(env.applyRules).toHaveBeenCalled());
    expect(rulesWritten()).toEqual([{ scope: CHANNEL, sync: undefined, overwrites: [{ target: { kind: "role", id: ROLE }, allow: 0n, deny: Permissions.SPEAK }] }]);
  });

  it("reviews making a channel private, then writes its rules first", async () => {
    pane(channel({ tab: "permissions" }));
    fireEvent.click(screen.getByRole("switch", { name: /Private channel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add role or member" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Mods/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1" }));
    save();
    expect(screen.getByRole("dialog", { name: "Review changes" })).toHaveTextContent("#general gets its own key from here on");
    expect(env.privatiseChannel).not.toHaveBeenCalled();
    expect(env.applyRules).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(env.privatiseChannel).toHaveBeenCalledWith({ channelIdHex: CHANNEL }));
    // Whoever is added to a private channel is let in.
    expect(rulesWritten()).toEqual([
      { scope: CHANNEL, sync: undefined, overwrites: [{ target: { kind: "role", id: ROLE }, allow: Permissions.VIEW_CHANNEL, deny: 0n }] },
    ]);
    expect(env.applyRules.mock.invocationCallOrder[0]).toBeLessThan(env.privatiseChannel.mock.invocationCallOrder[0]);
  });

  it("leaves the review without writing", () => {
    pane(channel({ tab: "permissions" }));
    fireEvent.click(screen.getByRole("switch", { name: /Private channel/ }));
    save();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Review changes" })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(env.privatiseChannel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("never offers @everyone the view of a private channel", () => {
    pane(channel({ tab: "permissions" }));
    fireEvent.click(screen.getByRole("switch", { name: /Private channel/ }));
    const view = within(screen.getByRole("group", { name: "View channels" }));
    expect(view.getByRole("button", { name: "Deny" })).toHaveAttribute("aria-pressed", "true");
    expect(view.getByRole("button", { name: "Allow" })).toBeDisabled();
  });

  it("hides a synced channel's own rules, and unsyncs it", async () => {
    pane(channel({ idHex: SYNCED, name: "lounge", tab: "permissions" }));
    expect(screen.getByRole("switch", { name: /Use Text's permissions/ })).toBeChecked();
    expect(screen.queryByRole("button", { name: "Add role or member" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: /Use Text's permissions/ }));
    expect(screen.getByRole("button", { name: "Add role or member" })).toBeInTheDocument();
    save();
    await waitFor(() => expect(env.applyRules).toHaveBeenCalled());
    expect(rulesWritten()).toEqual([{ scope: SYNCED, sync: { category: undefined }, overwrites: [] }]);
  });

  it("offers no category sync to a channel outside every category", () => {
    pane(channel({ tab: "permissions" }));
    expect(screen.queryByRole("switch", { name: /permissions/ })).toBeNull();
  });

  it("offers no bulk sync on a channel", () => {
    pane(channel({ idHex: OWN, name: "own", tab: "permissions" }));
    expect(screen.queryByRole("button", { name: "Sync all channels" })).toBeNull();
  });

  it("keeps a legacy roster's public channel public", () => {
    env.ranked = false;
    pane(channel({ tab: "permissions" }));
    expect(screen.getByRole("switch", { name: /Private channel/ })).toBeDisabled();
    expect(screen.getByText(/needs the community on ranked roles/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add role or member" })).toBeNull();
  });
});

describe("a category", () => {
  it("names any member, typed as an npub", async () => {
    const member = "e".repeat(64);
    pane(category);
    fireEvent.click(screen.getByRole("button", { name: "Add role or member" }));
    fireEvent.change(screen.getByPlaceholderText("Search roles and members"), { target: { value: nip19.npubEncode(member) } });
    fireEvent.click(screen.getByRole("checkbox", { name: member.slice(0, 8) }));
    fireEvent.click(screen.getByRole("button", { name: "Add 1" }));
    fireEvent.click(within(screen.getByRole("group", { name: "View channels" })).getByRole("button", { name: "Allow" }));
    save();
    // Only the channel on the category's rules is theirs to see.
    expect(screen.getByRole("dialog", { name: "Review changes" })).toHaveTextContent("Gains access · 1");
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    await waitFor(() => expect(env.applyRules).toHaveBeenCalled());
    expect(rulesWritten()).toEqual([
      { scope: CATEGORY, sync: undefined, overwrites: [{ target: { kind: "member", id: member }, allow: Permissions.VIEW_CHANNEL, deny: 0n }] },
    ]);
  });

  it("won't list the owner, who holds every permission already", () => {
    pane(category);
    fireEvent.click(screen.getByRole("button", { name: "Add role or member" }));
    fireEvent.change(screen.getByPlaceholderText("Search roles and members"), { target: { value: nip19.npubEncode(OWNER) } });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByText("The owner holds every permission everywhere.")).toBeInTheDocument();
  });

  it("says there is nobody left to add, rather than that nobody matches", () => {
    env.overwrites.push(
      { scope: CATEGORY, target: { kind: "role", id: ROLE }, allow: Permissions.VIEW_CHANNEL, deny: 0n },
      { scope: CATEGORY, target: { kind: "member", id: JOINED }, allow: Permissions.VIEW_CHANNEL, deny: 0n },
    );
    pane(category);
    fireEvent.click(screen.getByRole("button", { name: "Add role or member" }));
    expect(screen.getByText("There's nobody else to add. A member can also be added by npub.")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search roles and members"), { target: { value: "zzz" } });
    expect(screen.getByText("Nobody matches. A member can also be added by npub.")).toBeInTheDocument();
  });

  it("syncs every channel still on its own rules", async () => {
    pane(category);
    expect(screen.getByText("1 channel uses its own permissions.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sync all channels" }));
    await waitFor(() => expect(env.syncChannels).toHaveBeenCalledWith({ channelIds: [OWN], category: CATEGORY }));
  });

  it("is renamed", async () => {
    pane(category);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Chat" } });
    save();
    await waitFor(() => expect(env.renameCategory).toHaveBeenCalledWith({ idHex: CATEGORY, name: "Chat" }));
  });

  it("has no topic, type or tabs", () => {
    pane(category);
    expect(screen.queryByRole("textbox", { name: "Topic" })).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });
});

describe("a change to who can read a channel", () => {
  const staff = () => {
    env.overwrites.push({ scope: STAFF, target: { kind: "role", id: ROLE }, allow: Permissions.VIEW_CHANNEL, deny: 0n });
    env.grants.push({ member: JOINED, roleIds: [ROLE] });
    const view = render(
      <ChannelEditorPane
        community={community}
        scope={channel({ idHex: STAFF, name: "staff", tab: "permissions" })}
        ops={{ onRotateChannelKey: env.rotate }}
        onRemoved={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Mods/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    save();
    return view;
  };
  const review = () => within(screen.getByRole("dialog"));

  it("writes straight away when nobody's access moves", async () => {
    pane(channel({ tab: "permissions" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Send messages" })).getByRole("button", { name: "Deny" }));
    save();
    await waitFor(() => expect(env.toast).toHaveBeenCalledWith({ title: "Changes saved" }));
    expect(written()[0].follow).toBeUndefined();
  });

  it("names who loses a private channel and how they had it", () => {
    staff();
    expect(screen.getByRole("dialog", { name: "Review changes" })).toHaveTextContent("Loses access · 1");
    expect(review().getByText("Had it through Mods")).toBeInTheDocument();
    expect(review().getByText(/Keep Armada open/)).toBeInTheDocument();
    expect(env.applyRules).not.toHaveBeenCalled();
  });

  it("stays up while the key rotates, and can't be left", async () => {
    let finish = () => {};
    env.applyRules.mockImplementationOnce(async (vars) => {
      const { follow } = vars as { follow: Follow };
      follow.watch?.("rotate");
      await new Promise<void>((resolve) => (finish = resolve));
      follow.onSettled({ report: report() });
    });
    staff();
    fireEvent.click(review().getByRole("button", { name: "Apply changes" }));
    expect(await review().findByText("Rotating the channel key")).toBeInTheDocument();
    expect(review().getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(review().queryByRole("button", { name: "Apply changes" })).toBeNull();
    finish();
    await waitFor(() => expect(env.toast).toHaveBeenCalledWith({ title: "Changes saved" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says a key that didn't rotate still reads, and rotates it again", async () => {
    env.applyRules.mockImplementationOnce(async (vars) => {
      (vars as { follow: Follow }).follow.onSettled({ report: report({ rotationFailed: [{ channelIdHex: STAFF, error: "No relay accepted the key." }] }) });
    });
    staff();
    fireEvent.click(review().getByRole("button", { name: "Apply changes" }));
    expect(await review().findByRole("alert")).toHaveTextContent(/can still read/);
    expect(review().getByText("No relay accepted the key.")).toBeInTheDocument();
    expect(env.toast).not.toHaveBeenCalled();
    fireEvent.click(review().getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(env.toast).toHaveBeenCalledWith({ title: "Changes saved" }));
    expect(env.rotate).toHaveBeenCalledWith(STAFF);
    expect(env.applyRules).toHaveBeenCalledTimes(1);
  });

  it("stops at a write that failed, and retries it", async () => {
    env.applyRules.mockRejectedValueOnce(new Error("No relay accepted the update."));
    staff();
    fireEvent.click(review().getByRole("button", { name: "Apply changes" }));
    expect(await review().findByRole("alert")).toHaveTextContent("It stopped before finishing.");
    expect(review().getByText("No relay accepted the update.")).toBeInTheDocument();
    fireEvent.click(review().getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(env.toast).toHaveBeenCalledWith({ title: "Changes saved" }));
    expect(env.applyRules).toHaveBeenCalledTimes(2);
  });
});

describe("the editor over the page", () => {
  it("opens a dialog on a pointer, and Cancel closes it", () => {
    const onClose = vi.fn();
    render(<ChannelEditor community={community} scope={channel()} onClose={onClose} />);
    expect(screen.getByRole("dialog", { name: "general" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("is nothing until it is opened", () => {
    render(<ChannelEditor community={community} scope={undefined} onClose={() => undefined} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("forgets a dismissed draft on the next opening", () => {
    const { rerender } = render(<ChannelEditor community={community} scope={channel()} onClose={() => undefined} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "lobby" } });
    rerender(<ChannelEditor community={community} scope={undefined} onClose={() => undefined} />);
    rerender(<ChannelEditor community={community} scope={channel()} onClose={() => undefined} />);
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("general");
  });

  it("closes once saved", async () => {
    const onClose = vi.fn();
    render(<ChannelEditor community={community} scope={channel()} onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "lobby" } });
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(env.renameChannel).toHaveBeenCalledWith({ channelIdHex: CHANNEL, name: "lobby" });
  });
});

describe("the editor on touch", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(pointer: coarse)",
      media: query,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a sheet whose rows open a target's rule as a page", async () => {
    render(<ChannelEditor community={community} scope={channel({ tab: "permissions" })} onClose={() => undefined} />);
    const sheet = within(screen.getByRole("dialog", { name: "general" }));
    fireEvent.click(sheet.getByRole("button", { name: /@everyone/ }));
    expect(sheet.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(within(sheet.getByRole("group", { name: "Send messages" })).getByRole("button", { name: "Deny" }));
    fireEvent.click(sheet.getByRole("button", { name: "Done" }));
    expect(sheet.getByRole("button", { name: /@everyone/ })).toHaveTextContent("1 change");
    fireEvent.click(sheet.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(env.applyRules).toHaveBeenCalled());
    expect(rulesWritten()).toEqual([
      { scope: CHANNEL, sync: undefined, overwrites: [{ target: { kind: "everyone" }, allow: 0n, deny: Permissions.SEND_MESSAGES }] },
    ]);
  });

  it("reviews an access change as a page of the sheet", async () => {
    render(<ChannelEditor community={community} scope={channel({ tab: "permissions" })} onClose={() => undefined} />);
    const sheet = within(screen.getByRole("dialog", { name: "general" }));
    fireEvent.click(sheet.getByRole("switch", { name: /Private channel/ }));
    fireEvent.click(sheet.getByRole("button", { name: "Save" }));
    expect(sheet.getByText("Review changes")).toBeInTheDocument();
    expect(sheet.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(sheet.getByRole("button", { name: "Cancel" }));
    expect(sheet.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(env.privatiseChannel).not.toHaveBeenCalled();
  });

  it("files the channel under a category picked from a page", async () => {
    render(<ChannelEditor community={community} scope={channel()} onClose={() => undefined} />);
    const sheet = within(screen.getByRole("dialog", { name: "general" }));
    fireEvent.click(sheet.getByRole("button", { name: /Category/ }));
    fireEvent.click(sheet.getByRole("button", { name: "Text" }));
    fireEvent.click(sheet.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(env.applyRules).toHaveBeenCalled());
    expect(env.setChannelCategory).toHaveBeenCalledWith({ channelIdHex: CHANNEL, category: CATEGORY, follow: false });
    // A public channel with no rules of its own follows the category it is filed under.
    expect(rulesWritten()).toEqual([{ scope: CHANNEL, sync: { category: CATEGORY }, overwrites: [] }]);
  });
});

describe("what the viewer can't write", () => {
  const ME = "9".repeat(64);
  const MANAGERS = "8".repeat(64);
  const HELD = Permissions.MANAGE_ROLES | Permissions.MANAGE_CHANNELS | Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES;
  /** A manager above Mods who holds no Manage messages. */
  const manager = () => {
    env.me = ME;
    env.roles = [{ ...MODS, roleId: MANAGERS, name: "Managers", position: 1, permissions: HELD }, { ...MODS, position: 2, rank: "b" }];
    env.grants.push({ member: ME, roleIds: [MANAGERS] });
  };
  const bit = (name: string, state: string) => within(screen.getByRole("group", { name })).getByRole("button", { name: state });

  it("closes a permission they don't hold, and says so", () => {
    manager();
    pane(channel({ tab: "permissions" }));
    expect(bit("View channels", "Deny")).toBeEnabled();
    expect(bit("Manage messages", "Allow")).toBeDisabled();
    expect(bit("Manage messages", "Deny")).toBeDisabled();
    expect(screen.getAllByText("You don't hold this permission").length).toBeGreaterThan(0);
    expect(screen.queryByText(/isn't yours to change/)).toBeNull();
  });

  it("closes a rule whole when it already sets one", () => {
    manager();
    env.overwrites.push({ scope: CHANNEL, target: { kind: "everyone" }, allow: Permissions.MANAGE_MESSAGES, deny: 0n });
    pane(channel({ tab: "permissions" }));
    expect(screen.getByText("This rule sets a permission you don't hold, so it isn't yours to change.")).toBeInTheDocument();
    expect(bit("View channels", "Deny")).toBeDisabled();
  });

  it("offers only the roles and members beneath them", () => {
    manager();
    pane(channel({ tab: "permissions" }));
    fireEvent.click(screen.getByRole("button", { name: "Add role or member" }));
    expect(screen.getByRole("checkbox", { name: /Managers/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Managers/ }).closest("label")).toHaveTextContent("Not beneath your role");
    expect(screen.getByRole("checkbox", { name: /Mods/ })).toBeEnabled();
  });

  it("closes a rule on a role that isn't beneath them, and its removal", () => {
    manager();
    env.overwrites.push({ scope: CHANNEL, target: { kind: "role", id: MANAGERS }, allow: 0n, deny: Permissions.SEND_MESSAGES });
    pane(channel({ tab: "permissions" }));
    fireEvent.click(screen.getByRole("button", { name: /Managers/ }));
    expect(screen.getByText("You can only set permissions for roles and members beneath you.")).toBeInTheDocument();
    expect(bit("Send messages", "Inherit")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  });

  it("closes a sync that would swap rules they couldn't write", () => {
    manager();
    env.overwrites.push({ scope: CATEGORY, target: { kind: "everyone" }, allow: Permissions.MANAGE_MESSAGES, deny: 0n });
    pane(channel({ idHex: OWN, name: "own", tab: "permissions" }));
    expect(screen.getByRole("switch", { name: /Use Text's permissions/ })).toBeDisabled();
    expect(screen.getByText("Syncing swaps permissions you can't set; ask someone who can.")).toBeInTheDocument();
  });

  it("leaves a sync they could write open", () => {
    manager();
    pane(channel({ idHex: OWN, name: "own", tab: "permissions" }));
    expect(screen.getByRole("switch", { name: /Use Text's permissions/ })).toBeEnabled();
  });

  it("closes a category's rules while a private channel on them has no key here", () => {
    env.privateIds = new Set([STAFF, SYNCED]);
    pane(category);
    expect(screen.getByText("You can only change who reads a private channel you can read.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add role or member" })).toBeDisabled();
    expect(bit("View channels", "Allow")).toBeDisabled();
  });
});
