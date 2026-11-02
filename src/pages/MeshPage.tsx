import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import {
  Bluetooth,
  BluetoothOff,
  ChevronLeft,
  Hash,
  Loader2,
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
import { PaneResizeHandle } from "@/components/layout/PaneResizeHandle";
import { ServerRail } from "@/components/layout/ServerRail";
import { SwipeReveal } from "@/components/layout/SwipeReveal";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useOverlayBack } from "@/hooks/useAndroidBack";
import { useAppContext } from "@/hooks/useAppContext";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useInsertText } from "@/hooks/useInsertText";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMeshTransport } from "@/hooks/useMeshTransport";
import { toast } from "@/hooks/useToast";
import { meshIdentity, meshMentionToken, type MeshIdentity } from "@/lib/meshIdentity";
import { sendsOnEnter } from "@/lib/sendOnEnter";
import { isMeshSlashCommand } from "@/lib/meshSlashCommands";
import {
  executeSlashCommand,
  parseSlashCommand,
  type SlashCommand,
  type SlashCommandHandlers,
} from "@/lib/slashCommands";
import { cn } from "@/lib/utils";
import { common, defineMessages, FormattedMessage, t, useIntl, type IntlShape } from "@/i18n";

import type { ChatTransport } from "@/components/chat/transport";
import type { MeshPeer } from "@/lib/bluetoothMesh";

const m = defineMessages({
  nearbyMesh: { id: "meshPage.nearbyMesh", defaultMessage: "nearby mesh" },
  turnOn: { id: "meshPage.turnOn", defaultMessage: "Turn on mesh chat" },
  noDevices: {
    id: "meshPage.noDevices",
    defaultMessage: "No nearby devices yet. Armada or bitchat devices in Bluetooth range appear here.",
  },
  starting: { id: "meshPage.starting", defaultMessage: "Starting Bluetooth mesh…" },
  androidOnly: { id: "meshPage.androidOnly", defaultMessage: "Mesh chat runs on the Armada Android app." },
  hideNearby: { id: "meshPage.hideNearby", defaultMessage: "Hide nearby" },
});

/** "Nearby", with the peer count once there is one. */
function NearbyHeading({ count }: { count: number }) {
  return count > 0 ? (
    <FormattedMessage id="meshPage.nearbyCount" defaultMessage="Nearby · {count}" values={{ count }} />
  ) : (
    <FormattedMessage id="meshPage.nearby" defaultMessage="Nearby" />
  );
}

/** What the chat pane shows; `null` is the nothing-selected landing state. */
type MeshView =
  | { type: "broadcast" }
  | { type: "dm"; peerID: string }
  | null;

/**
 * Bluetooth mesh chat with nearby bitchat-compatible devices, shaped like a
 * "Mesh" server: a `# nearby mesh` broadcast channel and a Members roster whose
 * rows open native Noise XX DMs.
 */
