import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  Bluetooth,
  BluetoothOff,
  ChevronLeft,
  Hash,
  Loader2,
  Lock,
  MessageCircle,
  Plus,
  Radio,
  Send,
  UserPlus,
  Users,
  VenetianMask,
  X,
} from "lucide-react";

import { MeshMessage } from "@/components/chat/MeshMessage";
import { MeshMentionAutocomplete } from "@/components/chat/MeshMentionAutocomplete";
import { MessageTimeline } from "@/components/chat/MessageTimeline";
import { SlashCommandAutocomplete } from "@/components/chat/SlashCommandAutocomplete";
import { LoginArea } from "@/components/auth/LoginArea";
import { ChannelSidebarView } from "@/components/layout/ChannelSidebarView";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useInsertText } from "@/hooks/useInsertText";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { toast } from "@/hooks/useToast";
import { meshIdentity, meshMentionToken, type MeshIdentity } from "@/lib/meshIdentity";
import { type MeshChannel } from "@/lib/meshChannel";
import { isMeshSlashCommand } from "@/lib/meshSlashCommands";
import {
  executeSlashCommand,
  parseSlashCommand,
  type SlashCommand,
  type SlashCommandHandlers,
} from "@/lib/slashCommands";
import { cn } from "@/lib/utils";

import type { ChatTransport } from "@/components/chat/transport";
import type { MeshPeer } from "@/lib/bluetoothMesh";

/**
 * What the chat pane is currently showing. `null` is the "nothing selected"
 * landing state (mobile: the sidebar is revealed; desktop: a prompt).
 */
type MeshView =
  | { type: "broadcast" }
  | { type: "dm"; peerID: string }
  | { type: "channel"; channelId: string }
  | null;

/** A small palette for new private channels (deterministic accent colors). */
const CHANNEL_COLORS = [
  "#f97316", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#eab308", "#14b8a6",
];

/**
 * Bluetooth mesh chat for nearby bitchat-compatible devices. Mirrors the
 * server/channel shape (`ChannelSidebarView` + `SwipeReveal`) so it reads as a
 * "Mesh" server: a `# nearby mesh` channel for the broadcast room, and a
 * Members roster of nearby peers whose rows open native Noise XX DMs.
 */
