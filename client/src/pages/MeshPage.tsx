import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  Bluetooth,
  BluetoothOff,
  ChevronLeft,
  Hash,
  Loader2,
  MapPin,
  MessageCircle,
  Power,
  Radio,
  Send,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useInsertText } from "@/hooks/useInsertText";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { toast } from "@/hooks/useToast";
import { meshIdentity, meshMentionToken, type MeshIdentity } from "@/lib/meshIdentity";
import { isMeshSlashCommand } from "@/lib/meshSlashCommands";
import { getCurrentLocation, GeolocationError, geolocationErrorMessage } from "@/lib/geolocation";
import { encodeLocationContent } from "@/lib/location";
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
  | null;

/**
 * Bluetooth mesh chat for nearby bitchat-compatible devices. Mirrors the
 * server/channel shape (`ChannelSidebarView` + `SwipeReveal`) so it reads as a
 * "Mesh" server: a `# nearby mesh` channel for the broadcast room, and a
 * Members roster of nearby peers whose rows open native Noise XX DMs.
 */
export function MeshPage() {
  const { user } = useCurrentUser();
  const { transport, mesh, send, sendPrivate } = useMeshTransport();
  const [view, setView] = useState<MeshView>(null);
  const [draft, setDraft] = useState("");
  const [isSharingLocation, setIsSharingLocation] = useState(false);
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

  const selectedPeer = view?.type === "dm"
    ? mesh.peers.find((peer) => peer.peerID === view.peerID) ?? null
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

  if (!user) {
    return <Navigate to="/" replace />;
  }

  const activeTransport = view?.type === "dm" ? directTransport : transport;

  // Send already-resolved text over the active channel (broadcast or this DM).
  const sendText = async (content: string) => {
    if (!content || !mesh.started || !view) return;
    if (view.type === "dm") {
      if (!selectedPeer) throw new Error("Peer unavailable");
      await sendPrivate(selectedPeer, content);
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

  // Acquire the device position and broadcast it as a location message over
  // the mesh (plain-text content marker, decoded by MeshContent/LocationCard).
  const shareLocation = async () => {
    if (!mesh.started || !view || isSharingLocation) return;
    setIsSharingLocation(true);
    try {
      const point = await getCurrentLocation();
      await sendText(encodeLocationContent(point));
    } catch (err) {
      const message =
        err instanceof GeolocationError
          ? geolocationErrorMessage(err.kind)
          : "Couldn't determine your location. Try again.";
      toast({ title: "Location not shared", description: message, variant: "destructive" });
    } finally {
      setIsSharingLocation(false);
    }
  };

  // How the mesh dispatches a slash command's result. The mesh supports text
  // rewrites, `/mention` (gated by `isMeshSlashCommand`), and `/location`
  // (broadcasts the current position); other actions are reported unavailable.
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
    onAction: async (action) => {
      if (action.kind === "sendLocation") {
        setDraft("");
        await shareLocation();
      }
    },
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
            enabled={mesh.enabled}
            started={mesh.started}
            error={mesh.error}
            peers={mesh.peers}
            peerCount={mesh.peers.length}
            onRetry={() => void mesh.start()}
            onOpenBroadcast={() => setView({ type: "broadcast" })}
            onOpenDM={(peerID) => setView({ type: "dm", peerID })}
            className="flex-1 sidebar:flex-none sidebar:w-60"
          />
        </>
      }
    >
      <main className="flex flex-col flex-1 min-w-0 safe-area-top bg-background h-full">
        {!mesh.available ? (
          <UnavailableState />
        ) : !mesh.enabled ? (
          <DisabledState onEnable={() => mesh.setEnabled(true)} />
        ) : !view ? (
          <SelectState started={mesh.started} />
        ) : (
          <>
            <ChatHeader
              view={view}
              peer={selectedPeer}
              started={mesh.started}
              incognito={mesh.incognito}
              onToggleIncognito={() => mesh.setIncognito(!mesh.incognito)}
              onTurnOff={() => mesh.setEnabled(false)}
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
                  key={view.type === "dm" ? `dm:${view.peerID}` : "broadcast"}
                  transport={activeTransport}
                  className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-stable px-3 py-4"
                  emptyState={view.type === "dm" ? <EmptyDM peer={selectedPeer} /> : <EmptyBroadcast />}
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
                      placeholder={composerPlaceholder(view, mesh.started, selectedPeer)}
                      disabled={!mesh.started || (view.type === "dm" && !selectedPeer)}
                      className="block w-full resize-none bg-transparent border-0 outline-none px-1 py-2 leading-5 text-base md:text-sm placeholder:text-muted-foreground disabled:opacity-50 max-h-40 overflow-y-auto"
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Send location"
                      disabled={!mesh.started || isSharingLocation || (view.type === "dm" && !selectedPeer)}
                      onClick={() => void shareLocation()}
                      className="size-9 shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      {isSharingLocation ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <MapPin className="size-4" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      aria-label="Send"
                      disabled={!mesh.started || !draft.trim() || (view.type === "dm" && !selectedPeer)}
                      onClick={() => void onSend()}
                      className="size-9 shrink-0"
                    >
                      <Send className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>

              {/* Nearby-members panel (broadcast room only). Width-animated on
                  desktop, slide overlay on mobile — mirrors Concord. */}
              {view.type === "broadcast" && (
                <MeshMemberPanel
                  peers={mesh.peers}
                  activePeerID={null}
                  visible={membersVisible}
                  open={membersOpen}
                  available={mesh.available}
                  started={mesh.started}
                  onOpenDM={(peerID) => {
                    setMembersOpen(false);
                    openDM(peerID);
                  }}
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
  enabled,
  started,
  error,
  peers,
  peerCount,
  onRetry,
  onOpenBroadcast,
  onOpenDM,
  className,
}: {
  view: MeshView;
  available: boolean;
  enabled: boolean;
  started: boolean;
  error: string | null;
  peers: MeshPeer[];
  peerCount: number;
  onRetry: () => void;
  onOpenBroadcast: () => void;
  onOpenDM: (peerID: string) => void;
  className?: string;
}) {
  return (
    <ChannelSidebarView
      className={className}
      title="Mesh"
      subtitle={
        available
          ? enabled
            ? started
              ? "Nearby · Noise XX encrypted"
              : "Starting Bluetooth mesh…"
            : "Off"
          : "Unavailable here"
      }
      addChannelDisabled
      footer={
        <div className="px-3 pb-safe shrink-0">
          <LoginArea className="w-full flex" />
        </div>
      }
    >
      {/* Channels: the single broadcast room. */}
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
            ? enabled
              ? started
                ? "No nearby devices yet. Armada or bitchat devices in Bluetooth range appear here."
                : "Starting Bluetooth mesh…"
              : "Mesh chat is off. Turn it on to find nearby devices."
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
  onClick,
}: {
  peer: MeshPeer;
  active?: boolean;
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
      <span className="shrink-0 text-[10px] text-muted-foreground/60">#{identity.suffix}</span>
    </button>
  );
}

/** Chat-pane header (broadcast room or a peer DM). */
function ChatHeader({
  view,
  peer,
  started,
  incognito,
  onToggleIncognito,
  onTurnOff,
  onBack,
  peerCount,
  membersVisible,
  membersOpen,
  onToggleMembers,
}: {
  view: NonNullable<MeshView>;
  peer: MeshPeer | null;
  started: boolean;
  incognito: boolean;
  onToggleIncognito: () => void;
  onTurnOff: () => void;
  onBack: () => void;
  peerCount: number;
  membersVisible: boolean;
  membersOpen: boolean;
  onToggleMembers: () => void;
}) {
  const isDm = view.type === "dm";
  const dmIdentity = isDm && peer ? meshIdentity(peer.peerID, peer.nickname) : null;
  const title = isDm ? dmIdentity?.name ?? "Mesh DM" : "nearby mesh";
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
      ) : (
        <Hash className="size-5 text-muted-foreground shrink-0" />
      )}
      <h1 className="font-semibold truncate min-w-0" style={dmIdentity ? { color: dmIdentity.color } : undefined}>{title}</h1>
      {dmIdentity && (
        <span className="text-[11px] text-muted-foreground/60 shrink-0">#{dmIdentity.suffix}</span>
      )}
      <span className="flex-1" />
      {/* Nearby-members toggle (broadcast room only) — shows/hides the peer
          roster panel, mirroring Concord's members button. */}
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
      {/* Incognito toggle: ON (default) announces an anon name; OFF reveals the
          Armada display name to nearby devices. */}
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
      {/* Turn the mesh off entirely (stops Bluetooth + the background service).
          Mesh is opt-in, so the off switch lives right where it runs. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Turn mesh off"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={onTurnOff}
          >
            <Power className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Turn mesh off</TooltipContent>
      </Tooltip>
      {started ? (
        <Bluetooth className="size-4 text-success shrink-0" />
      ) : (
        <BluetoothOff className="size-4 text-muted-foreground shrink-0" />
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
  onOpenDM,
  onClose,
}: {
  peers: MeshPeer[];
  activePeerID: string | null;
  visible: boolean;
  open: boolean;
  available: boolean;
  started: boolean;
  onOpenDM: (peerID: string) => void;
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
            <span className="text-sm font-semibold">Nearby</span>
            <Button variant="ghost" size="icon" aria-label="Close nearby" className="size-8" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable pb-safe">
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
                  active={activePeerID === peer.peerID}
                  onClick={() => onOpenDM(peer.peerID)}
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

/**
 * The opt-in landing state: mesh is supported on this device but the user
 * hasn't turned it on. Nothing Bluetooth-related happens (no permission
 * prompt, no foreground service) until they do.
 */
function DisabledState({ onEnable }: { onEnable: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      <div className="flex flex-col items-center gap-3 max-w-xs text-center px-6">
        <Bluetooth className="size-12 opacity-30" />
        <p className="text-sm font-medium text-foreground">Mesh chat is off</p>
        <p className="text-xs text-muted-foreground/70">
          Chat with nearby Armada and bitchat devices directly over Bluetooth — no
          internet needed. Turning it on asks for Bluetooth permission and keeps a
          background connection (with a persistent notification) while active.
        </p>
        <Button className="mt-2" onClick={onEnable}>
          <Bluetooth className="size-4" />
          Turn on mesh chat
        </Button>
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

function composerPlaceholder(view: NonNullable<MeshView>, started: boolean, peer: MeshPeer | null) {
  if (!started) return "Starting mesh…";
  if (view.type === "dm") return peer ? `Message ${peer.nickname}…` : "Participant unavailable";
  return "Message nearby devices…";
}

export default MeshPage;