export function MeshPage() {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const isTouch = useIsTouch();
  const { transport, mesh, send, sendPrivate } = useMeshTransport();
  const [view, setView] = useState<MeshView>(null);
  const [draft, setDraft] = useState("");
  // Nearby-members panel beside the broadcast room (like Concord's member pane).
  const [membersVisible, setMembersVisible] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  // On mobile the roster covers the room, so back closes it before revealing the list.
  const isDesktop = useIsDesktop();
  useOverlayBack(() => {
    setMembersOpen(false);
    setMembersVisible(false);
    return true;
  }, membersOpen && view?.type === "broadcast" && !isDesktop);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { insertAtCursor } = useInsertText(textareaRef, draft, setDraft);

  // A peer that left range shouldn't leave the DM pane pointing at it.
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

  // Mesh author (peer id) → identity: reserved self color, announced nickname,
  // and a deterministic color + `#abcd` suffix so same-named peers stay distinct.
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

  // Insert the same `@name#suffix` token the mention autocomplete does.
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

  const openDM = useCallback((peerID: string) => setView({ type: "dm", peerID }), []);

  if (!user) {
    return <Navigate to="/" replace />;
  }

  const activeTransport = view?.type === "dm" ? directTransport : transport;

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

  const openMentionPicker = (prefix?: string) => {
    setDraft(`${prefix ?? ""}@`);
    focusComposer();
  };

  // Mesh supports only text rewrites + `/mention` (`isMeshSlashCommand`), so no `onAction`.
  const slashHandlers: SlashCommandHandlers = {
    send: async (text) => {
      setDraft("");
      try {
        await sendText(text);
      } catch {
        // Restore the draft so the user can retry.
        setDraft(text);
      }
    },
    openMention: openMentionPicker,
    clearDraft: () => setDraft(""),
    onError: (message) =>
      toast({
        title: t({ id: "meshPage.commandUnavailable", defaultMessage: "Command unavailable" }),
        description: message,
        variant: "destructive",
      }),
    isAllowed: isMeshSlashCommand,
  };

  const runSlash = (command: SlashCommand, arg: string) =>
    executeSlashCommand(command, arg, { canModerate: false, resolvePubkey: () => undefined }, slashHandlers);

  const runCommandFromMenu = (command: SlashCommand) => {
    const parsed = parseSlashCommand(draft);
    void runSlash(command, parsed?.command === command ? parsed.arg : "");
  };

  const onSend = async () => {
    const content = draft.trim();
    if (!content || !mesh.started || !view) return;

    // A bare command word is handled too ("/me" alone → error, not a literal send).
    if (content.startsWith("/")) {
      const parsed = parseSlashCommand(content);
      if (parsed) {
        await runSlash(parsed.command, parsed.arg);
        return;
      }
      // Unknown /command: sent literally.
    }

    setDraft("");
    try {
      await sendText(content);
    } catch {
      // Restore the draft so the user can retry.
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
            onSetEnabled={(enabled) => mesh.setEnabled(enabled)}
            onOpenBroadcast={() => setView({ type: "broadcast" })}
            onOpenDM={(peerID) => setView({ type: "dm", peerID })}
            className="touch:max-sidebar:flex-1"
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
                  // Remount per conversation to reset the "had messages" skeleton guard.
                  key={view.type === "dm" ? `dm:${view.peerID}` : "broadcast"}
                  transport={activeTransport}
                  className="flex-1 min-h-0"
                  emptyState={view.type === "dm" ? <EmptyDM peer={selectedPeer} /> : <EmptyBroadcast />}
                  renderMessage={(msg, continuation) => (
                    <MeshMessage
                      key={msg.id}
                      event={msg}
                      identity={resolveIdentity(msg.pubkey)}
                      peers={mesh.peers}
                      myPeerID={mesh.myPeerID}
                      continuation={continuation}
                      onMessage={
                        view.type === "dm" && view.peerID === msg.pubkey ? undefined : openDM
                      }
                      onMention={mentionPeer}
                    />
                  )}
                />

                <div className="relative px-3 pb-safe pt-1 shrink-0">
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
                        // With send-on-Enter off, Ctrl/Cmd+Enter sends.
                        const sendKey = sendsOnEnter(config.sendOnEnter, isTouch)
                          ? e.key === "Enter" && !e.shiftKey
                          : e.key === "Enter" && (e.ctrlKey || e.metaKey);
                        if (sendKey) {
                          e.preventDefault();
                          void onSend();
                        }
                      }}
                      rows={1}
                      placeholder={composerPlaceholder(intl, view, mesh.started, selectedPeer)}
                      disabled={!mesh.started || (view.type === "dm" && !selectedPeer)}
                      className="block w-full resize-none bg-transparent border-0 outline-none px-1 py-2 leading-5 text-base md:text-sm placeholder:text-muted-foreground disabled:opacity-50 max-h-40 overflow-y-auto"
                    />
                    <Button
                      size="icon"
                      aria-label={intl.formatMessage(common.send)}
                      disabled={!mesh.started || !draft.trim() || (view.type === "dm" && !selectedPeer)}
                      onClick={() => void onSend()}
                      className="size-9 shrink-0"
                    >
                      <Send className="size-4" />
                    </Button>
                  </div>
                </div>
              </div>

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

/** The mesh "server" sidebar, on the shared {@link ChannelSidebarView}. */
function MeshSidebar({
  view,
  available,
  enabled,
  started,
  error,
  peers,
  peerCount,
  onRetry,
  onSetEnabled,
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
  onSetEnabled: (enabled: boolean) => void;
  onOpenBroadcast: () => void;
  onOpenDM: (peerID: string) => void;
  className?: string;
}) {
  const intl = useIntl();
  return (
    <ChannelSidebarView
      className={className}
      title={intl.formatMessage({ id: "meshPage.title", defaultMessage: "Mesh" })}
      addChannelDisabled
      footer={
        <div className="px-3 pb-safe shrink-0 space-y-2">
          {available && (
            enabled ? (
              <Button
                variant="ghost"
                size="sm"
                className="w-full clip-corner-lg justify-start text-muted-foreground hover:text-destructive"
                onClick={() => onSetEnabled(false)}
              >
                <Power className="size-4" />
                <FormattedMessage id="meshPage.turnOff" defaultMessage="Turn off mesh chat" />
              </Button>
            ) : (
              <Button
                size="sm"
                className="w-full clip-corner-lg"
                onClick={() => onSetEnabled(true)}
              >
                <Bluetooth className="size-4" />
                <FormattedMessage {...m.turnOn} />
              </Button>
            )
          )}
          <LoginArea className="w-full flex" />
        </div>
      }
    >
      <ChannelRow
        icon={<Hash className="size-4 shrink-0" />}
        label={intl.formatMessage(m.nearbyMesh)}
        active={view?.type === "broadcast"}
        onClick={onOpenBroadcast}
        trailing={
          <span className="flex items-center gap-0.5 text-xs">
            <Users className="size-3.5" />
            {peerCount}
          </span>
        }
      />

      {enabled && error && (
        <div className="px-4 py-2 text-xs text-destructive">
          {error}{" "}
          <button className="underline" onClick={onRetry}>
            <FormattedMessage {...common.retry} />
          </button>
        </div>
      )}

      <h3 className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <NearbyHeading count={peers.length} />
      </h3>
      {peers.length === 0 ? (
        <p className="px-4 py-1 text-xs text-muted-foreground/70">
          {available
            ? enabled
              ? started
                ? <FormattedMessage {...m.noDevices} />
                : <FormattedMessage {...m.starting} />
              : (
                <FormattedMessage
                  id="meshPage.offHint"
                  defaultMessage="Mesh chat is off. Turn it on to find nearby devices."
                />
              )
            : <FormattedMessage {...m.androidOnly} />}
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
        "w-full flex items-center gap-2 px-2 py-1.5 text-sm transition-colors text-left",
        !active && "text-muted-foreground hover:text-foreground hover:bg-foreground/5 clip-corner-lg",
        active && "clip-corner-lg bg-primary text-primary-foreground font-medium",
      )}
    >
      {icon}
      <span className="truncate flex-1">{label}</span>
      {trailing}
    </button>
  );
}

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
        "w-full flex items-center gap-2 px-2 py-1.5 text-sm transition-colors text-left",
        !active && "text-muted-foreground hover:text-foreground hover:bg-foreground/5 clip-corner-lg",
        active && "clip-corner-lg bg-primary text-primary-foreground font-medium",
      )}
    >
      <span
        className="size-6 shrink-0 rounded-full flex items-center justify-center text-2xs font-semibold"
        style={{ backgroundColor: `${identity.color}33`, color: identity.color }}
      >
        {identity.name.slice(0, 1).toUpperCase() || "?"}
      </span>
      <span className="truncate flex-1" style={{ color: identity.color }}>{identity.name}</span>
      <span className="shrink-0 text-3xs text-muted-foreground/60">#{identity.suffix}</span>
    </button>
  );
}