export function MeshPage() {
  const { user } = useCurrentUser();
  const { transport, mesh, send, sendPrivate, sendChannel } = useMeshTransport();
  const [view, setView] = useState<MeshView>(null);
  const [draft, setDraft] = useState("");
  // Per-channel "reveal myself" state, keyed by channel id. Default off
  // (incognito), forward-only by construction (each message self-describes).
  const [revealByChannel, setRevealByChannel] = useState<Record<string, boolean>>({});
  // Inline create-channel form state (mirrors Concord's sidebar add flow).
  const [creatingChannel, setCreatingChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  // Channel pending a "leave?" confirmation (the destructive forget action).
  const [leaveChannelId, setLeaveChannelId] = useState<string | null>(null);
  // Nearby-members panel beside the broadcast room (mirrors Concord's member
  // pane): desktop shows/hides it inline; mobile slides it over.
  const [membersVisible, setMembersVisible] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { insertAtCursor } = useInsertText(textareaRef, draft, setDraft);

  // A peer that drops off the roster (left Bluetooth range) shouldn't leave the
  // DM pane pointing at a dead peer — fall back to the landing state.
  useEffect(() => {
    if (view?.type === "dm" && !mesh.peers.some((p) => p.peerID === view.peerID)) {
      setView(null);
    }
  }, [view, mesh.peers]);

  // If the selected channel is removed, fall back to the landing state.
  useEffect(() => {
    if (view?.type === "channel" && !mesh.channels.some((c) => c.id === view.channelId)) {
      setView(null);
    }
  }, [view, mesh.channels]);

  const selectedPeer = view?.type === "dm"
    ? mesh.peers.find((peer) => peer.peerID === view.peerID) ?? null
    : null;

  const selectedChannel = view?.type === "channel"
    ? mesh.channels.find((c) => c.id === view.channelId) ?? null
    : null;

  const directTransport = useMemo<ChatTransport>(
    () => ({
      messages: selectedPeer ? mesh.directMessages[selectedPeer.peerID] ?? [] : [],
      isLoading: transport.isLoading,
      canWrite: mesh.started && !!selectedPeer,
      canModerate: false,
    }),
    [mesh.directMessages, mesh.started, selectedPeer, transport.isLoading],
  );

  const channelTransport = useMemo<ChatTransport>(
    () => ({
      messages: selectedChannel ? mesh.channelMessages[selectedChannel.id] ?? [] : [],
      isLoading: transport.isLoading,
      canWrite: mesh.started && !!selectedChannel,
      canModerate: false,
    }),
    [mesh.channelMessages, mesh.started, selectedChannel, transport.isLoading],
  );

  // Resolve a mesh message author (its `pubkey` is the sender's peer id) to a
  // display identity: our own messages get the reserved self color; known peers
  // use their announced nickname; everyone gets a deterministic color + a
  // `#abcd` suffix from the peer id so same-named/anon peers stay distinct.
  const nicknameByPeer = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of mesh.peers) map.set(p.peerID, p.nickname);
    return map;
  }, [mesh.peers]);

  const resolveIdentity = useCallback(
    (peerID: string): MeshIdentity => {
      const isSelf = !!mesh.myPeerID && peerID === mesh.myPeerID;
      const nickname = isSelf ? mesh.myNickname : nicknameByPeer.get(peerID);
      return meshIdentity(peerID, nickname, isSelf);
    },
    [mesh.myPeerID, mesh.myNickname, nicknameByPeer],
  );

  // Insert an @-mention of a peer (by id) at the composer cursor — the same
  // `@name#suffix` token the mention autocomplete inserts, so it chips and
  // routes identically. Used by the message author popover's "Mention" action.
  const mentionPeer = useCallback(
    (peerID: string) => {
      const token = `${meshMentionToken(resolveIdentity(peerID))} `;
      const textarea = textareaRef.current;
      const start = textarea?.selectionStart ?? draft.length;
      const end = textarea?.selectionEnd ?? draft.length;
      insertAtCursor({ start, end, replacement: token });
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [resolveIdentity, insertAtCursor, draft],
  );

  // Open the Noise XX DM with a peer — the author popover's "Message" action.
  const openDM = useCallback((peerID: string) => setView({ type: "dm", peerID }), []);

  // Create a private channel from the inline sidebar form, then open it.
  const submitCreateChannel = useCallback(() => {
    const name = newChannelName.trim();
    if (!name) return;
    const color = CHANNEL_COLORS[mesh.channels.length % CHANNEL_COLORS.length];
    const channel = mesh.createChannel(name, color);
    setNewChannelName("");
    setCreatingChannel(false);
    setView({ type: "channel", channelId: channel.id });
  }, [newChannelName, mesh]);

  if (!user) {
    return <Navigate to="/" replace />;
  }

  const activeTransport =
    view?.type === "dm" ? directTransport : view?.type === "channel" ? channelTransport : transport;

  // Send already-resolved text over the active conversation (broadcast / DM /
  // private channel). Channels carry the per-channel "reveal myself" choice.
  const sendText = async (content: string) => {
    if (!content || !mesh.started || !view) return;
    if (view.type === "dm") {
      if (!selectedPeer) throw new Error("Peer unavailable");
      await sendPrivate(selectedPeer, content);
    } else if (view.type === "channel") {
      if (!selectedChannel) throw new Error("Channel unavailable");
      await sendChannel(selectedChannel.id, content, !!revealByChannel[selectedChannel.id]);
    } else {
      await send(content);
    }
  };

  const focusComposer = () => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  // Open the `@` picker, optionally seeding the draft (e.g. "/slap @").
  const openMentionPicker = (prefix?: string) => {
    setDraft(`${prefix ?? ""}@`);
    focusComposer();
  };

  // How the mesh dispatches a slash command's result. The mesh supports only
  // text rewrites + `/mention` (gated by `isMeshSlashCommand`), so it provides
  // no `onAction`; the shared runner reports any other action as unavailable.
  const slashHandlers: SlashCommandHandlers = {
    send: async (text) => {
      setDraft("");
      try {
        await sendText(text);
      } catch {
        // Surface failures by restoring the draft so the user can retry.
        setDraft(text);
      }
    },
    openMention: openMentionPicker,
    clearDraft: () => setDraft(""),
    onError: (message) =>
      toast({ title: "Command unavailable", description: message, variant: "destructive" }),
    isAllowed: isMeshSlashCommand,
  };

  const runSlash = (command: SlashCommand, arg: string) =>
    executeSlashCommand(command, arg, { canModerate: false, resolvePubkey: () => undefined }, slashHandlers);

  // Run a slash command picked from the menu (Tab/Enter/tap). Argument-less
  // ones run on select; the typed command word is the only arg context.
  const runCommandFromMenu = (command: SlashCommand) => {
    const parsed = parseSlashCommand(draft);
    void runSlash(command, parsed?.command === command ? parsed.arg : "");
  };

  const onSend = async () => {
    const content = draft.trim();
    if (!content || !mesh.started || !view) return;

    // Slash commands: rewrite/redirect before sending. A bare command word is
    // also handled here (e.g. "/me" with no text → error, not a literal send).
    if (content.startsWith("/")) {
      const parsed = parseSlashCommand(content);
      if (parsed) {
        await runSlash(parsed.command, parsed.arg);
        return;
      }
      // Unknown /command: fall through and send it literally.
    }

    setDraft("");
    try {
      await sendText(content);
    } catch {
      // Surface failures by restoring the draft so the user can retry.
      setDraft(content);
    }
  };

  return (
    <SwipeReveal
      open={view === null}
      onReveal={() => setView(null)}
      onClose={() => setView((v) => v ?? { type: "broadcast" })}
      underlay={
        <>
          <ServerRail onNavigate={() => setView(null)} />
          <MeshSidebar
            view={view}
            available={mesh.available}
            started={mesh.started}
            error={mesh.error}
            peers={mesh.peers}
            peerCount={mesh.peers.length}
            channels={mesh.channels}
            onRetry={() => void mesh.start()}
            onOpenBroadcast={() => setView({ type: "broadcast" })}
            onOpenDM={(peerID) => setView({ type: "dm", peerID })}
            onOpenChannel={(channelId) => setView({ type: "channel", channelId })}
            creatingChannel={creatingChannel}
            newChannelName={newChannelName}
            onToggleCreate={() => {
              setCreatingChannel((v) => !v);
              setNewChannelName("");
            }}
            onChangeNewChannelName={setNewChannelName}
            onSubmitCreate={submitCreateChannel}
            className="flex-1 sidebar:flex-none sidebar:w-60"
          />
        </>
      }
    >
      <main className="flex flex-col flex-1 min-w-0 safe-area-top bg-background h-full">
        {!mesh.available ? (
          <UnavailableState />
        ) : !view ? (
          <SelectState started={mesh.started} />
        ) : (
          <>
            <ChatHeader
              view={view}
              peer={selectedPeer}
              channel={selectedChannel}
              started={mesh.started}
              incognito={mesh.incognito}
              onToggleIncognito={() => mesh.setIncognito(!mesh.incognito)}
              reveal={selectedChannel ? !!revealByChannel[selectedChannel.id] : false}
              onToggleReveal={
                selectedChannel
                  ? () =>
                      setRevealByChannel((m) => ({
                        ...m,
                        [selectedChannel.id]: !m[selectedChannel.id],
                      }))
                  : undefined
              }
              onLeaveChannel={
                selectedChannel ? () => setLeaveChannelId(selectedChannel.id) : undefined
              }
              onBack={() => setView(null)}
              peerCount={mesh.peers.length}
              membersVisible={membersVisible}
              membersOpen={membersOpen}
              onToggleMembers={() => {
                setMembersVisible((v) => !v);
                setMembersOpen((v) => !v);
              }}
            />

            <div className="relative flex flex-1 min-h-0">
              <div className="flex-1 min-w-0 flex flex-col">
                <MessageTimeline
                  // Remount per conversation so the timeline's "had messages"
                  // skeleton guard resets on switch — otherwise leaving the
                  // populated broadcast for an empty DM looks perpetually loading.
                  key={
                    view.type === "dm"
                      ? `dm:${view.peerID}`
                      : view.type === "channel"
                        ? `ch:${view.channelId}`
                        : "broadcast"
                  }
                  transport={activeTransport}
                  className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4"
                  emptyState={
                    view.type === "dm" ? (
                      <EmptyDM peer={selectedPeer} />
                    ) : view.type === "channel" ? (
                      <EmptyChannel channel={selectedChannel} />
                    ) : (
                      <EmptyBroadcast />
                    )
                  }
                  renderMessage={(msg, continuation) => (
                    <MeshMessage
                      key={msg.id}
                      event={msg}
                      identity={resolveIdentity(msg.pubkey)}
                      peers={mesh.peers}
                      myPeerID={mesh.myPeerID}
                      continuation={continuation}
                      // Don't offer "Message" for a peer whose DM is already open.
                      onMessage={
                        view.type === "dm" && view.peerID === msg.pubkey ? undefined : openDM
                      }
                      onMention={mentionPeer}
                    />
                  )}
                />

                <div className="relative px-3 pb-safe pt-1 shrink-0">
                  {/* Autocompletes anchor to the composer textarea. Mentions suggest
                      nearby peers; slash commands offer the mesh-appropriate set. */}
                  <MeshMentionAutocomplete
                    textareaRef={textareaRef}
                    content={draft}
                    peers={mesh.peers}
                    onInsertMention={insertAtCursor}
                  />
                  <SlashCommandAutocomplete
                    textareaRef={textareaRef}
                    content={draft}
                    canModerate={false}
                    commandFilter={isMeshSlashCommand}
                    onInsertCommand={insertAtCursor}
                    onRunCommand={runCommandFromMenu}
                  />
                  <div className="flex items-end gap-2 rounded-2xl bg-secondary/40 px-3 py-1.5">
                    <textarea
                      ref={textareaRef}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void onSend();
                        }
                      }}
                      rows={1}
                      placeholder={composerPlaceholder(view, mesh.started, selectedPeer, selectedChannel)}
                      disabled={!mesh.started || (view.type === "dm" && !selectedPeer) || (view.type === "channel" && !selectedChannel)}
                      className="block w-full resize-none bg-transparent border-0 outline-none px-1 py-2 leading-5 text-base md:text-sm placeholder:text-muted-foreground disabled:opacity-50 max-h-40 overflow-y-auto"
                    />
                    <Button
                      size="icon"
                      aria-label="Send"
                      disabled={!mesh.started || !draft.trim() || (view.type === "dm" && !selectedPeer) || (view.type === "channel" && !selectedChannel)}
                      onClick={() => void onSend()}
                      className="size-9 shrink-0"
                    >
                      <Send className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Nearby-members panel (broadcast room + channels). In a channel,
                  rows offer "add to channel" (key handoff over the Noise DM). */}
              {(view.type === "broadcast" || view.type === "channel") && (
                <MeshMemberPanel
                  peers={mesh.peers}
                  activePeerID={null}
                  visible={membersVisible}
                  open={membersOpen}
                  available={mesh.available}
                  started={mesh.started}
                  inviteMode={view.type === "channel"}
                  onOpenDM={(peerID) => {
                    setMembersOpen(false);
                    openDM(peerID);
                  }}
                  onInvitePeer={
                    view.type === "channel" && selectedChannel
                      ? (peer) => {
                          void mesh.inviteToChannel(selectedChannel.id, peer).then(
                            () =>
                              toast({
                                title: "Invite sent",
                                description: `Shared "${selectedChannel.name}" with ${peer.nickname || "peer"} over an encrypted DM.`,
                              }),
                            () =>
                              toast({
                                title: "Invite failed",
                                description: "Couldn't reach that peer. They must be in range with a Noise session.",
                                variant: "destructive",
                              }),
                          );
                        }
                      : undefined
                  }
                  onClose={() => {
                    setMembersOpen(false);
                    setMembersVisible(false);
                  }}
                />
              )}
            </div>
          </>
        )}
      </main>

      <LeaveChannelDialog
        channel={mesh.channels.find((c) => c.id === leaveChannelId) ?? null}
        onOpenChange={(o) => !o && setLeaveChannelId(null)}
        onConfirm={() => {
          if (!leaveChannelId) return;
          mesh.removeChannel(leaveChannelId);
          setLeaveChannelId(null);
          setView(null);
        }}
      />
    </SwipeReveal>
  );
}

