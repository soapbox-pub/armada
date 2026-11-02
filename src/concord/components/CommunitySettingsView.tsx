import {
  ArrowLeft,
  Check,
  Folder,
  GitBranch,
  Globe,
  GripVertical,
  Hash,
  History,
  ImagePlus,
  Info,
  Loader2,
  Lock,
  Megaphone,
  MessageSquareText,
  MoreVertical,
  Pencil,
  Plug,
  Plus,
  Radio,
  Shield,
  Timer,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DiscordBridgeSection } from "@/components/ImportFromDiscord";
import { ChromeDialogContent, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { OwnerAvatar, OwnerSlashRepo, RepositoryPicker, type PickedRepository } from "@/components/projects/RepositoryPicker";
import { Input } from "@/components/ui/input";
import { PillTabs, type PillTab } from "@/components/ui/pill-tabs";
import { RelayListEditor } from "@/components/RelayListEditor";
import { Textarea } from "@/components/ui/textarea";
import { useNostr } from "@nostrify/react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ImageCropDialog } from "@/components/ImageCropDialog";
import { ImageLightbox } from "@/concord/components/ImageLightbox";
import {
  COMMUNITY_TIMER_PRESETS,
  formatCommunityTimer,
  messageExpirationOf,
  publishTimerNotices,
} from "@/concord/lib/disappearing";
import { categoryKey, categoryNames, groupChannelsByCategory } from "@/concord/lib/channelCategory";
import {
  applyArrangement,
  arrangementChanges,
  arrangementSettled,
  pendingFromPlan,
  planChannelDrop,
  type PendingArrangement,
} from "@/concord/lib/channelArrangement";
import { ChannelCategoryHeading } from "@/concord/components/ChannelCategoryHeading";
import { CategoryNameDialog } from "@/concord/components/CategoryNameDialog";
import { useChannelDrag, type ChannelDrop, type ChannelDropSlot } from "@/concord/hooks/useChannelDrag";
import { useCommunityManagement } from "@/concord/hooks/useCommunityActions";
import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { useCommunityDiscoverListings } from "@/concord/hooks/useDiscoverListings";
import { refreshInviteBundlesFor } from "@/concord/hooks/useRekey";
import { useMetadataActions } from "@/concord/hooks/useRoles";
import { DisplayName } from "@/components/DisplayName";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { useUploadFile } from "@/hooks/useUploadFile";
import { COMMUNITY_BANNER_EDGE, COMMUNITY_ICON_EDGE, encryptImageBlob } from "@/concord/lib/image";
import { mirrorHistoryToRelays, type MirrorProgress } from "@/concord/lib/relayMirror";
import { canonicalOrigin, communityAvBrokers, probeAvBroker } from "@/concord/lib/voice";
import {
  MAX_COMMUNITY_AV_BROKERS,
  MAX_COMMUNITY_RELAYS,
  type Channel,
  type CommunityMetadata,
  type Community,
  type ImagePointer,
} from "@/concord/lib/types";
import { cn } from "@/lib/utils";
import { common, defineMessages, FormattedMessage, t, useIntl } from "@/i18n";
import { ChannelGlyph } from "@/concord/components/ChannelGlyph";
import { channelGitRepositoryAttachments } from "@/concord/lib/types";
import type { ChannelView } from "@/concord/lib/types";
import { fetchGitRepositoryAnnouncement } from "@/lib/gitRepositoryResolver";
import { parseGitRepositoryAddress } from "@/lib/gitActivity";
import { AvatarInitial } from "@/components/AvatarInitial";

type SettingsTab = "overview" | "channels" | "integrations" | "relays";

const tabLabels = defineMessages({
  overview: { id: "communitySettingsView.tab.overview", defaultMessage: "Overview" },
  channels: { id: "communitySettingsView.tab.channels", defaultMessage: "Channels" },
  integrations: { id: "communitySettingsView.tab.integrations", defaultMessage: "Integrations" },
  relays: { id: "communitySettingsView.tab.network", defaultMessage: "Network" },
});

/**
 * Community settings page (Overview, Channels, Integrations, Network), shown
 * to everyone with inline editing per permission. Every fold re-checks
 * permissions (CORD-02/04), so UI gating is a convenience, not enforcement.
 */
export function CommunitySettingsView({
  community,
  metadata,
  ownerHex,
  memberCount,
  canManageMetadata,
  canManageChannels,
  channelRoles,
  onPrivatiseChannel,
  onRotateChannelKey,
  onMintAccessRole,
  onOpenInvites,
}: {
  community: Community;
  metadata: CommunityMetadata | undefined;
  ownerHex: string | undefined;
  memberCount: number;
  canManageMetadata: boolean;
  canManageChannels: boolean;
  /** Per channel id, the Roles scoped to it — its access list (CORD-04 §2). */
  channelRoles?: ReadonlyMap<string, Array<{ id: string; name: string }>>;
  /** Convert a public channel to private (CORD-03 §2), naming its access role. */
  onPrivatiseChannel?: (channelIdHex: string, accessRoleName?: string) => Promise<void>;
  onRotateChannelKey?: (channelIdHex: string) => Promise<void>;
  onMintAccessRole?: (channelIdHex: string, name: string) => Promise<void>;
  onOpenInvites?: () => void;
}) {
  const intl = useIntl();
  const { updateMetadata, isUpdating } = useMetadataActions(community);
  const { mutateAsync: uploadFile } = useUploadFile();
  const settingsTabs = useMemo<readonly PillTab<SettingsTab>[]>(() => [
    { id: "overview", label: intl.formatMessage(tabLabels.overview), icon: Info },
    { id: "channels", label: intl.formatMessage(tabLabels.channels), icon: Hash },
    { id: "integrations", label: intl.formatMessage(tabLabels.integrations), icon: Plug },
    { id: "relays", label: intl.formatMessage(tabLabels.relays), icon: Radio },
  ], [intl]);

  const name = metadata?.name || community.name;
  const description = metadata?.description?.trim();
  const relays = metadata?.relays ?? community.relays;
  // No `community` fallback: brokers aren't bootstrap material, so they live only in the fold (CORD-02 §6).
  const avBrokers = useMemo(() => communityAvBrokers(metadata), [metadata]);

  const bannerUrl = useDecryptedImage(metadata?.banner);
  const iconUrl = useDecryptedImage(metadata?.icon);
  const [iconZoom, setIconZoom] = useState(false);
  const [bannerZoom, setBannerZoom] = useState(false);
  const [uploading, setUploading] = useState<"icon" | "banner" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [editingField, setEditingField] = useState<"name" | "description" | null>(null);

  // Same crop path as CreateCommunityWizard: pick → ImageCropDialog → encrypt.
  const pickInputRef = useRef<HTMLInputElement>(null);
  const pendingField = useRef<"icon" | "banner">("icon");
  const [cropState, setCropState] = useState<{
    imageSrc: string;
    aspect: number;
    field: "icon" | "banner";
    title: string;
  } | null>(null);

  const handlePickImage = (field: "icon" | "banner") => {
    pendingField.current = field;
    pickInputRef.current?.click();
  };

  const handleFileChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const field = pendingField.current;
    setCropState({
      imageSrc: URL.createObjectURL(file),
      aspect: field === "icon" ? 1 : 3,
      field,
      title: field === "icon"
        ? t({ id: "communitySettingsView.cropIcon", defaultMessage: "Crop icon" })
        : t({ id: "communitySettingsView.cropBanner", defaultMessage: "Crop banner" }),
    });
  };

  const handleCropCancel = () => {
    if (cropState) URL.revokeObjectURL(cropState.imageSrc);
    setCropState(null);
  };

  const handleCropConfirm = async (blob: Blob) => {
    if (!cropState) return;
    const { field, imageSrc } = cropState;
    URL.revokeObjectURL(imageSrc);
    setCropState(null);
    setError(null);
    setUploading(field);
    try {
      const { ciphertext, key, nonce, hash } = await encryptImageBlob(blob);
      const tags = await uploadFile(
        new File([ciphertext], `${field}.enc`, { type: "application/octet-stream" }),
      );
      const url = tags[0]?.[1];
      if (!url) throw new Error(t({ id: "communitySettingsView.noUploadUrl", defaultMessage: "Upload returned no URL." }));
      const image: ImagePointer = { url, key, nonce, hash };
      await updateMetadata(field === "icon" ? { icon: image } : { banner: image });
      toast({
        title: field === "icon"
          ? t({ id: "communitySettingsView.iconUpdated", defaultMessage: "Icon updated" })
          : t({ id: "communitySettingsView.bannerUpdated", defaultMessage: "Banner updated" }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "communitySettingsView.uploadFailed", defaultMessage: "Upload failed." }));
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
      setError(e instanceof Error ? e.message : t({ id: "communitySettingsView.saveFailed", defaultMessage: "Couldn't save changes." }));
    }
  };

  const [tab, setTab] = useState<SettingsTab>("overview");

  return (
    <div className="mx-auto w-full max-w-2xl px-3 py-4">
      <div className="mb-4 flex">
        <PillTabs tabs={settingsTabs} value={tab} onChange={(id) => setTab(id)} />
      </div>

      {tab === "overview" && (
        <div className="space-y-5">
          {(bannerUrl || canManageMetadata) && (
            <div className="relative">
              {bannerUrl ? (
                <button
                  type="button"
                  className="block h-32 w-full overflow-hidden rounded-lg cursor-zoom-in"
                  aria-label={intl.formatMessage({ id: "communitySettingsView.viewBanner", defaultMessage: "View banner" })}
                  onClick={() => setBannerZoom(true)}
                >
                  <img src={bannerUrl} alt="" className="size-full object-cover" />
                </button>
              ) : (
                <button
                  type="button"
                  className="flex h-32 w-full items-center justify-center clip-corner-lg bg-secondary/40 text-muted-foreground transition-colors hover:bg-secondary/60"
                  onClick={() => handlePickImage("banner")}
                  aria-label={intl.formatMessage({ id: "communitySettingsView.addBanner", defaultMessage: "Add banner" })}
                >
                  <ImagePlus className="size-5" />
                </button>
              )}
              {canManageMetadata && (
                <button
                  type="button"
                  className="absolute bottom-2 right-2 grid size-8 touch:size-11 place-items-center clip-corner-lg bg-background/70 text-foreground backdrop-blur transition-colors hover:bg-background/90"
                  onClick={() => handlePickImage("banner")}
                  disabled={uploading === "banner"}
                  aria-label={intl.formatMessage({ id: "communitySettingsView.changeBanner", defaultMessage: "Change banner" })}
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

          <div className="space-y-5">
            <div className="flex flex-col items-center text-center gap-3">
              <div className="relative">
                {iconUrl ? (
                  <button
                    type="button"
                    className="cursor-zoom-in rounded-2xl"
                    aria-label={intl.formatMessage({ id: "communitySettingsView.viewIcon", defaultMessage: "View icon" })}
                    onClick={() => setIconZoom(true)}
                  >
                    <img src={iconUrl} alt="" className="size-16 rounded-2xl object-cover" />
                  </button>
                ) : canManageMetadata ? (
                  <button
                    type="button"
                    className="grid size-16 place-items-center clip-corner-lg bg-secondary/50 text-muted-foreground transition-colors hover:bg-secondary/70"
                    onClick={() => handlePickImage("icon")}
                    aria-label={intl.formatMessage({ id: "communitySettingsView.addIcon", defaultMessage: "Add icon" })}
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
                    className="absolute -bottom-1 -right-1 grid size-6 touch:size-11 place-items-center clip-corner-lg bg-background text-foreground transition-colors hover:bg-secondary"
                    onClick={() => handlePickImage("icon")}
                    disabled={uploading === "icon"}
                    aria-label={intl.formatMessage({ id: "communitySettingsView.changeIcon", defaultMessage: "Change icon" })}
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
                      className="size-6 touch:size-11 shrink-0 text-muted-foreground"
                      aria-label={intl.formatMessage({ id: "communitySettingsView.editName", defaultMessage: "Edit name" })}
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

            {editingField === "description" ? (
              <InlineEdit
                initial={description ?? ""}
                saving={isUpdating}
                multiline
                placeholder={intl.formatMessage({ id: "communitySettingsView.descriptionPlaceholder", defaultMessage: "What's this community about?" })}
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
                    className="size-6 touch:size-11 shrink-0 text-muted-foreground"
                    aria-label={intl.formatMessage({ id: "communitySettingsView.editDescription", defaultMessage: "Edit description" })}
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
                  <Plus className="size-3.5" /> <FormattedMessage id="communitySettingsView.addDescription" defaultMessage="Add a description" />
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
                  <FormattedMessage
                    id="communitySettingsView.memberCount"
                    defaultMessage="{count, plural, one {# member} other {# members}}"
                    values={{ count: memberCount }}
                  />
                </span>
              </div>
              <VisibilityRow community={community} onOpenInvites={onOpenInvites} />
            </div>

            <DisappearingSection community={community} metadata={metadata} canManage={canManageMetadata} />
          </div>

          <input
            ref={pickInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChosen}
          />
          {cropState && (
            <ImageCropDialog
              open
              imageSrc={cropState.imageSrc}
              aspect={cropState.aspect}
              title={cropState.title}
              maxEdge={cropState.field === "icon" ? COMMUNITY_ICON_EDGE : COMMUNITY_BANNER_EDGE}
              onCancel={handleCropCancel}
              onCrop={handleCropConfirm}
            />
          )}
        </div>
      )}

      {tab === "channels" && (
        <ChannelsSection community={community} canManage={canManageChannels} channelRoles={channelRoles} onPrivatiseChannel={onPrivatiseChannel} onRotateChannelKey={onRotateChannelKey} onMintAccessRole={onMintAccessRole} />
      )}

      {tab === "integrations" && (
        <div className="space-y-5">
          <ConnectedRepositoriesSection community={community} canManage={canManageChannels} />

          <DiscordBridgeSection canManage={canManageChannels} />
        </div>
      )}

      {tab === "relays" && (
        <div className="space-y-5">
          <RelaysSection
            community={community}
            metadata={metadata}
            relays={relays}
            canManage={canManageMetadata}
          />

          <VoiceServersSection
            community={community}
            brokers={avBrokers}
            canManage={canManageMetadata}
          />

          <HistorySection community={community} />
        </div>
      )}
    </div>
  );
}

/** Opens `HistoryAuditView`; reads only what this member can already decrypt. */
function HistorySection({ community }: { community: Community }) {
  const navigate = useNavigate();
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <FormattedMessage id="communitySettingsView.history.title" defaultMessage="History" />
      </span>
      <div className="space-y-2.5 rounded-lg bg-secondary/40 p-3">
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="communitySettingsView.history.description"
            defaultMessage="Read every channel across all relays, save it to your local store, and export a self-contained HTML copy that opens as a mini-Armada."
          />
        </p>
        <Button
          type="button"
          size="sm"
          className="clip-corner-lg"
          onClick={() => navigate(`/c/${encodeURIComponent(community.idHex)}/history`)}
        >
          <History className="size-4 shrink-0" />
          <FormattedMessage id="communitySettingsView.history.button" defaultMessage="Verify & export history" />
        </Button>
      </div>
    </div>
  );
}

/** Active NIP-34 attachments; detached historical intervals aren't listed. */
export function ConnectedRepositoriesSection({
  community,
  canManage,
}: {
  community: Community;
  canManage: boolean;
}) {
  const intl = useIntl();
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

  if (repositories.length === 0 && !canManage) return null;

  const connectedCoordinates = new Set(repositories.map(({ attachment }) => attachment.address.coordinate));
  // One repository per channel, or two projects blend into one timeline.
  const repositoryByChannel = new Map<string, { owner: string; name: string }>();
  for (const { channel, attachment } of repositories) {
    if (!repositoryByChannel.has(channel.idHex)) {
      repositoryByChannel.set(channel.idHex, { owner: attachment.address.owner, name: attachment.address.identifier });
    }
  }

  const connect = async (channelIdHex: string, repository: PickedRepository) => {
    // The announcement is authoritative for relays; pasted hints only add discovery.
    await attachRepository({ channelIdHex, address: repository.coordinate, relayHints: repository.relayHints });
    toast({ title: t({ id: "communitySettingsView.repo.connected", defaultMessage: "Repository connected" }), description: repository.displayName });
  };

  const detach = async (channel: Channel, address: string, name: string) => {
    if (!confirm(t(
      {
        id: "communitySettingsView.repo.confirmDisconnect",
        defaultMessage: "Disconnect {name} from #{channel}? Historical activity remains attached to its original interval.",
      },
      { name, channel: channel.name },
    ))) return;
    try {
      await detachRepository({ channelIdHex: channel.idHex, address });
      toast({ title: t({ id: "communitySettingsView.repo.disconnected", defaultMessage: "Repository disconnected" }), description: name });
    } catch (e) {
      toast({
        title: t({ id: "communitySettingsView.repo.disconnectFailed", defaultMessage: "Couldn't disconnect repository" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <FormattedMessage id="communitySettingsView.repo.title" defaultMessage="Connected repositories" />
        </span>
        {canManage && channels.length > 0 && (
          <Button type="button" size="icon" variant="ghost" className="size-6 touch:size-11 shrink-0 text-muted-foreground" aria-label={intl.formatMessage({ id: "communitySettingsView.repo.connect", defaultMessage: "Connect repository" })} onClick={() => setConnectOpen(true)}>
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>
      <div className="space-y-1 rounded-lg bg-secondary/40 p-1">
        {repositories.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">
            <FormattedMessage id="communitySettingsView.repo.none" defaultMessage="No repositories connected." />
          </p>}
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

function ConnectRepositoryDialog({ open, onOpenChange, channels, connectedCoordinates, repositoryByChannel, onConnect }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: Channel[];
  connectedCoordinates: ReadonlySet<string>;
  repositoryByChannel: ReadonlyMap<string, { owner: string; name: string }>;
  onConnect: (channelIdHex: string, repository: PickedRepository) => Promise<unknown>;
}) {
  const intl = useIntl();
  const [picked, setPicked] = useState<PickedRepository | null>(null);
  // The fold absorbs our attachment before the publish resolves; keep the row pending.
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
      setError(e instanceof Error ? e.message : t({ id: "communitySettingsView.repo.connectFailed", defaultMessage: "Couldn't connect repository." }));
    } finally {
      setPendingChannelId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !connecting && onOpenChange(next)}>
      <ChromeDialogContent title={picked
        ? intl.formatMessage({ id: "communitySettingsView.repo.chooseChannelTitle", defaultMessage: "Choose a channel" })
        : intl.formatMessage({ id: "communitySettingsView.repo.connectTitle", defaultMessage: "Connect a repository" })} contentClassName="grid gap-4">
        {picked && (
          <Button variant="ghost" size="icon" className="absolute left-3 top-3 size-8 touch:size-11" aria-label={intl.formatMessage(common.back)} disabled={connecting} onClick={() => setPicked(null)}>
            <ArrowLeft className="size-4" />
          </Button>
        )}
        <ChromeDialogHeader icon={GitBranch} title={picked
          ? <FormattedMessage id="communitySettingsView.repo.chooseChannelHeading" defaultMessage="choose a channel" />
          : <FormattedMessage id="communitySettingsView.repo.connectHeading" defaultMessage="connect a repository" />} className="mb-2" />

        {!picked ? (
          <RepositoryPicker connectedCoordinates={connectedCoordinates} onSelect={setPicked} />
        ) : (
          <div className="min-w-0 space-y-3">
            <div className="flex min-w-0 items-center gap-2.5 clip-corner-lg bg-background/40 p-2.5">
              <OwnerAvatar pubkey={picked.owner} />
              <span className="min-w-0 flex-1">
                <OwnerSlashRepo owner={picked.owner} name={picked.displayName} />
                <span className="block truncate text-xs text-muted-foreground">
                  <FormattedMessage id="communitySettingsView.repo.pickChannel" defaultMessage="Pick the channel its activity should appear in." />
                </span>
              </span>
            </div>
            <div className="max-h-56 space-y-0.5 overflow-y-auto clip-corner-lg bg-background/40 p-1">
              {channels.map((channel) => {
                const pending = pendingChannelId === channel.idHex;
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
                    <ChannelGlyph isPrivate={channel.isPrivate} view={channel.view} className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{channel.name}</span>
                      {pending
                        ? <span className="block truncate text-xs text-muted-foreground">
                          <FormattedMessage id="communitySettingsView.repo.connecting" defaultMessage="Connecting…" />
                        </span>
                        : taken && <span className="block truncate text-xs text-muted-foreground">
                          <FormattedMessage
                            id="communitySettingsView.repo.alreadyConnected"
                            defaultMessage="Already connected to {name}"
                            values={{ name: taken.name }}
                          />
                        </span>}
                    </span>
                    {pending && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
                  </button>
                );
              })}
            </div>
            {/* Not while connecting: our in-flight attachment would make every channel look taken. */}
            {!connecting && channels.every((channel) => repositoryByChannel.has(channel.idHex)) && (
              <p className="text-xs text-muted-foreground">
                <FormattedMessage
                  id="communitySettingsView.repo.allTaken"
                  defaultMessage="Every channel already has a repository. Add a channel first, or create a repository channel from the channel list."
                />
              </p>
            )}
            {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          </div>
        )}
      </ChromeDialogContent>
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
  const intl = useIntl();
  const name = data?.announcement.name || fallbackName;
  return <div className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5">
    <OwnerAvatar pubkey={owner} className="size-6" />
    <span className="min-w-0 flex-1"><OwnerSlashRepo owner={owner} name={name} /></span>
    <span className="shrink-0 text-2xs text-muted-foreground">#{channel.name}</span>
    {canManage && <Button type="button" size="icon" variant="ghost" className="size-6 touch:size-11 shrink-0 text-muted-foreground hover:text-destructive" aria-label={intl.formatMessage({ id: "communitySettingsView.repo.disconnect", defaultMessage: "Disconnect {name}" }, { name })} title={address} onClick={onDetach}><Trash2 className="size-3.5" /></Button>}
  </div>;
}

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
  const intl = useIntl();
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
        className="size-8 touch:size-11 shrink-0"
        disabled={saving || (!multiline && !value.trim())}
        aria-label={intl.formatMessage(common.save)}
      >
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8 touch:size-11 shrink-0 text-muted-foreground"
        onClick={onCancel}
        disabled={saving}
        aria-label={intl.formatMessage(common.cancel)}
      >
        <X className="size-4" />
      </Button>
    </form>
  );
}

/** Public (a live invite link exists) / private and Discover status, with a link to manage them. */
function VisibilityRow({ community, onOpenInvites }: { community: Community; onOpenInvites?: () => void }) {
  const { data: folded } = useControlFold(community);
  const isPublic = (folded?.liveInviteLinks.size ?? 0) > 0;
  const { listings } = useCommunityDiscoverListings(isPublic ? community : undefined);
  const listed = isPublic && listings.length > 0;
  if (!folded) return null;
  return (
    <div className="flex items-center gap-2.5 text-sm">
      {listed ? (
        <Megaphone className="size-4 shrink-0 text-primary" />
      ) : isPublic ? (
        <Globe className="size-4 shrink-0 text-primary" />
      ) : (
        <Lock className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1">
        {listed
          ? <FormattedMessage id="communitySettingsView.visibility.listed" defaultMessage="Public · listed on Discover" />
          : isPublic
            ? <FormattedMessage id="communitySettingsView.visibility.public" defaultMessage="Public · anyone with an invite link can join" />
            : <FormattedMessage id="communitySettingsView.visibility.private" defaultMessage="Private · join by direct invite only" />}
      </span>
      {onOpenInvites && (
        <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={onOpenInvites}>
          <FormattedMessage id="communitySettingsView.visibility.manage" defaultMessage="Manage" />
        </Button>
      )}
    </div>
  );
}

function OwnerRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const displayName = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    <div className="flex items-center gap-2.5 text-sm">
      <Avatar className="size-6 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
        <AvatarFallback className="bg-primary/20 text-primary text-3xs">
          <AvatarInitial name={displayName} pubkey={pubkey} />
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate">
        <DisplayName pubkey={pubkey} name={displayName} />
      </span>
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-2xs font-medium text-primary">
        <Shield className="size-3" />
        <FormattedMessage id="communitySettingsView.owner" defaultMessage="Owner" />
      </span>
    </div>
  );
}

/**
 * The community's channels; MANAGE_CHANNELS can edit and drag to reorder or
 * categorize with the same `useChannelDrag` and optimistic overlay as the sidebar.
 */
function ChannelsSection({
  community,
  canManage,
  channelRoles,
  onPrivatiseChannel,
  onRotateChannelKey,
  onMintAccessRole,
}: {
  community: Community;
  canManage: boolean;
  channelRoles?: ReadonlyMap<string, Array<{ id: string; name: string }>>;
  onPrivatiseChannel?: (channelIdHex: string, accessRoleName?: string) => Promise<void>;
  onRotateChannelKey?: (channelIdHex: string) => Promise<void>;
  onMintAccessRole?: (channelIdHex: string, name: string) => Promise<void>;
}) {
  const intl = useIntl();
  const channels = useChannels(community);
  const { renameChannel, isRenaming, setChannelCategory, isFiling, setChannelView, deleteChannel, createChannel, isAddingChannel, arrangeChannels } =
    useCommunityManagement(community);

  // Dropped as soon as the fold agrees, so others' later changes aren't masked (channelArrangement.ts).
  const [pendingArrangement, setPendingArrangement] = useState<PendingArrangement | null>(null);
  const arrangedChannels = useMemo(
    () => applyArrangement(channels, pendingArrangement),
    [channels, pendingArrangement],
  );
  useEffect(() => {
    if (pendingArrangement && arrangementSettled(channels, pendingArrangement)) {
      setPendingArrangement(null);
    }
  }, [channels, pendingArrangement]);

  const { uncategorized: uncategorizedChannels, categories: channelCategories } = useMemo(
    () => groupChannelsByCategory(arrangedChannels, (c) => c.category),
    [arrangedChannels],
  );
  // Offer existing names so "Voice" isn't retyped as "voice".
  const categoryPicklist = useMemo(
    () => categoryNames(arrangedChannels, (c) => c.category),
    [arrangedChannels],
  );

  // Drop indexes refer to THIS flattened order.
  const renderedChannels = useMemo(
    () => [...uncategorizedChannels, ...channelCategories.flatMap((group) => group.channels)],
    [uncategorizedChannels, channelCategories],
  );
  const renderedIndexOf = useMemo(
    () => new Map(renderedChannels.map((c, index) => [c.idHex, index])),
    [renderedChannels],
  );

  const [collapsedCategories, setCollapsedCategories] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleCategory = useCallback((key: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const [categoryPrompt, setCategoryPrompt] = useState<
    { channels: readonly Channel[]; initial: string } | null
  >(null);

  const refileCategory = useCallback(
    async (members: readonly Channel[], category: string | undefined) => {
      let moved = 0;
      try {
        for (const member of members) {
          await setChannelCategory({ channelIdHex: member.idHex, category });
          moved += 1;
        }
      } catch (e) {
        toast({
          title: moved > 0
            ? t(
              { id: "communitySettingsView.channels.partialMove", defaultMessage: "Only moved {moved} of {total} channels" },
              { moved, total: members.length },
            )
            : t({ id: "communitySettingsView.channels.moveFailed", defaultMessage: "Couldn't move the channels" }),
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        });
      }
    },
    [setChannelCategory],
  );

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
        title: t({ id: "communitySettingsView.channels.createFailed", defaultMessage: "Couldn't create channel" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  /** The scrolling list the drag pans by hand on touch (rows are touch-none). */
  const channelScrollRef = useRef<HTMLElement | null>(null);

  const measureDropSlots = useCallback((): ChannelDropSlot[] => {
    const root = channelScrollRef.current;
    if (!root) return [];
    const out: ChannelDropSlot[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("[data-ch-slot]")) {
      const index = Number(el.dataset.chIndex);
      if (!Number.isInteger(index)) continue;
      const category = el.dataset.chCategory || undefined;
      const rect = el.getBoundingClientRect();
      out.push({ index, category, y: rect.top });
      out.push({ index: index + 1, category, y: rect.bottom });
    }
    const zone = root.querySelector<HTMLElement>("[data-ch-newzone]");
    if (zone) {
      const rect = zone.getBoundingClientRect();
      out.push({
        index: out.length / 2,
        category: undefined,
        y: rect.top + rect.height / 2,
        newCategory: true,
      });
    }
    return out;
  }, []);

  const commitDrop = useCallback(
    (sourceIdHex: string, drop: ChannelDrop) => {
      const source = renderedChannels.find((c) => c.idHex === sourceIdHex);
      if (!source) return;
      if (drop.newCategory) {
        setCategoryPrompt({ channels: [source], initial: "" });
        return;
      }
      const before = renderedChannels.map((c) => ({
        idHex: c.idHex,
        position: c.position,
        category: c.category,
      }));
      const plan = planChannelDrop(before, sourceIdHex, drop.index, drop.category);
      const changes = arrangementChanges(before, plan);
      if (changes.length === 0) return;
      setPendingArrangement(pendingFromPlan(plan));
      void arrangeChannels(changes).catch((e: unknown) => {
        // Nothing published; drop the optimistic order.
        setPendingArrangement(null);
        toast({
          title: t({ id: "communitySettingsView.channels.rearrangeFailed", defaultMessage: "Couldn't rearrange the channels" }),
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        });
      });
    },
    [renderedChannels, arrangeChannels],
  );

  const channelDrag = useChannelDrag({
    enabled: canManage,
    columnRef: channelScrollRef,
    measure: measureDropSlots,
    onDrop: commitDrop,
  });

  const draggedChannel = channelDrag.sourceIdHex
    ? (renderedChannels.find((c) => c.idHex === channelDrag.sourceIdHex) ?? null)
    : null;

  const renderChannelRow = (ch: Channel) => {
    const index = renderedIndexOf.get(ch.idHex) ?? 0;
    const dragged = channelDrag.sourceIdHex === ch.idHex;
    return (
      <div
        key={ch.idHex}
        data-ch-slot
        data-ch-index={index}
        data-ch-category={ch.category ?? ""}
        onPointerDown={channelDrag.onPointerDown(ch.idHex)}
        // Otherwise Chrome claims a touch drag as a pan and cancels it (usePressDrag.ts).
        className={cn("relative", canManage && "touch-none")}
      >
        {/* Dragged row stays MOUNTED (invisible): unmounting it cancels the touch gesture. */}
        <span className={cn("contents", dragged && "invisible")}>
          <ChannelRow
            channel={ch}
            canManage={canManage}
            disabled={isRenaming || isFiling}
            categories={categoryPicklist}
            onRename={(name) => renameChannel({ channelIdHex: ch.idHex, name })}
            accessRoles={channelRoles?.get(ch.idHex) ?? []}
            onPrivatise={onPrivatiseChannel ? (roleName) => onPrivatiseChannel(ch.idHex, roleName) : undefined}
            onRotateKey={onRotateChannelKey ? () => onRotateChannelKey(ch.idHex) : undefined}
            onMintAccessRole={onMintAccessRole ? (name) => onMintAccessRole(ch.idHex, name) : undefined}
            onSetCategory={(category) => setChannelCategory({ channelIdHex: ch.idHex, category })}
            onSetView={canManage ? (view) => setChannelView({ channelIdHex: ch.idHex, view }) : undefined}
            onNewCategory={() => setCategoryPrompt({ channels: [ch], initial: "" })}
            onDelete={
              canManage && channels.length > 1
                ? async () => {
                    if (!confirm(t(
                      { id: "communitySettingsView.channels.confirmDelete", defaultMessage: "Delete #{name}? Its id is never reused." },
                      { name: ch.name },
                    ))) return;
                    try {
                      await deleteChannel({ channelIdHex: ch.idHex });
                      toast({ title: t({ id: "communitySettingsView.channels.deleted", defaultMessage: "Channel deleted" }) });
                    } catch (e) {
                      toast({
                        title: t({ id: "communitySettingsView.channels.deleteFailed", defaultMessage: "Couldn't delete" }),
                        description: e instanceof Error ? e.message : undefined,
                        variant: "destructive",
                      });
                    }
                  }
                : undefined
            }
          />
        </span>
        {dragged && (
          <span className="pointer-events-none absolute inset-x-0 inset-y-px clip-hairline-lg [--edge:var(--primary)/0.5] [--fill:var(--primary)/0.05] [--fill-hover:var(--primary)/0.05]" />
        )}
      </div>
    );
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <FormattedMessage id="communitySettingsView.channels.title" defaultMessage="Channels" />
        </span>
        {canManage && !creating && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 touch:size-11 shrink-0 text-muted-foreground"
            aria-label={intl.formatMessage({ id: "communitySettingsView.channels.add", defaultMessage: "Add channel" })}
            onClick={() => setCreating(true)}
          >
            <Plus className="size-3.5" />
          </Button>
        )}
      </div>
      <div
        ref={channelDrag.attachColumn}
        className="max-h-[60vh] space-y-1 overflow-y-auto rounded-lg bg-secondary/40 p-1"
      >
        {uncategorizedChannels.map(renderChannelRow)}
        {channelCategories.map((group) => {
          const collapsed = collapsedCategories.has(group.key);
          return (
            <div key={group.key} className="space-y-0.5">
              <ChannelCategoryHeading
                name={group.name}
                collapsed={collapsed}
                onToggle={() => toggleCategory(group.key)}
                highlight={
                  channelDrag.dragging &&
                  !channelDrag.target?.newCategory &&
                  channelDrag.target?.category === group.name
                }
                onRename={
                  canManage
                    ? () => setCategoryPrompt({ channels: group.channels, initial: group.name })
                    : undefined
                }
                onUngroup={
                  canManage ? () => void refileCategory(group.channels, undefined) : undefined
                }
              />
              {!collapsed && group.channels.map(renderChannelRow)}
            </div>
          );
        })}
        {/* Only while dragging: an empty category can't exist. */}
        {canManage && channelDrag.dragging && (
          <div
            data-ch-newzone
            className={cn(
              "mt-2 flex items-center justify-center gap-1.5 clip-hairline-lg px-2 py-3 text-2xs font-semibold uppercase tracking-wider transition-colors",
              channelDrag.target?.newCategory
                ? "[--edge:var(--primary)] [--fill:var(--primary)/0.05] [--fill-hover:var(--primary)/0.05] text-primary"
                : "[--edge:var(--primary)/0.5] [--fill:var(--background)/0.4] [--fill-hover:var(--background)/0.4] text-muted-foreground/70",
            )}
          >
            <Plus className="size-3.5" />
            <FormattedMessage id="communitySettingsView.channels.newCategory" defaultMessage="New category" />
          </div>
        )}
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
              placeholder={intl.formatMessage({ id: "communitySettingsView.channels.newPlaceholder", defaultMessage: "new-channel" })}
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
              className="size-7 touch:size-11 shrink-0"
              disabled={isAddingChannel || !newName.trim()}
              aria-label={intl.formatMessage({ id: "communitySettingsView.channels.create", defaultMessage: "Create channel" })}
            >
              {isAddingChannel ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            </Button>
          </form>
        )}
      </div>

      {channelDrag.pointer && draggedChannel && (
        <div
          className="pointer-events-none fixed z-[300] -translate-y-1/2 animate-in zoom-in-75 duration-150"
          style={{ left: (channelDrag.columnX?.left ?? 0) + 12, top: channelDrag.pointer.y }}
        >
          <span className="flex max-w-48 items-center gap-2 rotate-[-2deg] scale-105 clip-corner-lg bg-muted px-3 py-1.5 text-sm font-medium ring-2 ring-primary [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
            <ChannelGlyph isPrivate={draggedChannel.isPrivate} view={draggedChannel.view} className="size-4 shrink-0" />
            <span className="truncate">{draggedChannel.name}</span>
          </span>
        </div>
      )}
      {channelDrag.dragging && (
        <div className="fixed inset-0 z-[298] cursor-grabbing" aria-hidden />
      )}
      {channelDrag.indicatorY !== null && !channelDrag.target?.newCategory && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[299] h-0.5 rounded-full bg-primary shadow-[0_0_6px_hsl(var(--primary)/0.7)]"
          style={{
            top: channelDrag.indicatorY - 1,
            left: (channelDrag.columnX?.left ?? 0) + 6,
            width: (channelDrag.columnX?.width ?? 0) - 12,
          }}
        />
      )}

      <CategoryNameDialog
        open={Boolean(categoryPrompt)}
        initial={categoryPrompt?.initial ?? ""}
        count={categoryPrompt?.channels.length ?? 0}
        onOpenChange={(next) => !next && setCategoryPrompt(null)}
        onSubmit={(name) => categoryPrompt && void refileCategory(categoryPrompt.channels, name)}
      />
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
  onSetView,
  onNewCategory,
  onDelete,
  accessRoles,
  onPrivatise,
  onRotateKey,
  onMintAccessRole,
}: {
  channel: Channel;
  canManage: boolean;
  disabled: boolean;
  categories: string[];
  onRename: (name: string) => Promise<void>;
  onSetCategory: (name: string | undefined) => Promise<void>;
  /** Flip what the channel opens to — forum feed or chat (CORD-03 §2 `view`). */
  onSetView?: (view: ChannelView) => Promise<void>;
  onNewCategory: () => void;
  onDelete?: () => void;
  /** The Roles scoped to this channel — who may read it (CORD-03/04 §2). */
  accessRoles?: Array<{ id: string; name: string }>;
  onPrivatise?: (accessRoleName?: string) => Promise<void>;
  /** Re-key to exactly the currently-entitled members (drift/leak repair). */
  onRotateKey?: () => Promise<void>;
  onMintAccessRole?: (name: string) => Promise<void>;
}) {
  const intl = useIntl();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(channel.name);
  const [accessOpen, setAccessOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [roleDraft, setRoleDraft] = useState("");
  const [addingRole, setAddingRole] = useState(false);

  const file = async (name: string | undefined) => {
    try {
      await onSetCategory(name);
      toast({
        title: name
          ? t({ id: "communitySettingsView.channel.movedTo", defaultMessage: "Moved to {name}" }, { name })
          : t({ id: "communitySettingsView.channel.removedFromCategory", defaultMessage: "Removed from category" }),
      });
    } catch (e) {
      toast({
        title: t({ id: "communitySettingsView.channel.moveFailed", defaultMessage: "Couldn't move channel" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    setValue(channel.name);
  }, [channel.name]);

  useEffect(() => {
    if (accessOpen) return;
    setRoleDraft("");
    setAddingRole(false);
  }, [accessOpen]);

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
      } catch (e) {
        toast({
          title: t({ id: "communitySettingsView.channel.renameFailed", defaultMessage: "Rename failed" }),
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        });
        setValue(channel.name);
      }
    }
    setEditing(false);
  };

  const isForum = channel.view === "forum";
  const showAccessButton = canManage && Boolean(onPrivatise || (channel.isPrivate && onRotateKey));
  const row = (
    <div className="px-1">
    <div className="flex items-center gap-2">
      {canManage && !editing && (
        <GripVertical
          aria-hidden
          className="-ml-1 size-4 shrink-0 cursor-grab text-muted-foreground/50"
        />
      )}
      <ChannelGlyph isPrivate={channel.isPrivate} view={channel.view} className="size-3.5 shrink-0 text-muted-foreground" />
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
            className="size-7 touch:size-11 shrink-0"
            disabled={disabled}
            aria-label={intl.formatMessage({ id: "communitySettingsView.channel.saveName", defaultMessage: "Save name" })}
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
          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0 text-muted-foreground touch:size-11"
                  aria-label={intl.formatMessage({ id: "communitySettingsView.channel.actions", defaultMessage: "Actions for {name}" }, { name: channel.name })}
                  disabled={disabled}
                >
                  <MoreVertical className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onSelect={() => setEditing(true)}>
                  <Pencil className="size-3.5" />
                  <FormattedMessage id="communitySettingsView.channel.rename" defaultMessage="Rename" />
                </DropdownMenuItem>
                {onSetView && (
                  // Same channel id: history stays valid either way.
                  <DropdownMenuItem
                    disabled={busy}
                    onSelect={() =>
                      void run(async () => {
                        await onSetView(isForum ? "chat" : "forum");
                        toast({
                          title: isForum
                            ? t({ id: "communitySettingsView.channel.opensAsChat", defaultMessage: "Opens as chat now" })
                            : t({ id: "communitySettingsView.channel.opensAsForum", defaultMessage: "Opens as a forum now" }),
                          description: isForum
                            ? t(
                              { id: "communitySettingsView.channel.opensAsChatDescription", defaultMessage: "#{name} shows the live timeline first." },
                              { name: channel.name },
                            )
                            : t(
                              {
                                id: "communitySettingsView.channel.opensAsForumDescription",
                                defaultMessage: "#{name} lists titled posts first; live chat stays a tap away.",
                              },
                              { name: channel.name },
                            ),
                        });
                      }, t({ id: "communitySettingsView.channel.setViewFailed", defaultMessage: "Couldn't change how the channel opens" }))
                    }
                  >
                    {isForum ? <Hash className="size-3.5" /> : <MessageSquareText className="size-3.5" />}
                    {isForum
                      ? <FormattedMessage id="communitySettingsView.channel.openAsChat" defaultMessage="Open as chat" />
                      : <FormattedMessage id="communitySettingsView.channel.openAsForum" defaultMessage="Open as forum" />}
                  </DropdownMenuItem>
                )}
                {showAccessButton && (
                  <DropdownMenuItem onSelect={() => setAccessOpen((v) => !v)}>
                    <Shield className="size-3.5" />
                    {channel.isPrivate
                      ? <FormattedMessage id="communitySettingsView.channel.access" defaultMessage="Channel access" />
                      : <FormattedMessage id="communitySettingsView.channel.makePrivateMenu" defaultMessage="Make private…" />}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger className="gap-2">
                    <Folder className="size-3.5" />
                    <FormattedMessage id="communitySettingsView.channel.category" defaultMessage="Category" />
                    {channel.category && (
                      <span className="ml-auto max-w-24 truncate text-xs text-muted-foreground">
                        {channel.category}
                      </span>
                    )}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-52">
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      <FormattedMessage id="communitySettingsView.channel.category" defaultMessage="Category" />
                    </DropdownMenuLabel>
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
                    <DropdownMenuItem onSelect={onNewCategory}>
                      <Plus className="size-3.5" />
                      <FormattedMessage id="communitySettingsView.channel.newCategory" defaultMessage="New category…" />
                    </DropdownMenuItem>
                    {channel.category && (
                      <DropdownMenuItem onSelect={() => void file(undefined)}>
                        <X className="size-3.5" />
                        <FormattedMessage id="communitySettingsView.channel.removeFromCategory" defaultMessage="Remove from category" />
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {onDelete && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onSelect={onDelete}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                      <FormattedMessage id="communitySettingsView.channel.delete" defaultMessage="Delete channel" />
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      )}
    </div>

    {accessOpen && (
      <div className="mb-1 ml-5 mt-1 space-y-1.5 rounded-lg bg-secondary/40 p-2.5">
        {channel.isPrivate ? (
          <>
            {/* CORD-03/04 §2: access is edited by granting channel-scoped Roles, not here. */}
            <p className="text-xs text-muted-foreground">
              {accessRoles?.length
                ? <FormattedMessage id="communitySettingsView.access.readableByRoles" defaultMessage="Readable by holders of these roles:" />
                : <FormattedMessage id="communitySettingsView.access.readableByNoRole" defaultMessage="Readable by holders of no role yet:" />}
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
                {onMintAccessRole
                  ? <FormattedMessage id="communitySettingsView.access.noRoleCreateBelow" defaultMessage="No role is scoped to this channel, so only the owner and existing key holders can read it. Create one below." />
                  : <FormattedMessage id="communitySettingsView.access.noRoleCreateInRoles" defaultMessage="No role is scoped to this channel, so only the owner and existing key holders can read it. Create one below in Roles, scoped to this channel." />}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              <FormattedMessage id="communitySettingsView.access.grantHint" defaultMessage="Grant one of these roles to give a member access; revoking it rotates the key away." />
            </p>
            {onMintAccessRole && addingRole && (
              <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  const trimmed = roleDraft.trim();
                  if (!trimmed) return;
                  void run(async () => {
                    await onMintAccessRole(trimmed);
                    setRoleDraft("");
                    setAddingRole(false);
                  }, t({ id: "communitySettingsView.access.createRoleFailed", defaultMessage: "Couldn't create the role" }));
                }}
              >
                <Shield className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                <Input
                  value={roleDraft}
                  onChange={(e) => setRoleDraft(e.target.value)}
                  placeholder={intl.formatMessage({ id: "communitySettingsView.access.roleName", defaultMessage: "Role name" })}
                  aria-label={intl.formatMessage({ id: "communitySettingsView.access.newRoleName", defaultMessage: "New access role name" })}
                  autoFocus
                  maxLength={64}
                  disabled={busy}
                  className="h-7 text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setAddingRole(false);
                      setRoleDraft("");
                    }
                  }}
                />
                <Button
                  type="submit"
                  size="icon"
                  variant="ghost"
                  className="size-7 touch:size-11 shrink-0"
                  disabled={busy || !roleDraft.trim()}
                  aria-label={intl.formatMessage({ id: "communitySettingsView.access.createRole", defaultMessage: "Create access role" })}
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                </Button>
              </form>
            )}
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              <FormattedMessage id="communitySettingsView.access.public" defaultMessage="Readable by every member. A public channel's key comes from the community root." />
            </p>
            {onPrivatise && (
              <Input
                value={roleDraft}
                onChange={(e) => setRoleDraft(e.target.value)}
                placeholder={intl.formatMessage(
                  { id: "communitySettingsView.access.roleNamePlaceholder", defaultMessage: "Access role name (default: {name})" },
                  { name: channel.name },
                )}
                aria-label={intl.formatMessage({ id: "communitySettingsView.access.roleNameLabel", defaultMessage: "Access role name" })}
                maxLength={64}
                disabled={busy}
                className="h-7 text-sm"
              />
            )}
          </>
        )}
        <div className="flex items-center justify-end gap-2 pt-1">
          {!channel.isPrivate && onPrivatise && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mr-auto text-muted-foreground"
              disabled={busy}
              onClick={() => run(async () => {
                await onPrivatise(roleDraft.trim() || undefined);
                setRoleDraft("");
                setAccessOpen(false);
              }, t({ id: "communitySettingsView.access.makePrivateFailed", defaultMessage: "Couldn't make the channel private" }))}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <FormattedMessage id="communitySettingsView.access.makePrivate" defaultMessage="Make private" />}
            </Button>
          )}
          {channel.isPrivate && onMintAccessRole && !addingRole && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="mr-auto text-muted-foreground"
              disabled={busy}
              title={intl.formatMessage({
                id: "communitySettingsView.access.newRoleHint",
                defaultMessage: "Mint another role scoped to this channel. Holding any of its roles grants access.",
              })}
              onClick={() => setAddingRole(true)}
            >
              <FormattedMessage id="communitySettingsView.access.newRole" defaultMessage="New role" />
            </Button>
          )}
          {channel.isPrivate && onRotateKey && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={cn("text-muted-foreground", !onMintAccessRole && "mr-auto")}
              disabled={busy}
              title={intl.formatMessage({
                id: "communitySettingsView.access.rotateHint",
                defaultMessage: "Mint a fresh key for exactly the members entitled today. Anyone else loses access from here on.",
              })}
              onClick={() => {
                if (!confirm(t(
                  {
                    id: "communitySettingsView.access.confirmRotate",
                    defaultMessage:
                      "Rotate #{name}'s key?\n\nIt gets a fresh key delivered only to members who hold one of its roles right now. Anyone else, including someone who kept a key from an earlier setting, loses access to what's said next.",
                  },
                  { name: channel.name },
                ))) return;
                void run(async () => {
                  await onRotateKey();
                  toast({ title: t({ id: "communitySettingsView.access.rotated", defaultMessage: "Channel key rotated" }) });
                }, t({ id: "communitySettingsView.access.rotateFailed", defaultMessage: "Couldn't rotate the key" }));
              }}
            >
              <FormattedMessage id="communitySettingsView.access.rotate" defaultMessage="Rotate key" />
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setAccessOpen(false)}>
            <FormattedMessage {...common.close} />
          </Button>
        </div>
      </div>
    )}
    </div>
  );

  return row;
}

/**
 * Disappearing messages (CORD-08): publishes a metadata edition and a kind-1740
 * notice into each keyed channel. Applies at SEND time only.
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
  const intl = useIntl();
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
      // Best-effort (CORD-08 §4): the metadata fold is the authority.
      await publishTimerNotices(nostr, community, channels, user.signer, user.pubkey, seconds).catch(
        () => undefined,
      );
      toast({
        title:
          seconds > 0
            ? t(
              { id: "communitySettingsView.disappearing.set", defaultMessage: "Disappearing messages: {duration}" },
              { duration: formatCommunityTimer(seconds) },
            )
            : t({ id: "communitySettingsView.disappearing.off", defaultMessage: "Disappearing messages turned off" }),
      });
    } catch (e) {
      toast({
        title: t({ id: "communitySettingsView.disappearing.failed", defaultMessage: "Couldn't update disappearing messages" }),
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
        <FormattedMessage id="communitySettingsView.disappearing.title" defaultMessage="Disappearing messages" />
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
              <SelectTrigger
                className="h-8 w-36"
                aria-label={intl.formatMessage({ id: "communitySettingsView.disappearing.timer", defaultMessage: "Disappearing messages timer" })}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMMUNITY_TIMER_PRESETS.map((p) => (
                  <SelectItem key={p.seconds} value={String(p.seconds)}>
                    {p.label}
                  </SelectItem>
                ))}
                {current > 0 && !COMMUNITY_TIMER_PRESETS.some((p) => p.seconds === current) && (
                  <SelectItem value={String(current)}>{formatCommunityTimer(current)}</SelectItem>
                )}
              </SelectContent>
            </Select>
            {saving && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          </>
        ) : (
          <span>
            {current > 0
              ? <FormattedMessage
                id="communitySettingsView.disappearing.after"
                defaultMessage="New messages disappear after {duration}"
                values={{ duration: formatCommunityTimer(current) }}
              />
              : <FormattedMessage id="communitySettingsView.disappearing.offShort" defaultMessage="Off" />}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {current > 0
          ? <FormattedMessage id="communitySettingsView.disappearing.onHint" defaultMessage="Messages in every channel are deleted for everyone after this long. Changes apply to new messages only." />
          : <FormattedMessage id="communitySettingsView.disappearing.offHint" defaultMessage="Messages are kept forever. When set, messages in every channel delete for everyone after the chosen time." />}
      </p>
    </div>
  );
}

/**
 * Community voice servers (CORD-02 §6 / CORD-07 §5). Empty: members use their
 * own. Non-empty is EXCLUSIVE, so all-down means no calls. Brokers hold no
 * secrets and see only E2EE media; the choice is who sees IPs and call timing.
 */
function VoiceServersSection({
  community,
  brokers,
  canManage,
}: {
  community: Community;
  brokers: string[];
  canManage: boolean;
}) {
  const intl = useIntl();
  const { updateMetadata } = useMetadataActions(community);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [addValue, setAddValue] = useState("");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  if (brokers.length === 0 && !canManage) return null;

  const startEditing = () => {
    setDraft(brokers);
    setAddValue("");
    setError(null);
    setWarning(null);
    setEditing(true);
  };

  const addBroker = async () => {
    setError(null);
    setWarning(null);
    const raw = addValue.trim();
    // Non-https refused: the token grant is a bearer credential (CORD-07 §2).
    const origin = canonicalOrigin(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!origin) {
      setError(t({ id: "communitySettingsView.voice.invalid", defaultMessage: "Enter an https address, like https://voice.example.com" }));
      return;
    }
    if (draft.includes(origin)) {
      setAddValue("");
      return;
    }
    if (draft.length >= MAX_COMMUNITY_AV_BROKERS) return;
    // Probed but not gating: a broker down today is still the intended one.
    setChecking(true);
    const reachable = await probeAvBroker(origin).catch(() => false);
    setChecking(false);
    setDraft([...draft, origin]);
    setAddValue("");
    if (!reachable) {
      setWarning(t(
        {
          id: "communitySettingsView.voice.unreachable",
          defaultMessage: "{host} didn't answer the voice-server probe. It stays in the list, but members will skip past it until it does.",
        },
        { host: origin.replace(/^https:\/\//, "") },
      ));
    }
  };

  const handleSave = async () => {
    setError(null);
    if (draft.length === brokers.length && draft.every((b, i) => b === brokers[i])) {
      setEditing(false);
      return;
    }
    try {
      setSaving(true);
      await updateMetadata({ av_brokers: draft });
      toast({
        title: draft.length > 0
          ? t({ id: "communitySettingsView.voice.updated", defaultMessage: "Voice servers updated" })
          : t({ id: "communitySettingsView.voice.cleared", defaultMessage: "Voice servers cleared" }),
        ...(draft.length === 0
          ? { description: t({ id: "communitySettingsView.voice.clearedDescription", defaultMessage: "Members will use their own configured voice server." }) }
          : {}),
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "communitySettingsView.voice.failed", defaultMessage: "Couldn't update the voice servers." }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <FormattedMessage id="communitySettingsView.voice.title" defaultMessage="Voice servers" />
        </span>
        {canManage && !editing && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 touch:size-11 shrink-0 text-muted-foreground"
            aria-label={intl.formatMessage({ id: "communitySettingsView.voice.edit", defaultMessage: "Edit voice servers" })}
            onClick={startEditing}
          >
            <Pencil className="size-3" />
          </Button>
        )}
      </div>

      {!editing ? (
        brokers.length === 0 ? (
          <p className="text-2xs text-muted-foreground">
            <FormattedMessage id="communitySettingsView.voice.none" defaultMessage="None set, so calls use each member's own voice server. Setting them here makes every call in this community use these, and only these." />
          </p>
        ) : (
          <ul className="space-y-1">
            {brokers.map((b) => (
              <li key={b} className="truncate rounded-md bg-secondary/40 px-2 py-1 text-xs font-mono">
                {b}
              </li>
            ))}
          </ul>
        )
      ) : (
        <div className="space-y-1.5">
          <ul className="space-y-1">
            {draft.map((b) => (
              <li
                key={b}
                className="flex items-center gap-1 rounded-md bg-secondary/40 py-0.5 pl-2 pr-0.5 text-xs font-mono"
              >
                <span className="min-w-0 flex-1 truncate">{b}</span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-6 touch:size-11 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={intl.formatMessage({ id: "communitySettingsView.voice.remove", defaultMessage: "Remove {server}" }, { server: b })}
                  disabled={saving || checking}
                  onClick={() => setDraft(draft.filter((x) => x !== b))}
                >
                  <Trash2 className="size-3" />
                </Button>
              </li>
            ))}
          </ul>

          {draft.length < MAX_COMMUNITY_AV_BROKERS ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                void addBroker();
              }}
            >
              <Input
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
                placeholder="https://voice.example.com"
                disabled={saving || checking}
                className="h-7 flex-1 font-mono text-xs"
              />
              <Button
                type="submit"
                size="icon"
                variant="ghost"
                className="size-7 touch:size-11 shrink-0"
                disabled={saving || checking || !addValue.trim()}
                aria-label={intl.formatMessage({ id: "communitySettingsView.voice.add", defaultMessage: "Add voice server" })}
              >
                {checking ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              </Button>
            </form>
          ) : (
            <p className="text-2xs text-muted-foreground">
              <FormattedMessage
                id="communitySettingsView.voice.max"
                defaultMessage="Up to {max} voice servers; past that, clients trim the list."
                values={{ max: MAX_COMMUNITY_AV_BROKERS }}
              />
            </p>
          )}

          <p className="text-2xs text-muted-foreground">
            <FormattedMessage id="communitySettingsView.voice.exclusiveHint" defaultMessage="Calls use only these, spread across them by channel. Members' own voice servers are ignored here, so if none of these answer, calls can't start. Leave it empty to let every member use their own." />
          </p>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {warning && <p className="text-2xs text-warning">{warning}</p>}

          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              aria-label={intl.formatMessage({ id: "communitySettingsView.voice.save", defaultMessage: "Save voice servers" })}
              disabled={saving || checking}
              onClick={handleSave}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0 text-muted-foreground"
              aria-label={intl.formatMessage(common.cancel)}
              disabled={saving}
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

/**
 * Community relay set (CORD-02 §6). Saving publishes to old ∪ new and first
 * MIRRORS history onto added relays. Capped at 5 (capRelays drops extras network-wide).
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
  const intl = useIntl();
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const { updateMetadata } = useMetadataActions(community);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [busy, setBusy] = useState<MirrorProgress | { phase: "edition" } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (relays.length === 0 && !canManage) return null;

  const startEditing = () => {
    setDraft(relays);
    setError(null);
    setEditing(true);
  };

  const handleSave = async () => {
    setError(null);
    if (draft.length === 0) {
      setError(t({ id: "communitySettingsView.relays.needOne", defaultMessage: "A community needs at least one relay." }));
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
        t({
          id: "communitySettingsView.relays.confirmReplaceAll",
          defaultMessage: "This replaces every current relay at once. Members offline during the switch may lose track of the community, and previously shared invite links will keep pointing at the old relays. Keeping at least one current relay through a transition is safer. Continue?",
        }),
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
            .map(([url, r]) => t(
              { id: "communitySettingsView.relays.refused", defaultMessage: "{relay} refused {rejected} of {found} events" },
              { relay: url.replace(/^wss?:\/\//, ""), rejected: r.rejected, found: report.found },
            ))
            .join("; ");
        }
      }
      setBusy({ phase: "edition" });
      await updateMetadata({ relays: draft });
      // Refresh my own links now (others heal via useLinkRefreshWatch), to old ∪ new:
      // existing links' hints point at the old relays.
      if (user?.signer.nip44) {
        const bundleFanout = [...new Set([...community.relays, ...draft])];
        refreshInviteBundlesFor(nostr, user, { ...community, relays: draft }, metadata, bundleFanout).catch(
          () => undefined,
        );
      }
      toast({
        title: t({ id: "communitySettingsView.relays.updated", defaultMessage: "Relays updated" }),
        ...(rejectedNote ? { description: rejectedNote, variant: "destructive" as const } : {}),
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "communitySettingsView.relays.failed", defaultMessage: "Couldn't update relays." }));
    } finally {
      setBusy(null);
    }
  };

  const busyLabel =
    busy === null
      ? null
      : busy.phase === "edition"
        ? intl.formatMessage({ id: "communitySettingsView.relays.publishing", defaultMessage: "Publishing the new relay list…" })
        : busy.phase === "fetch"
          ? intl.formatMessage(
            { id: "communitySettingsView.relays.gathering", defaultMessage: "Gathering community history… {count} events" },
            { count: busy.done },
          )
          : intl.formatMessage(
            { id: "communitySettingsView.relays.copying", defaultMessage: "Copying history to {relay}… {done}/{total}" },
            { relay: busy.relay.replace(/^wss?:\/\//, ""), done: busy.done, total: busy.total },
          );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <FormattedMessage id="communitySettingsView.relays.title" defaultMessage="Relays" />
        </span>
        {canManage && !editing && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 shrink-0 text-muted-foreground"
            aria-label={intl.formatMessage({ id: "communitySettingsView.relays.edit", defaultMessage: "Edit relays" })}
            onClick={startEditing}
          >
            <Pencil className="size-3" />
          </Button>
        )}
      </div>

      {!editing ? (
        <RelayListEditor relays={relays} readOnly />
      ) : (
        <div className="space-y-1.5">
          <RelayListEditor
            relays={draft}
            onChange={setDraft}
            disabled={busy !== null}
            min={1}
            max={MAX_COMMUNITY_RELAYS}
            maxText={intl.formatMessage(
              { id: "communitySettingsView.relays.max", defaultMessage: "Up to {max} relays; past that, clients trim the list." },
              { max: MAX_COMMUNITY_RELAYS },
            )}
          />

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {busyLabel && (
            <p className="flex items-center gap-1.5 text-2xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> {busyLabel}
            </p>
          )}

          <div className="flex justify-end gap-1">
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 shrink-0"
              aria-label={intl.formatMessage({ id: "communitySettingsView.relays.save", defaultMessage: "Save relays" })}
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
              aria-label={intl.formatMessage(common.cancel)}
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