function ChatHeader({
  view,
  peer,
  started,
  incognito,
  onToggleIncognito,
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
  onBack: () => void;
  peerCount: number;
  membersVisible: boolean;
  membersOpen: boolean;
  onToggleMembers: () => void;
}) {
  const intl = useIntl();
  const isDm = view.type === "dm";
  const dmIdentity = isDm && peer ? meshIdentity(peer.peerID, peer.nickname) : null;
  const title = isDm
    ? dmIdentity?.name ?? intl.formatMessage({ id: "meshPage.dmTitle", defaultMessage: "Mesh DM" })
    : intl.formatMessage(m.nearbyMesh);
  const membersShown = membersVisible || membersOpen;

  return (
    <header className="relative h-12 mx-gutter mt-1 sidebar:mt-3 px-2 sidebar:px-3 flex items-center gap-2 shrink-0 clip-corner-lg bg-chrome">
      <Button
        variant="ghost"
        size="icon"
        aria-label={intl.formatMessage({ id: "meshPage.backToMesh", defaultMessage: "Back to mesh" })}
        className="size-9 touch:size-11 shrink-0 sidebar:hidden"
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
        <span className="text-2xs text-muted-foreground/60 shrink-0">#{dmIdentity.suffix}</span>
      )}
      <span className="flex-1" />
      {!isDm && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={membersShown
                ? intl.formatMessage(m.hideNearby)
                : intl.formatMessage({ id: "meshPage.showNearby", defaultMessage: "Show nearby" })}
              aria-pressed={membersShown}
              className={cn(
                "size-8 touch:size-11 shrink-0",
                membersShown ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={onToggleMembers}
            >
              <Users className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {membersShown ? (
              <FormattedMessage {...m.hideNearby} />
            ) : (
              <FormattedMessage id="meshPage.nearbyCount" defaultMessage="Nearby · {count}" values={{ count: peerCount }} />
            )}
          </TooltipContent>
        </Tooltip>
      )}
      {/* Incognito ON (default) announces an anon name; OFF reveals the display name. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={incognito
              ? intl.formatMessage({
                id: "meshPage.incognitoOnLabel",
                defaultMessage: "Incognito on, showing an anonymous name",
              })
              : intl.formatMessage({ id: "meshPage.incognitoOffLabel", defaultMessage: "Incognito off, showing your name" })}
            aria-pressed={incognito}
            className={cn(
              "size-8 touch:size-11 shrink-0",
              incognito ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={onToggleIncognito}
          >
            <VenetianMask className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {incognito ? (
            <FormattedMessage id="meshPage.incognitoOnHint" defaultMessage="Incognito on · tap to show your name" />
          ) : (
            <FormattedMessage id="meshPage.incognitoOffHint" defaultMessage="Incognito off · tap to go anonymous" />
          )}
        </TooltipContent>
      </Tooltip>
      {started ? (
        <Bluetooth className="size-4 text-success shrink-0" />
      ) : (
        <BluetoothOff className="size-4 text-muted-foreground shrink-0" />
      )}
    </header>
  );
}

/** Nearby-peers roster beside the broadcast room (inline on desktop, slide-over on mobile). */
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
  const intl = useIntl();
  return (
    <div
      className={cn(
        "overflow-hidden",
        "absolute inset-0 z-20 sidebar:static sidebar:z-auto",
        "sidebar:shrink-0 sidebar:w-0 sidebar:transition-[width] sidebar:duration-200 sidebar:ease-out [[data-pane-resizing]_&]:transition-none",
        open ? "" : "pointer-events-none sidebar:pointer-events-auto",
        visible && "sidebar:w-[var(--member-list-w,16.5rem)]",
      )}
    >
      <div
        className={cn(
          "relative h-full flex w-full sidebar:w-[var(--member-list-w,16.5rem)] transition-transform duration-200 ease-out",
          open ? "transform-none" : "translate-x-full",
          visible ? "sidebar:transform-none" : "sidebar:translate-x-full",
        )}
      >
        <div aria-hidden className="absolute inset-0 -z-10 bg-background sidebar:hidden" />
        {visible && <PaneResizeHandle pane="member" />}
        <aside className="flex flex-col h-full w-full sidebar:w-[var(--member-list-w,16.5rem)] mx-gutter mt-3 mb-2 clip-corner-lg bg-chrome overflow-hidden">
          <div className="flex items-center justify-between px-4 h-12 shrink-0 sidebar:hidden">
            <span className="text-sm font-semibold">
              <FormattedMessage id="meshPage.nearby" defaultMessage="Nearby" />
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={intl.formatMessage({ id: "meshPage.closeNearby", defaultMessage: "Close nearby" })} className="size-8 touch:size-11" onClick={onClose}>
              <X className="size-4" />
            </Button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto scrollbar-stable pb-safe">
            <h3 className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <NearbyHeading count={peers.length} />
            </h3>
            {peers.length === 0 ? (
              <p className="px-4 py-1 text-xs text-muted-foreground/70">
                {available
                  ? started
                    ? <FormattedMessage {...m.noDevices} />
                    : <FormattedMessage {...m.starting} />
                  : <FormattedMessage {...m.androidOnly} />}
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
          {started ? (
            <FormattedMessage
              id="meshPage.selectHint"
              defaultMessage="Open #nearby mesh, or pick a participant to start a DM"
            />
          ) : (
            <FormattedMessage {...m.starting} />
          )}
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
        <p className="text-sm font-medium">
          <FormattedMessage id="meshPage.unavailable.title" defaultMessage="Mesh chat isn't available here" />
        </p>
        <p className="text-xs text-muted-foreground/70">
          <FormattedMessage
            id="meshPage.unavailable.description"
            defaultMessage="Nearby Bluetooth chat runs on the Armada Android app, which talks to other devices directly over Bluetooth."
          />
        </p>
      </div>
    </div>
  );
}

/**
 * Opt-in landing: nothing Bluetooth-related (permission prompt, foreground
 * service) happens until the user enables mesh.
 */
function DisabledState({ onEnable }: { onEnable: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center text-muted-foreground">
      <div className="flex flex-col items-center gap-3 max-w-xs text-center px-6">
        <Bluetooth className="size-12 opacity-30" />
        <p className="text-sm font-medium text-foreground">
          <FormattedMessage id="meshPage.disabled.title" defaultMessage="Mesh chat is off" />
        </p>
        <p className="text-xs text-muted-foreground/70">
          <FormattedMessage
            id="meshPage.disabled.description"
            defaultMessage="Chat with nearby Armada and bitchat devices over Bluetooth, without the internet. Turning it on asks for Bluetooth permission and keeps a background connection (with a persistent notification) while active."
          />
        </p>
        <Button className="mt-2 clip-corner-lg" onClick={onEnable}>
          <Bluetooth className="size-4" />
          <FormattedMessage {...m.turnOn} />
        </Button>
      </div>
    </div>
  );
}

function EmptyBroadcast() {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Radio className="size-10 text-muted-foreground/40 mb-3" />
      <p className="text-sm text-muted-foreground">
        <FormattedMessage id="meshPage.emptyBroadcast.title" defaultMessage="No messages nearby yet" />
      </p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        <FormattedMessage
          id="meshPage.emptyBroadcast.description"
          defaultMessage="Messages appear when another Armada or bitchat device is in range."
        />
      </p>
    </div>
  );
}

function EmptyDM({ peer }: { peer: MeshPeer | null }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <MessageCircle className="size-10 text-muted-foreground/40 mb-3" />
      <p className="text-sm text-muted-foreground">
        <FormattedMessage id="meshPage.emptyDm.title" defaultMessage="No mesh DMs yet" />
      </p>
      <p className="text-xs text-muted-foreground/60 mt-1">
        {peer ? (
          <FormattedMessage
            id="meshPage.emptyDm.description"
            defaultMessage="Messages to {name} use bitchat Noise XX encryption."
            values={{ name: peer.nickname }}
          />
        ) : (
          <FormattedMessage id="meshPage.emptyDm.inactive" defaultMessage="This participant is no longer active." />
        )}
      </p>
    </div>
  );
}

function composerPlaceholder(intl: IntlShape, view: NonNullable<MeshView>, started: boolean, peer: MeshPeer | null) {
  if (!started) return intl.formatMessage({ id: "meshPage.composer.starting", defaultMessage: "Starting mesh…" });
  if (view.type === "dm") {
    return peer
      ? intl.formatMessage({ id: "meshPage.composer.dm", defaultMessage: "Message {name}…" }, { name: peer.nickname })
      : intl.formatMessage({ id: "meshPage.composer.unavailable", defaultMessage: "Participant unavailable" });
  }
  return intl.formatMessage({ id: "meshPage.composer.broadcast", defaultMessage: "Message nearby devices…" });
}

export default MeshPage;