/**
 * The mesh "server" sidebar: a Mesh title, a `# nearby mesh` channel for the
 * broadcast room, and a Members roster of nearby peers (rows open Noise XX
 * DMs). Built on the shared {@link ChannelSidebarView} so it renders the same
 * frame as the NIP-29 channel list and Concord.
 */
function MeshSidebar({
  view,
  available,
  started,
  error,
  peers,
  peerCount,
  channels,
  onRetry,
  onOpenBroadcast,
  onOpenDM,
  onOpenChannel,
  creatingChannel,
  newChannelName,
  onToggleCreate,
  onChangeNewChannelName,
  onSubmitCreate,
  className,
}: {
  view: MeshView;
  available: boolean;
  started: boolean;
  error: string | null;
  peers: MeshPeer[];
  peerCount: number;
  channels: MeshChannel[];
  onRetry: () => void;
  onOpenBroadcast: () => void;
  onOpenDM: (peerID: string) => void;
  onOpenChannel: (channelId: string) => void;
  creatingChannel: boolean;
  newChannelName: string;
  onToggleCreate: () => void;
  onChangeNewChannelName: (name: string) => void;
  onSubmitCreate: () => void;
  className?: string;
}) {
  return (
    <ChannelSidebarView
      className={className}
      title="Mesh"
      subtitle={
        available
          ? started
            ? "Nearby · Noise XX encrypted"
            : "Starting Bluetooth mesh…"
          : "Unavailable here"
      }
      addChannelLabel="New private channel"
      onAddChannel={onToggleCreate}
      channelsHeaderExtra={
        creatingChannel ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSubmitCreate();
            }}
            className="px-2 py-1 flex items-center gap-1"
          >
            <Input
              value={newChannelName}
              onChange={(e) => onChangeNewChannelName(e.target.value)}
              placeholder="weekend trip"
              autoFocus
              maxLength={48}
              onKeyDown={(e) => {
                if (e.key === "Escape") onToggleCreate();
              }}
              className="h-7 text-sm"
            />
            <Button
              type="submit"
              size="icon"
              className="size-7 shrink-0"
              disabled={!newChannelName.trim()}
              aria-label="Create private channel"
            >
              <Plus className="size-3.5" />
            </Button>
          </form>
        ) : undefined
      }
      footer={
        <div className="px-3 pb-safe shrink-0">
          <LoginArea className="w-full flex" />
        </div>
      }
    >
      {/* Channels: the always-on broadcast room, then private channels. */}
      <ChannelRow
        icon={<Hash className="size-4 shrink-0" />}
        label="nearby mesh"
        active={view?.type === "broadcast"}
        onClick={onOpenBroadcast}
        trailing={
          <span className="flex items-center gap-0.5 text-xs">
            <Users className="size-3.5" />
            {peerCount}
          </span>
        }
      />
      {channels.map((channel) => (
        <ChannelRow
          key={channel.id}
          icon={<Lock className="size-3.5 shrink-0" style={{ color: channel.color }} />}
          label={channel.name}
          active={view?.type === "channel" && view.channelId === channel.id}
          onClick={() => onOpenChannel(channel.id)}
        />
      ))}

      {error && (
        <div className="px-4 py-2 text-xs text-destructive">
          {error}{" "}
          <button className="underline" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {/* Members: nearby peers. Tapping one opens a native Noise XX DM. */}
      <h3 className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Nearby{peers.length > 0 ? ` · ${peers.length}` : ""}
      </h3>
      {peers.length === 0 ? (
        <p className="px-4 py-1 text-xs text-muted-foreground/70">
          {available
            ? started
              ? "No nearby devices yet. Armada or bitchat devices in Bluetooth range appear here."
              : "Starting Bluetooth mesh…"
            : "Mesh chat runs on the Armada Android app."}
        </p>
      ) : (
        peers.map((peer) => (
          <MemberRow
            key={peer.peerID}
            peer={peer}
            active={view?.type === "dm" && view.peerID === peer.peerID}
            onClick={() => onOpenDM(peer.peerID)}
          />
        ))
      )}
    </ChannelSidebarView>
  );
}

