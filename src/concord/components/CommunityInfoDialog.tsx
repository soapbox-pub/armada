import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  Folder,
  Hash,
  History,
  ImagePlus,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Shield,
  Timer,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DiscordBridgeSection } from "@/components/ImportFromDiscord";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OwnerAvatar, OwnerSlashRepo, RepositoryPicker, type PickedRepository } from "@/components/projects/RepositoryPicker";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useNostr } from "@nostrify/react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ImageLightbox } from "@/concord/components/ImageLightbox";
import { HistoryAuditDialog } from "@/concord/components/HistoryAuditDialog";
import {
  COMMUNITY_TIMER_PRESETS,
  formatCommunityTimer,
  messageExpirationOf,
  publishTimerNotices,
} from "@/concord/lib/disappearing";
import { categoryKey, categoryNames } from "@/concord/lib/channelCategory";
import { useCommunityManagement } from "@/concord/hooks/useCommunityActions";
import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { refreshInviteBundlesFor } from "@/concord/hooks/useRekey";
import { useMetadataActions } from "@/concord/hooks/useRoles";
import { DisplayName } from "@/components/DisplayName";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { useUploadFile } from "@/hooks/useUploadFile";
import { encryptImageBlob } from "@/concord/lib/image";
import { mirrorHistoryToRelays, type MirrorProgress } from "@/concord/lib/relayMirror";
import {
  MAX_COMMUNITY_RELAYS,
  type Channel,
  type CommunityMetadata,
  type Community,
  type ImagePointer,
} from "@/concord/lib/types";
import { cn } from "@/lib/utils";
import { channelGitRepositoryAttachments } from "@/concord/lib/types";
import { fetchGitRepositoryAnnouncement } from "@/lib/gitRepositoryResolver";
import { parseGitRepositoryAddress } from "@/lib/gitActivity";

/**
 * The single "community" surface: the same view is shown to everyone (icon,
 * banner, name, description, owner, member count, relays, channels). Viewers
 * with MANAGE_METADATA can edit the name / description / icon / banner inline
 * (Signal-style — tap to change); viewers with MANAGE_CHANNELS can rename,
 * delete and add channels. Edits publish version-chained editions; every
 * member's fold re-checks the permission (CORD-02/04), so the UI gating is a
 * convenience, not the enforcement point.
 */