/** A channel-list row matching `ChannelSidebar`'s `ChannelLink` styling. */
function ChannelRow({
  icon,
  label,
  active,
  onClick,
  trailing,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "gutter-tick w-full flex items-center gap-2 pl-4 pr-2 py-1.5 text-sm transition-colors text-left",
        "text-muted-foreground hover:text-foreground",
        active && "is-active text-foreground font-medium",
      )}
    >
      {icon}
      <span className="truncate flex-1">{label}</span>
      {trailing}
    </button>
  );
}

/** A member roster row (a nearby mesh peer) styled like a channel row. */
function MemberRow({
  peer,
  active,
  trailing,
  onClick,
}: {
  peer: MeshPeer;
  active?: boolean;
  trailing?: React.ReactNode;
  onClick: () => void;
}) {
  const identity = meshIdentity(peer.peerID, peer.nickname);
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "gutter-tick w-full flex items-center gap-2 pl-4 pr-2 py-1.5 text-sm transition-colors text-left",
        "text-muted-foreground hover:text-foreground",
        active && "is-active text-foreground font-medium",
      )}
    >
      <span
        className="size-6 shrink-0 rounded-full flex items-center justify-center text-[11px] font-semibold"
        style={{ backgroundColor: `${identity.color}33`, color: identity.color }}
      >
        {identity.name.slice(0, 1).toUpperCase() || "?"}
      </span>
      <span className="truncate flex-1" style={{ color: identity.color }}>{identity.name}</span>
      {trailing ?? (
        <span className="shrink-0 text-[10px] text-muted-foreground/60">#{identity.suffix}</span>
      )}
    </button>
  );
}

/** Chat-pane header (broadcast room, a peer DM, or a private channel). */
function ChatHeader({
  view,
  peer,
  channel,
  started,
  incognito,
  onToggleIncognito,
  reveal,
  onToggleReveal,
  onLeaveChannel,
  onBack,
  peerCount,
  membersVisible,
  membersOpen,
  onToggleMembers,
}: {
  view: NonNullable<MeshView>;
  peer: MeshPeer | null;
  channel: MeshChannel | null;
  started: boolean;
  incognito: boolean;
  onToggleIncognito: () => void;
  reveal: boolean;
  onToggleReveal?: () => void;
  onLeaveChannel?: () => void;
  onBack: () => void;
  peerCount: number;
  membersVisible: boolean;
  membersOpen: boolean;
  onToggleMembers: () => void;
}) {
  const isDm = view.type === "dm";
  const isChannel = view.type === "channel";
  const dmIdentity = isDm && peer ? meshIdentity(peer.peerID, peer.nickname) : null;
  const title = isDm ? dmIdentity?.name ?? "Mesh DM" : isChannel ? channel?.name ?? "Channel" : "nearby mesh";
  const membersShown = membersVisible || membersOpen;

  return (
    <header className="relative h-12 mx-2 mt-3 px-2 sidebar:px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
      {/* Mobile back → slides the chat away to reveal the mesh sidebar. */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Back to mesh"
        className="size-9 shrink-0 sidebar:hidden"
        onClick={onBack}
      >
        <ChevronLeft className="size-5" />
      </Button>
      {isDm ? (
        <span
          className="size-7 shrink-0 rounded-full flex items-center justify-center text-xs font-semibold"
          style={dmIdentity ? { backgroundColor: `${dmIdentity.color}33`, color: dmIdentity.color } : undefined}
        >
          {dmIdentity?.name.slice(0, 1).toUpperCase() || <MessageCircle className="size-4" />}
        </span>
      ) : isChannel ? (
        <Lock className="size-4 shrink-0" style={channel ? { color: channel.color } : undefined} />
      ) : (
        <Hash className="size-5 text-muted-foreground shrink-0" />
      )}
      <h1 className="font-semibold truncate min-w-0" style={dmIdentity ? { color: dmIdentity.color } : undefined}>{title}</h1>
      {dmIdentity && (
        <span className="text-[11px] text-muted-foreground/60 shrink-0">#{dmIdentity.suffix}</span>
      )}
      {/* Bluetooth status sits next to the conversation name. */}
      {started ? (
        <Bluetooth className="size-4 text-success shrink-0" />
      ) : (
        <BluetoothOff className="size-4 text-muted-foreground shrink-0" />
      )}
      {isChannel && (
        <span className="text-[11px] text-muted-foreground/60 shrink-0 hidden sidebar:inline">
          end-to-end encrypted
        </span>
      )}
      <span className="flex-1" />

      {/* Nearby-members toggle (broadcast room + channels). */}
      {!isDm && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={membersShown ? "Hide nearby" : "Show nearby"}
              aria-pressed={membersShown}
              className={cn(
                "size-8 shrink-0",
                membersShown ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={onToggleMembers}
            >
              <Users className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{membersShown ? "Hide nearby" : `Nearby · ${peerCount}`}</TooltipContent>
        </Tooltip>
      )}

      {/* Identity toggle. In a private channel this is the PER-CHANNEL reveal
          (sealed, members-only, forward-only); elsewhere it's the global mesh
          incognito announce. */}
      {isChannel && onToggleReveal ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={reveal ? "Revealing yourself in this channel" : "Posting anonymously in this channel"}
              aria-pressed={!reveal}
              className={cn(
                "size-8 shrink-0",
                reveal ? "text-muted-foreground hover:text-foreground" : "text-primary",
              )}
              onClick={onToggleReveal}
            >
              <VenetianMask className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {reveal
              ? "Showing your name to this channel · tap to go anonymous"
              : "Anonymous in this channel · tap to reveal yourself to members"}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={incognito ? "Incognito on — showing an anonymous name" : "Incognito off — showing your name"}
              aria-pressed={incognito}
              className={cn(
                "size-8 shrink-0",
                incognito ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={onToggleIncognito}
            >
              <VenetianMask className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {incognito ? "Incognito on · tap to show your name" : "Incognito off · tap to go anonymous"}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Channel: leave/forget (drops the key + local history). Destructive,
          so it's red and gated behind a confirmation dialog. */}
      {isChannel && onLeaveChannel && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Leave channel"
              className="size-8 shrink-0 text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={onLeaveChannel}
            >
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Leave channel (forgets the key)</TooltipContent>
        </Tooltip>
      )}
    </header>
  );
}

/**
 * The nearby-peers roster shown beside the broadcast room. Mirrors Concord's
 * member panel: a width-animated in-flow pane on desktop and a slide-over
 * overlay on mobile. Rows open a Noise XX DM with the peer.
 */
function MeshMemberPanel({
  peers,
  activePeerID,
  visible,
  open,
  available,
  started,
  inviteMode = false,
  onOpenDM,
  onInvitePeer,
  onClose,
}: {
  peers: MeshPeer[];
  activePeerID: string | null;
  visible: boolean;
  open: boolean;
  available: boolean;
  started: boolean;
  inviteMode?: boolean;
  onOpenDM: (peerID: string) => void;
  onInvitePeer?: (peer: MeshPeer) => void;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden",
        "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
        "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out",
        open ? "" : "pointer-events-none sidebar:pointer-events-auto",
        visible && "sidebar:w-[16.5rem]",
      )}
    >
      {/* Mobile backdrop: fades in/out in sync with the panel slide. */}
      <div
        className={cn(
          "absolute inset-0 bg-background transition-opacity duration-200 ease-out sidebar:hidden",
          open ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        className={cn(
          "relative h-full flex w-full sidebar:w-[16.5rem] transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "translate-x-full",
          visible ? "sidebar:translate-x-0" : "sidebar:translate-x-full",
        )}
      >
        <aside className="flex flex-col h-full w-full sidebar:w-[16.5rem] mx-2 mt-3 mb-2 clip-corner-lg bg-chrome overflow-hidden">
          {/* Mobile-only header with a close button. */}
          <div className="flex items-center justify-between px-4 h-12 shrink-0 sidebar:hidden">
            <span className="text-sm font-semibold">{inviteMode ? "Add to channel" : "Nearby"}</span>
            <Button variant="ghost" size="icon" aria-label="Close nearby" className="size-8" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable pb-safe">
            <h3 className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {inviteMode ? "Add nearby" : "Nearby"}{peers.length > 0 ? ` · ${peers.length}` : ""}
            </h3>
            {inviteMode && (
              <p className="px-4 pb-1 text-[11px] text-muted-foreground/70">
                Tap a peer to share this channel's key over an encrypted DM.
              </p>
            )}
            {peers.length === 0 ? (
              <p className="px-4 py-1 text-xs text-muted-foreground/70">
                {available
                  ? started
                    ? "No nearby devices yet. Armada or bitchat devices in Bluetooth range appear here."
                    : "Starting Bluetooth mesh…"
                  : "Mesh chat runs on the Armada Android app."}
              </p>
            ) : (
              peers.map((peer) => (
                <MemberRow
                  key={peer.peerID}
                  peer={peer}
                  active={activePeerID === peer.peerID}
                  trailing={inviteMode ? <UserPlus className="size-3.5 text-muted-foreground" /> : undefined}
                  onClick={() => (inviteMode ? onInvitePeer?.(peer) : onOpenDM(peer.peerID))}
                />
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SelectState({ started }: { started: boolean }) {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground p-8 text-center">
      <div className="flex flex-col items-center gap-3 max-w-sm">
        {started ? (
          <Radio className="size-12 opacity-30" />
        ) : (
          <Loader2 className="size-10 animate-spin opacity-40" />
        )}
        <p className="text-sm">
          {started ? "Open #nearby mesh, or pick a participant to start a DM" : "Starting Bluetooth mesh…"}
        </p>
      </div>
    </div>
  );
}

function UnavailableState() {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      <div className="flex flex-col items-center gap-3 max-w-xs text-center px-6">
        <BluetoothOff className="size-12 opacity-30" />
        <p className="text-sm font-medium">Mesh chat isn't available here</p>
        <p className="text-xs text-muted-foreground/70">
          Nearby Bluetooth chat runs on the Armada Android app, which talks to other devices directly over Bluetooth.
        </p>
      </div>
    </div>
  );
}

function EmptyBroadcast() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Radio className="size-10 text-muted-foreground/40 mb-3" />
      <p className="text-sm text-muted-foreground">No messages nearby yet</p>
      <p className="text-xs text-muted-foreground/60 mt-1">Messages appear when another Armada or bitchat device is in range.</p>
    </div>
  );
}

function EmptyDM({ peer }: { peer: MeshPeer | null }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <MessageCircle className="size-10 text-muted-foreground/40 mb-3" />
      <p className="text-sm text-muted-foreground">No mesh DMs yet</p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        {peer ? `Messages to ${peer.nickname} use bitchat Noise XX encryption.` : "This participant is no longer active."}
      </p>
    </div>
  );
}

function EmptyChannel({ channel }: { channel: MeshChannel | null }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center px-6">
      <Lock className="size-10 text-muted-foreground/40 mb-3" style={channel ? { color: `${channel.color}99` } : undefined} />
      <p className="text-sm text-muted-foreground">
        {channel ? `"${channel.name}" is a private channel` : "Channel unavailable"}
      </p>
      <p className="text-xs text-muted-foreground/60 mt-1 max-w-xs">
        Messages are end-to-end encrypted and relayed by every nearby device — only members holding the key can read them. Open the <Users className="inline size-3" /> nearby list to share the key and add people.
      </p>
    </div>
  );
}

function composerPlaceholder(
  view: NonNullable<MeshView>,
  started: boolean,
  peer: MeshPeer | null,
  channel: MeshChannel | null,
) {
  if (!started) return "Starting mesh…";
  if (view.type === "dm") return peer ? `Message ${peer.nickname}…` : "Participant unavailable";
  if (view.type === "channel") return channel ? `Message ${channel.name}…` : "Channel unavailable";
  return "Message nearby devices…";
}

/**
 * Confirmation before leaving a private channel. Leaving forgets the channel
 * key and local history irreversibly, so this guards against an accidental tap
 * on the (red) leave button in the header.
 */
function LeaveChannelDialog({
  channel,
  onOpenChange,
  onConfirm,
}: {
  channel: MeshChannel | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={channel !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave “{channel?.name ?? "channel"}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This forgets the channel key and its local history on this device. You won't be able to
            read new messages unless someone shares the key with you again. Other members are
            unaffected.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              onConfirm();
            }}
          >
            Leave channel
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default MeshPage;