export function CommunityInfoDialog({
  community,
  metadata,
  ownerHex,
  memberCount,
  canManageMetadata,
  canManageChannels,
  channelRoles,
  onPrivatiseChannel,
  onRotateChannelKey,
  open,
  onOpenChange,
}: {
  community: Community | undefined;
  metadata: CommunityMetadata | undefined;
  ownerHex: string | undefined;
  memberCount: number;
  canManageMetadata: boolean;
  canManageChannels: boolean;
  /** Per channel id, the Roles scoped to it — its access list (CORD-04 §2). */
  channelRoles?: ReadonlyMap<string, Array<{ id: string; name: string }>>;
  /** Convert a public channel to private (CORD-03 §2). */
  onPrivatiseChannel?: (channelIdHex: string) => Promise<void>;
  /** Re-key a private channel to exactly its entitled members. */
  onRotateChannelKey?: (channelIdHex: string) => Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md border-0 rounded-none p-0 bg-transparent shadow-none">
        <DialogTitle className="sr-only">Community</DialogTitle>
        <div className="clip-corner-lg bg-chrome max-h-[85vh] overflow-y-auto">
          {community && (
            <InfoBody
              community={community}
              metadata={metadata}
              ownerHex={ownerHex}
              memberCount={memberCount}
              canManageMetadata={canManageMetadata}
              canManageChannels={canManageChannels}
              channelRoles={channelRoles}
              onPrivatiseChannel={onPrivatiseChannel}
              onRotateChannelKey={onRotateChannelKey}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InfoBody({
  community,
  metadata,
  ownerHex,
  memberCount,
  canManageMetadata,
  canManageChannels,
  channelRoles,
  onPrivatiseChannel,
  onRotateChannelKey,
}: {
  community: Community;
  metadata: CommunityMetadata | undefined;
  ownerHex: string | undefined;
  memberCount: number;
  canManageMetadata: boolean;
  canManageChannels: boolean;
  channelRoles?: ReadonlyMap<string, Array<{ id: string; name: string }>>;
  onPrivatiseChannel?: (channelIdHex: string) => Promise<void>;
  onRotateChannelKey?: (channelIdHex: string) => Promise<void>;
}) {
  const { updateMetadata, isUpdating } = useMetadataActions(community);
  const { mutateAsync: uploadFile } = useUploadFile();

  const name = metadata?.name || community.name;
  const description = metadata?.description?.trim();
  const relays = metadata?.relays ?? community.relays;

  const bannerUrl = useDecryptedImage(metadata?.banner);
  const iconUrl = useDecryptedImage(metadata?.icon);
  const [iconZoom, setIconZoom] = useState(false);
  const [bannerZoom, setBannerZoom] = useState(false);
  const [uploading, setUploading] = useState<"icon" | "banner" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editingField, setEditingField] = useState<"name" | "description" | null>(null);

  const bannerInputRef = useRef<HTMLInputElement>(null);
  const iconInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (which: "icon" | "banner", file: File) => {
    setError(null);
    setUploading(which);
    try {
      const { ciphertext, key, nonce, hash } = await encryptImageBlob(file);
      const tags = await uploadFile(
        new File([ciphertext], `${which}.enc`, { type: "application/octet-stream" }),
      );
      const url = tags[0]?.[1];
      if (!url) throw new Error("Upload returned no URL.");
      const image: ImagePointer = { url, key, nonce, hash };
      await updateMetadata(which === "icon" ? { icon: image } : { banner: image });
      toast({ title: which === "icon" ? "Icon updated" : "Banner updated" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setUploading(null);
    }
  };

  const saveField = async (field: "name" | "description", value: string) => {
    setError(null);
    try {
      await updateMetadata(field === "name" ? { name: value } : { description: value });
      setEditingField(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save changes.");
    }
  };

  return (
    <div className="space-y-5">
      {/* Banner: shown when present, or as an add affordance for editors. */}
      {(bannerUrl || canManageMetadata) && (
        <div className="relative -mb-2">
          {bannerUrl ? (
            <button
              type="button"
              className="block h-24 w-full overflow-hidden cursor-zoom-in"
              aria-label="View banner"
              onClick={() => setBannerZoom(true)}
            >
              <img src={bannerUrl} alt="" className="size-full object-cover" />
            </button>
          ) : (
            <button
              type="button"
              className="flex h-24 w-full items-center justify-center bg-secondary/40 text-muted-foreground transition-colors hover:bg-secondary/60"
              onClick={() => bannerInputRef.current?.click()}
              aria-label="Add banner"
            >
              <ImagePlus className="size-5" />
            </button>
          )}
          {canManageMetadata && (
            <button
              type="button"
              className="absolute bottom-2 right-2 grid size-8 place-items-center rounded-full bg-background/70 text-foreground backdrop-blur transition-colors hover:bg-background/90"
              onClick={() => bannerInputRef.current?.click()}
              disabled={uploading === "banner"}
              aria-label="Change banner"
            >
              {uploading === "banner" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Pencil className="size-3.5" />
              )}
            </button>
          )}
        </div>
      )}

      <div className={cn("space-y-5 px-6 pb-6 sm:px-7 sm:pb-7", !(bannerUrl || canManageMetadata) && "pt-6 sm:pt-7")}>
        <div className="flex flex-col items-center text-center gap-3">
          <div className="relative">
            {iconUrl ? (
              <button
                type="button"
                className="cursor-zoom-in rounded-2xl"
                aria-label="View icon"
                onClick={() => setIconZoom(true)}
              >
                <img src={iconUrl} alt="" className="size-16 rounded-2xl object-cover" />
              </button>
            ) : canManageMetadata ? (
              <button
                type="button"
                className="grid size-16 place-items-center rounded-2xl bg-secondary/50 text-muted-foreground transition-colors hover:bg-secondary/70"
                onClick={() => iconInputRef.current?.click()}
                aria-label="Add icon"
              >
                <ImagePlus className="size-5" />
              </button>
            ) : (
              <div className="grid size-16 place-items-center rounded-2xl bg-primary/15 text-primary">
                <span className="text-2xl font-semibold">{name[0]?.toUpperCase() ?? "?"}</span>
              </div>
            )}
            {canManageMetadata && (
              <button
                type="button"
                className="absolute -bottom-1 -right-1 grid size-6 place-items-center rounded-full bg-background text-foreground ring-1 ring-border transition-colors hover:bg-secondary"
                onClick={() => iconInputRef.current?.click()}
                disabled={uploading === "icon"}
                aria-label="Change icon"
              >
                {uploading === "icon" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Pencil className="size-3" />
                )}
              </button>
            )}
          </div>

          {editingField === "name" ? (
            <InlineEdit
              initial={name}
              saving={isUpdating}
              multiline={false}
              onCancel={() => setEditingField(null)}
              onSave={(v) => saveField("name", v)}
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <h2 className="text-lg font-semibold leading-tight break-words">{name}</h2>
              {canManageMetadata && (
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0 text-muted-foreground"
                  aria-label="Edit name"
                  onClick={() => setEditingField("name")}
                >
                  <Pencil className="size-3" />
                </Button>
              )}
            </div>
          )}
        </div>

        {iconUrl && iconZoom && <ImageLightbox src={iconUrl} onClose={() => setIconZoom(false)} />}
        {bannerUrl && bannerZoom && <ImageLightbox src={bannerUrl} onClose={() => setBannerZoom(false)} />}

        {/* Description */}
        {editingField === "description" ? (
          <InlineEdit
            initial={description ?? ""}
            saving={isUpdating}
            multiline
            placeholder="What's this community about?"
            onCancel={() => setEditingField(null)}
            onSave={(v) => saveField("description", v)}
          />
        ) : description ? (
          <div className="flex items-start gap-1.5">
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {description}
            </p>
            {canManageMetadata && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground"
                aria-label="Edit description"
                onClick={() => setEditingField("description")}
              >
                <Pencil className="size-3" />
              </Button>
            )}
          </div>
        ) : (
          canManageMetadata && (
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start gap-1.5 text-muted-foreground"
              onClick={() => setEditingField("description")}
            >
              <Plus className="size-3.5" /> Add a description
            </Button>
          )
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-3">
          {ownerHex && <OwnerRow pubkey={ownerHex} />}
          <div className="flex items-center gap-2.5 text-sm">
            <Users className="size-4 shrink-0 text-muted-foreground" />
            <span>
              {memberCount} {memberCount === 1 ? "member" : "members"}
            </span>
          </div>
        </div>

        <DisappearingSection community={community} metadata={metadata} canManage={canManageMetadata} />

        <ChannelsSection community={community} canManage={canManageChannels} channelRoles={channelRoles} onPrivatiseChannel={onPrivatiseChannel} onRotateChannelKey={onRotateChannelKey} />

        <ConnectedRepositoriesSection community={community} canManage={canManageChannels} />

        <DiscordBridgeSection canManage={canManageChannels} />

        <RelaysSection
          community={community}
          metadata={metadata}
          relays={relays}
          canManage={canManageMetadata}
        />

        <HistorySection community={community} />
      </div>

      <input
        ref={bannerInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload("banner", f);
          e.target.value = "";
        }}
      />
      <input
        ref={iconInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload("icon", f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/**
 * "Verify & export history" — opens the {@link HistoryAuditDialog}, the in-app
 * gate for ensuring a complete decrypted history before acting on (or archiving)
 * a community. Available to every member; the audit reads only what this member
 * can already decrypt.
 */
function HistorySection({ community }: { community: Community }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <History className="size-4" />
        History
      </div>
      <p className="text-sm text-muted-foreground">
        Read every channel to its floor across all relays, verify completeness, and export a copy
        (self-contained HTML, JSON, TXT, or CSV).
      </p>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Verify &amp; export history
      </Button>
      <HistoryAuditDialog community={community} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

/** Active NIP-34 attachments across this community's channels. Historical, detached
 * intervals remain in the control-plane metadata but intentionally aren't listed. */
export function ConnectedRepositoriesSection({
  community,
  canManage,
}: {
  community: Community;
  canManage: boolean;
}) {
  const channels = useChannels(community);
  const { data: folded } = useControlFold(community);
  const { attachRepository, detachRepository } = useCommunityManagement(community);
  const [connectOpen, setConnectOpen] = useState(false);

  const repositories = channels.flatMap((channel) => {
    const metadata = folded?.channels.get(channel.idHex)?.metadata;
    return metadata
      ? channelGitRepositoryAttachments(metadata)
          .filter((attachment) => attachment.detachedAt === undefined)
          .map((attachment) => ({ channel, attachment }))
      : [];
  });

  // Nothing connected and no right to connect anything: a community that never
  // touches git shouldn't carry a permanently empty git section.
  if (repositories.length === 0 && !canManage) return null;

  const connectedCoordinates = new Set(repositories.map(({ attachment }) => attachment.address.coordinate));
  // A channel already holding a repository is spoken for: a second one would
  // blend two projects into one timeline. Shown, but not selectable.
  const repositoryByChannel = new Map<string, { owner: string; name: string }>();
  for (const { channel, attachment } of repositories) {
    if (!repositoryByChannel.has(channel.idHex)) {
      repositoryByChannel.set(channel.idHex, { owner: attachment.address.owner, name: attachment.address.identifier });
    }
  }

  const connect = async (channelIdHex: string, repository: PickedRepository) => {
    // The announcement is authoritative for activity relays; any address the
    // user pasted contributes only additional discovery hints.
    await attachRepository({ channelIdHex, address: repository.coordinate, relayHints: repository.relayHints });
    toast({ title: "Repository connected", description: repository.displayName });
  };

  const detach = async (channel: Channel, address: string, name: string) => {
    if (!confirm(`Disconnect ${name} from #${channel.name}? Historical activity remains attached to its original interval.`)) return;
    try {
      await detachRepository({ channelIdHex: channel.idHex, address });
      toast({ title: "Repository disconnected", description: name });
    } catch (e) {
      toast({ title: "Couldn't disconnect repository", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Connected repositories</span>
        {canManage && channels.length > 0 && (
          <Button type="button" size="icon" variant="ghost" className="size-6 shrink-0 text-muted-foreground" aria-label="Connect repository" onClick={() => setConnectOpen(true)}>
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="space-y-1 rounded-lg bg-secondary/40 p-1">
        {repositories.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No repositories connected.</p>}
        {repositories.map(({ channel, attachment }) => (
          <ConnectedRepositoryRow
            key={`${channel.idHex}:${attachment.address.coordinate}`}
            channel={channel}
            address={attachment.address.coordinate}
            owner={attachment.address.owner}
            relayHints={attachment.relayHints}
            fallbackName={attachment.address.identifier}
            canManage={canManage}
            onDetach={() => detach(channel, attachment.address.coordinate, attachment.address.identifier)}
          />
        ))}
      </div>
      {canManage && (
        <ConnectRepositoryDialog
          open={connectOpen}
          onOpenChange={setConnectOpen}
          channels={channels}
          connectedCoordinates={connectedCoordinates}
          repositoryByChannel={repositoryByChannel}
          onConnect={connect}
        />
      )}
    </div>
  );
}

/** Pick a repository, then the channel it belongs to. Mirrors the create-channel wizard. */
function ConnectRepositoryDialog({ open, onOpenChange, channels, connectedCoordinates, repositoryByChannel, onConnect }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: Channel[];
  connectedCoordinates: ReadonlySet<string>;
  repositoryByChannel: ReadonlyMap<string, { owner: string; name: string }>;
  onConnect: (channelIdHex: string, repository: PickedRepository) => Promise<unknown>;
}) {
  const [picked, setPicked] = useState<PickedRepository | null>(null);
  // The channel a write is in flight for. The control plane folds our own
  // attachment before the publish resolves, so this row must keep reading as
  // pending rather than flipping to "already connected" under the cursor.
  const [pendingChannelId, setPendingChannelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connecting = pendingChannelId !== null;

  useEffect(() => {
    if (!open) return;
    setPicked(null);
    setPendingChannelId(null);
    setError(null);
  }, [open]);

  const connect = async (channelIdHex: string) => {
    if (!picked || connecting) return;
    setError(null);
    setPendingChannelId(channelIdHex);
    try {
      await onConnect(channelIdHex, picked);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect repository.");
    } finally {
      setPendingChannelId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !connecting && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            {picked && (
              <Button variant="ghost" size="icon" className="-ml-1.5 size-7" aria-label="Back" disabled={connecting} onClick={() => setPicked(null)}>
                <ArrowLeft className="size-4" />
              </Button>
            )}
            {picked ? "Choose a channel" : "Connect a repository"}
          </DialogTitle>
        </DialogHeader>

        {!picked ? (
          <RepositoryPicker connectedCoordinates={connectedCoordinates} onSelect={setPicked} />
        ) : (
          <div className="min-w-0 space-y-3">
            <div className="flex min-w-0 items-center gap-2.5 clip-corner-lg border border-border/60 bg-card p-2.5">
              <OwnerAvatar pubkey={picked.owner} />
              <span className="min-w-0 flex-1">
                <OwnerSlashRepo owner={picked.owner} name={picked.displayName} />
                <span className="block truncate text-xs text-muted-foreground">Pick the channel its activity should appear in.</span>
              </span>
            </div>
            <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg bg-secondary/40 p-1">
              {channels.map((channel) => {
                const pending = pendingChannelId === channel.idHex;
                // While our own write lands, the row stays "Connecting…".
                const taken = pending ? undefined : repositoryByChannel.get(channel.idHex);
                return (
                  <button
                    key={channel.idHex}
                    type="button"
                    disabled={connecting || Boolean(taken)}
                    onClick={() => void connect(channel.idHex)}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                      taken ? "opacity-50" : "hover:bg-foreground/[0.05] disabled:opacity-50",
                    )}
                  >
                    {channel.isPrivate ? <Lock className="size-4 shrink-0 text-muted-foreground" /> : <Hash className="size-4 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{channel.name}</span>
                      {pending
                        ? <span className="block truncate text-xs text-muted-foreground">Connecting…</span>
                        : taken && <span className="block truncate text-xs text-muted-foreground">Already connected to {taken.name}</span>}
                    </span>
                    {pending && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
                  </button>
                );
              })}
            </div>
            {/* Not while connecting: our own in-flight attachment would make
                every channel look spoken for mid-write. */}
            {!connecting && channels.every((channel) => repositoryByChannel.has(channel.idHex)) && (
              <p className="text-xs text-muted-foreground">
                Every channel already has a repository. Add a channel first, or create a repository channel from the channel list.
              </p>
            )}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConnectedRepositoryRow({ channel, address, owner, relayHints, fallbackName, canManage, onDetach }: {
  channel: Channel;
  address: string;
  owner: string;
  relayHints: string[];
  fallbackName: string;
  canManage: boolean;
  onDetach: () => void;
}) {
  const { nostr } = useNostr();
  const { data } = useQuery({
    queryKey: ["git-repository-announcement", address, relayHints],
    queryFn: () => {
      const parsed = parseGitRepositoryAddress(address);
      if (!parsed) throw new Error("Invalid connected repository address.");
      return fetchGitRepositoryAnnouncement(nostr, {
        address: parsed,
        relayHints,
      });
    },
    staleTime: 60_000,
  });
  const name = data?.announcement.name || fallbackName;
  return <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5">
    <OwnerAvatar pubkey={owner} className="size-6" />
    <span className="min-w-0 flex-1"><OwnerSlashRepo owner={owner} name={name} /></span>
    <span className="shrink-0 text-[11px] text-muted-foreground">#{channel.name}</span>
    {canManage && <Button type="button" size="icon" variant="ghost" className="size-6 shrink-0 text-muted-foreground hover:text-destructive" aria-label={`Disconnect ${name}`} title={address} onClick={onDetach}><Trash2 className="size-3.5" /></Button>}
  </div>;
}

/** An inline text/textarea editor with save + cancel, used for name & description. */
function InlineEdit({
  initial,
  saving,
  multiline,
  placeholder,
  onSave,
  onCancel,
}: {
  initial: string;
  saving: boolean;
  multiline: boolean;
  placeholder?: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);

  return (
    <form
      className="flex w-full items-start gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(value.trim());
      }}
    >
      {multiline ? (
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          rows={3}
          autoFocus
          className="flex-1"
        />
      ) : (
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          autoFocus
          autoComplete="off"
          className="h-8 flex-1 text-center"
        />
      )}
      <Button
        type="submit"
        size="icon"
        variant="ghost"
        className="size-8 shrink-0"
        disabled={saving || (!multiline && !value.trim())}
        aria-label="Save"
      >
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8 shrink-0 text-muted-foreground"
        onClick={onCancel}
        disabled={saving}
        aria-label="Cancel"
      >
        <X className="size-4" />
      </Button>
    </form>
  );
}

function OwnerRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const displayName = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <Avatar className="size-6 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-[10px]">
          {displayName[0]?.toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate">
        <DisplayName pubkey={pubkey} name={displayName} />
      </span>
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-medium text-primary">
        <Shield className="size-3" />
        Owner
      </span>
    </div>
  );
}

/** The community's channels. Read-only for everyone; rename / delete / add for
 *  viewers with MANAGE_CHANNELS. */
function ChannelsSection({
  community,
  canManage,
  channelRoles,
  onPrivatiseChannel,
  onRotateChannelKey,
}: {
  community: Community;
  canManage: boolean;
  channelRoles?: ReadonlyMap<string, Array<{ id: string; name: string }>>;
  onPrivatiseChannel?: (channelIdHex: string) => Promise<void>;
  onRotateChannelKey?: (channelIdHex: string) => Promise<void>;
}) {
  const channels = useChannels(community);
  const { renameChannel, isRenaming, setChannelCategory, isFiling, deleteChannel, createChannel, isAddingChannel, moveChannel, isMovingChannel } =
    useCommunityManagement(community);

  // Existing category names, in sidebar order, offered when filing a channel
  // so a moderator picks "Voice" rather than retyping it as "voice".
  const categories = useMemo(() => categoryNames(channels, (ch) => ch.category), [channels]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      await createChannel({ name });
      setNewName("");
      setCreating(false);
    } catch (e) {
      toast({
        title: "Couldn't create channel",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Channels
        </span>
        {canManage && !creating && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label="Add channel"
            onClick={() => setCreating(true)}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="space-y-1 rounded-lg bg-secondary/40 p-1">
        {channels.map((ch, index) => (
          <ChannelRow
            key={ch.idHex}
            channel={ch}
            canManage={canManage}
            disabled={isRenaming || isFiling || isMovingChannel}
            categories={categories}
            onRename={(name) => renameChannel({ channelIdHex: ch.idHex, name })}
            onMove={canManage ? async (direction) => {
              try {
                await moveChannel({ channelIdHex: ch.idHex, direction });
              } catch (e) {
                toast({ title: "Couldn't reorder", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
              }
            } : undefined}
            canMoveUp={index > 0}
            canMoveDown={index < channels.length - 1}
            accessRoles={channelRoles?.get(ch.idHex) ?? []}
            onPrivatise={onPrivatiseChannel ? () => onPrivatiseChannel(ch.idHex) : undefined}
            onRotateKey={onRotateChannelKey ? () => onRotateChannelKey(ch.idHex) : undefined}
            onSetCategory={(category) => setChannelCategory({ channelIdHex: ch.idHex, category })}
            onDelete={
              canManage && channels.length > 1
                ? async () => {
                    if (!confirm(`Delete #${ch.name}? Its id is never reused.`)) return;
                    try {
                      await deleteChannel({ channelIdHex: ch.idHex });
                      toast({ title: "Channel deleted" });
                    } catch (e) {
                      toast({
                        title: "Couldn't delete",
                        description: e instanceof Error ? e.message : undefined,
                        variant: "destructive",
                      });
                    }
                  }
                : undefined
            }
          />
        ))}
        {creating && (
          <form
            className="flex items-center gap-1 px-1"
            onSubmit={(e) => {
              e.preventDefault();
              handleCreate();
            }}
          >
            <Hash className="size-3.5 shrink-0 text-muted-foreground" />
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="new-channel"
              autoFocus
              className="h-7 text-sm"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
            />
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              disabled={isAddingChannel || !newName.trim()}
              aria-label="Create channel"
            >
              {isAddingChannel ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

function ChannelRow({
  channel,
  canManage,
  disabled,
  categories,
  onRename,
  onSetCategory,
  onDelete,
  onMove,
  canMoveUp,
  canMoveDown,
  accessRoles,
  onPrivatise,
  onRotateKey,
}: {
  channel: Channel;
  canManage: boolean;
  disabled: boolean;
  /** Category names already in use, offered so near-duplicates aren't retyped. */
  categories: string[];
  onRename: (name: string) => Promise<void>;
  onSetCategory: (name: string | undefined) => Promise<void>;
  onDelete?: () => void;
  /** Move one slot up/down the sidebar; absent at the ends of the list. */
  onMove?: (direction: -1 | 1) => Promise<void>;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  /** The Roles scoped to this channel — who may read it (CORD-03/04 §2). */
  accessRoles?: Array<{ id: string; name: string }>;
  /** Convert a public channel to private (CORD-03 §2). */
  onPrivatise?: () => Promise<void>;
  /** Re-key to exactly the currently-entitled members (drift/leak repair). */
  onRotateKey?: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(channel.name);
  const [accessOpen, setAccessOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [naming, setNaming] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState("");

  const file = async (name: string | undefined) => {
    try {
      await onSetCategory(name);
      toast({ title: name ? `Moved to ${name}` : "Removed from category" });
    } catch (e) {
      toast({
        title: "Couldn't move channel",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    setValue(channel.name);
  }, [channel.name]);

  const run = async (fn: () => Promise<void>, failTitle: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast({ title: failTitle, description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== channel.name) {
      try {
        await onRename(trimmed);
        toast({ title: "Channel renamed" });
      } catch (e) {
        toast({
          title: "Rename failed",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        });
        setValue(channel.name);
      }
    }
    setEditing(false);
  };

  const Icon = channel.isPrivate ? Lock : Hash;
  // Offered on every channel a manager can edit: a private one shows who may
  // read it, a public one offers the conversion that gives it a key.
  const showAccessButton = canManage && Boolean(onPrivatise || (channel.isPrivate && onRotateKey));
  const row = (
    <div className="px-1">
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      {editing ? (
        <form
          className="flex flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            commit();
          }}
        >
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
            className="h-7 text-sm"
            onBlur={commit}
          />
          <Button
            type="submit"
            size="icon"
            variant="ghost"
            className="size-7 shrink-0"
            disabled={disabled}
            aria-label="Save name"
          >
            <Check className="size-3.5" />
          </Button>
        </form>
      ) : (
        <>
          <span className="flex-1 min-w-0 truncate text-sm">
            {channel.name}
            {channel.category && (
              <span className="ml-1.5 text-xs text-muted-foreground">{channel.category}</span>
            )}
          </span>
          {onMove && (
            <>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 text-muted-foreground disabled:opacity-30"
                aria-label={`Move ${channel.name} up`}
                disabled={!canMoveUp || disabled}
                onClick={() => void onMove(-1)}
              >
                <ArrowUp className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 text-muted-foreground disabled:opacity-30"
                aria-label={`Move ${channel.name} down`}
                disabled={!canMoveDown || disabled}
                onClick={() => void onMove(1)}
              >
                <ArrowDown className="size-3.5" />
              </Button>
            </>
          )}
          {showAccessButton && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={cn("size-7 shrink-0 text-muted-foreground", accessOpen && "text-foreground")}
              aria-label="Channel access"
              aria-expanded={accessOpen}
              onClick={() => setAccessOpen((v) => !v)}
            >
              <Shield className="size-3.5" />
            </Button>
          )}
          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 text-muted-foreground"
                  aria-label={`Category for ${channel.name}`}
                  disabled={disabled}
                >
                  <Folder className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Category</DropdownMenuLabel>
                {categories.map((name) => (
                  <DropdownMenuItem
                    key={name}
                    onSelect={() => void file(name)}
                    disabled={categoryKey(name) === categoryKey(channel.category ?? "")}
                  >
                    <Folder className="size-3.5" />
                    <span className="truncate">{name}</span>
                  </DropdownMenuItem>
                ))}
                {categories.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setNaming(true); }}>
                  <Plus className="size-3.5" />
                  New category…
                </DropdownMenuItem>
                {channel.category && (
                  <DropdownMenuItem onSelect={() => void file(undefined)}>
                    <X className="size-3.5" />
                    Remove from category
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {canManage && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground"
              aria-label="Rename channel"
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-3.5" />
            </Button>
          )}
          {onDelete && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              aria-label="Delete channel"
              onClick={onDelete}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </>
      )}
    </div>

    {accessOpen && (
      <div className="mb-1 ml-5 mt-1 space-y-1.5 rounded-lg bg-secondary/40 p-2.5">
        {channel.isPrivate ? (
          <>
            {/* CORD-03: a Private Channel is "readable only by granted
                role-holders", and CORD-04 §2's channel-scoped Role is what
                names them. Access is edited by granting those Roles, in the
                member list or the Roles dialog — not here. */}
            <p className="text-xs text-muted-foreground">
              Readable by holders of {accessRoles?.length ? "these roles" : "no role yet"}:
            </p>
            {accessRoles?.length ? (
              <ul className="space-y-0.5">
                {accessRoles.map((role) => (
                  <li key={role.id} className="flex items-center gap-1.5 text-sm">
                    <Shield className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{role.name}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">
                No role is scoped to this channel, so only the owner and existing key holders can
                read it. Create one in Roles, scoped to #{channel.name}.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Grant one of these roles to give a member access; revoking it rotates the key away.
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Readable by every member — a public channel's key comes from the community root.
          </p>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          {!channel.isPrivate && onPrivatise && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mr-auto text-muted-foreground"
              disabled={busy}
              onClick={() => run(async () => { await onPrivatise(); setAccessOpen(false); }, "Couldn't make the channel private")}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Make private"}
            </Button>
          )}
          {channel.isPrivate && onRotateKey && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mr-auto text-muted-foreground"
              disabled={busy}
              title="Mint a fresh key for exactly the members entitled today. Anyone else loses access from here on."
              onClick={() => {
                if (!confirm(
                  `Rotate #${channel.name}'s key?\n\n` +
                  "It gets a fresh key delivered only to members who hold one of its roles right now. " +
                  "Anyone else — including someone who kept a key from an earlier setting — loses access to what's said next.",
                )) return;
                void run(async () => {
                  await onRotateKey();
                  toast({ title: "Channel key rotated" });
                }, "Couldn't rotate the key");
              }}
            >
              Rotate key
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setAccessOpen(false)}>
            Close
          </Button>
        </div>
      </div>
    )}
    </div>
  );

  if (!naming) return row;
  return (
    <div className="space-y-1">
      {row}
      <form
        className="flex items-center gap-1 px-1"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = categoryDraft.trim();
          setNaming(false);
          setCategoryDraft("");
          if (trimmed) void file(trimmed);
        }}
      >
        <Folder className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          value={categoryDraft}
          onChange={(e) => setCategoryDraft(e.target.value)}
          placeholder="Category name"
          autoFocus
          className="h-7 text-sm"
          onBlur={() => { setNaming(false); setCategoryDraft(""); }}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setNaming(false); setCategoryDraft(""); }
          }}
        />
      </form>
    </div>
  );
}

/** Canonical relay URL: default to wss://, require a websocket scheme, and
 *  drop a bare origin's trailing slash so equality checks are byte-stable. */
function normalizeRelayUrl(input: string): string | null {
  let raw = input.trim();
  if (!raw) return null;
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `wss://${raw}`;
  try {
    const u = new URL(raw);
    if (u.protocol !== "wss:" && u.protocol !== "ws:") return null;
    const s = u.toString();
    return u.pathname === "/" && s.endsWith("/") ? s.slice(0, -1) : s;
  } catch {
    return null;
  }
}

/**
 * Disappearing messages (CORD-08): the community-wide timer, shown to every
 * member and editable under MANAGE_METADATA. Saving publishes a metadata
 * edition (version-chained, like any staff edit) and then posts a kind-1740
 * notice into every channel the actor holds keys for, so the change is a line
 * in chat history. The timer applies at SEND time only — existing messages
 * keep the expiry they were sent under.
 */
function DisappearingSection({
  community,
  metadata,
  canManage,
}: {
  community: Community;
  metadata: CommunityMetadata | undefined;
  canManage: boolean;
}) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { updateMetadata } = useMetadataActions(community);
  const channels = useChannels(community);
  const [saving, setSaving] = useState(false);

  const current = messageExpirationOf(metadata);

  const handleChange = async (seconds: number) => {
    if (seconds === current || !user) return;
    setSaving(true);
    try {
      await updateMetadata({ message_expiration: seconds });
      // The courtesy line in chat history (CORD-08 §4). Best-effort: the
      // metadata fold is the authority, so a failed notice loses only the line.
      await publishTimerNotices(nostr, community, channels, user.signer, user.pubkey, seconds).catch(
        () => undefined,
      );
      toast({
        title:
          seconds > 0
            ? `Disappearing messages: ${formatCommunityTimer(seconds)}`
            : "Disappearing messages turned off",
      });
    } catch (e) {
      toast({
        title: "Couldn't update disappearing messages",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Disappearing messages
      </span>
      <div className="flex items-center gap-2.5 text-sm">
        <Timer className="size-4 shrink-0 text-muted-foreground" />
        {canManage ? (
          <>
            <Select
              value={String(current)}
              disabled={saving}
              onValueChange={(v) => void handleChange(Number(v))}
            >
              <SelectTrigger className="h-8 w-36" aria-label="Disappearing messages timer">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMUNITY_TIMER_PRESETS.map((p) => (
                  <SelectItem key={p.seconds} value={String(p.seconds)}>
                    {p.label}
                  </SelectItem>
                ))}
                {/* A value another client set that isn't a preset here. */}
                {current > 0 && !COMMUNITY_TIMER_PRESETS.some((p) => p.seconds === current) && (
                  <SelectItem value={String(current)}>{formatCommunityTimer(current)}</SelectItem>
                )}
              </SelectContent>
            </Select>
            {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </>
        ) : (
          <span>{current > 0 ? `New messages disappear after ${formatCommunityTimer(current)}` : "Off"}</span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {current > 0
          ? "Messages in every channel are deleted for everyone after this long. Changes apply to new messages only."
          : "Messages are kept forever. When set, messages in every channel delete for everyone after the chosen time."}
      </p>
    </div>
  );
}

/**
 * The community's relay set. Read-only for everyone; editable for viewers with
 * MANAGE_METADATA. The list lives in the Metadata entity so it can evolve
 * (CORD-02 §6): saving publishes an edition to old ∪ new relays, and adding
 * relays first MIRRORS the community's control/guestbook/rekey history onto
 * them so a fresh joiner reading only the new set folds a complete community.
 * Hard-capped at 5: every member's fold truncates past that (capRelays), so a
 * sixth entry would be silently dropped network-wide.
 */
function RelaysSection({
  community,
  metadata,
  relays,
  canManage,
}: {
  community: Community;
  metadata: CommunityMetadata | undefined;
  relays: string[];
  canManage: boolean;
}) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { updateMetadata } = useMetadataActions(community);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [addValue, setAddValue] = useState("");
  const [busy, setBusy] = useState<MirrorProgress | { phase: "edition" } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (relays.length === 0 && !canManage) return null;

  const startEditing = () => {
    setDraft(relays);
    setAddValue("");
    setError(null);
    setEditing(true);
  };

  const addRelay = () => {
    setError(null);
    const url = normalizeRelayUrl(addValue);
    if (!url) {
      setError("Enter a relay websocket URL, like wss://relay.example.com");
      return;
    }
    if (draft.includes(url)) {
      setAddValue("");
      return;
    }
    if (draft.length >= MAX_COMMUNITY_RELAYS) return;
    setDraft([...draft, url]);
    setAddValue("");
  };

  const handleSave = async () => {
    setError(null);
    if (draft.length === 0) {
      setError("A community needs at least one relay.");
      return;
    }
    if (draft.length === relays.length && draft.every((r, i) => r === relays[i])) {
      setEditing(false);
      return;
    }
    // Diff against the OPERATIVE set: those relays hold the history to copy.
    const added = draft.filter((r) => !community.relays.includes(r));
    if (!draft.some((r) => relays.includes(r))) {
      const ok = confirm(
        "This replaces every current relay at once. Members offline during the switch may lose track of the community, and previously shared invite links will keep pointing at the old relays. Keeping at least one current relay through a transition is safer. Continue?",
      );
      if (!ok) return;
    }
    try {
      let rejectedNote: string | undefined;
      if (added.length > 0) {
        setBusy({ phase: "fetch", relay: "", done: 0, total: 0 });
        const report = await mirrorHistoryToRelays(nostr, community, added, {
          onProgress: (p) => setBusy(p),
        });
        const rejected = [...report.perRelay.entries()].filter(([, r]) => r.rejected > 0);
        if (rejected.length > 0) {
          rejectedNote = rejected
            .map(([url, r]) => `${url.replace(/^wss?:\/\//, "")} refused ${r.rejected} of ${report.found} events`)
            .join("; ");
        }
      }
      setBusy({ phase: "edition" });
      await updateMetadata({ relays: draft });
      // My own live invite links should vend the new set right away; other
      // creators' links heal via useLinkRefreshWatch when they next fold.
      // Fan the refreshed bundle out to old ∪ new: existing links' fragment
      // hints point at the OLD relays, so the stale copy there must be
      // overwritten too.
      if (user?.signer.nip44) {
        const bundleFanout = [...new Set([...community.relays, ...draft])];
        refreshInviteBundlesFor(nostr, user, { ...community, relays: draft }, metadata, bundleFanout).catch(
          () => undefined,
        );
      }
      toast({
        title: "Relays updated",
        ...(rejectedNote ? { description: rejectedNote, variant: "destructive" as const } : {}),
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't update relays.");
    } finally {
      setBusy(null);
    }
  };

  const busyLabel =
    busy === null
      ? null
      : busy.phase === "edition"
        ? "Publishing the new relay list…"
        : busy.phase === "fetch"
          ? `Gathering community history… ${busy.done} events`
          : `Copying history to ${busy.relay.replace(/^wss?:\/\//, "")}… ${busy.done}/${busy.total}`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Relays
        </span>
        {canManage && !editing && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label="Edit relays"
            onClick={startEditing}
          >
            <Pencil className="size-3" />
          </Button>
        )}
      </div>

      {!editing ? (
        <ul className="space-y-1">
          {relays.map((r) => (
            <li key={r} className="truncate rounded-md bg-secondary/40 px-2 py-1 text-xs font-mono">
              {r}
            </li>
          ))}
        </ul>
      ) : (
        <div className="space-y-1.5">
          <ul className="space-y-1">
            {draft.map((r) => (
              <li
                key={r}
                className="flex items-center gap-1 rounded-md bg-secondary/40 py-0.5 pl-2 pr-0.5 text-xs font-mono"
              >
                <span className="min-w-0 flex-1 truncate">{r}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${r}`}
                  disabled={busy !== null || draft.length === 1}
                  onClick={() => setDraft(draft.filter((x) => x !== r))}
                >
                  <Trash2 className="size-3" />
                </Button>
              </li>
            ))}
          </ul>

          {draft.length < MAX_COMMUNITY_RELAYS ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                addRelay();
              }}
            >
              <Input
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                placeholder="wss://relay.example.com"
                disabled={busy !== null}
                className="h-7 flex-1 font-mono text-xs"
              />
              <Button
                type="submit"
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                disabled={busy !== null || !addValue.trim()}
                aria-label="Add relay"
              >
                <Plus className="size-3.5" />
              </Button>
            </form>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Up to {MAX_COMMUNITY_RELAYS} relays; past that, clients trim the list.
            </p>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {busyLabel && (
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> {busyLabel}
            </p>
          )}

          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              aria-label="Save relays"
              disabled={busy !== null || draft.length === 0}
              onClick={handleSave}
            >
              {busy !== null ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground"
              aria-label="Cancel"
              disabled={busy !== null}
              onClick={() => setEditing(false)}
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
