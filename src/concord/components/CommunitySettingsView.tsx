import {
  ArrowLeft,
  Check,
  Folder,
  FolderPlus,
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
import { withRankedCategories, groupChannelsByCategory } from "@/concord/lib/channelCategory";
import {
  applyArrangement,
  arrangedBefore,
  dropChanges,
  arrangementSettled,
  pendingFromPlan,
  planChannelDrop,
  type PendingArrangement,
} from "@/concord/lib/channelArrangement";
import { CategoryNameDialog } from "@/concord/components/CategoryNameDialog";
import { ChannelEditor, ChannelEditorPane } from "@/concord/components/channelEditor/ChannelEditor";
import type { EditorOps, EditorScope } from "@/concord/components/channelEditor/useChannelEditor";
import { useRankedCategoryControls } from "@/concord/components/RankedCategoryControls";
import { useChannelDrag, type ChannelDrop, type ChannelDropSlot } from "@/concord/hooks/useChannelDrag";
import { useCommunityManagement } from "@/concord/hooks/useCommunityActions";
import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { useRankedRoles } from "@/concord/hooks/useRankedRoles";
import { useCommunityDiscoverListings } from "@/concord/hooks/useDiscoverListings";
import { refreshInviteBundlesFor } from "@/concord/hooks/useRekey";
import { useMetadataActions } from "@/concord/hooks/useRoles";
import { DisplayName } from "@/components/DisplayName";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useIsTouch } from "@/hooks/useIsMobile";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { useUploadFile } from "@/hooks/useUploadFile";
import { encryptedUploadFailureReason } from "@/lib/blossomPreflight";
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
import { scrollParentOf } from "@/lib/scrollParent";
import { cn } from "@/lib/utils";
import { common, defineMessages, FormattedMessage, t, useIntl } from "@/i18n";
import { ChannelGlyph } from "@/concord/components/ChannelGlyph";
import { channelGitRepositoryAttachments } from "@/concord/lib/types";
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
  editorOps,
  onNewChannel,
  onOpenInvites,
}: {
  community: Community;
  metadata: CommunityMetadata | undefined;
  ownerHex: string | undefined;
  memberCount: number;
  canManageMetadata: boolean;
  canManageChannels: boolean;
  /** What the channel editor needs from the page: access Roles, key rotation (CORD-04 §2). */
  editorOps?: EditorOps;
  /** Opens the page's new-channel dialog. */
  onNewChannel?: () => void;
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
      setError(encryptedUploadFailureReason(e) ?? (e instanceof Error ? e.message : t({ id: "communitySettingsView.uploadFailed", defaultMessage: "Upload failed." })));
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

  // Room for the channel editor beside its list. The column is that wide on every tab, so the tabs don't jump.
  const touch = useIsTouch();
  const [roomy, attachPane] = useMinWidth(SPLIT_MIN_PX);
  const split = canManageChannels && !touch && roomy;
  const column = split ? "max-w-2xl" : undefined;

  return (
    <div ref={attachPane}>
    <div className={cn("mx-auto w-full px-3 py-4", split ? "max-w-5xl" : "max-w-2xl")}>
      <div className="mb-4 flex">
        <PillTabs tabs={settingsTabs} value={tab} onChange={(id) => setTab(id)} />
      </div>

      {tab === "overview" && (
        <div className={cn("space-y-5", column)}>
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
        <ChannelsSection community={community} canManage={canManageChannels} split={split} editorOps={editorOps} onNewChannel={onNewChannel} />
      )}

      {tab === "integrations" && (
        <div className={cn("space-y-5", column)}>
          <ConnectedRepositoriesSection community={community} canManage={canManageChannels} />

          <DiscordBridgeSection canManage={canManageChannels} />
        </div>
      )}

      {tab === "relays" && (
        <div className={cn("space-y-5", column)}>
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

const editorScopeKey = (scope: EditorScope) => `${scope.kind}:${scope.idHex}`;

/** The pane width from which the editor fits beside the channel list. */
const SPLIT_MIN_PX = 880;
/** Shorter than this and the page scrolls after all. */
const SPLIT_MIN_HEIGHT_PX = 320;

/** Whether the attached element is at least `min` px wide, re-read as it resizes. */
function useMinWidth(min: number) {
  const [wide, setWide] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const attach = useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      if (!el) return;
      setWide(el.getBoundingClientRect().width >= min);
      observer.current = new ResizeObserver((entries) => setWide((entries[0]?.contentRect.width ?? 0) >= min));
      observer.current.observe(el);
    },
    [min],
  );
  return [wide, attach] as const;
}

/** The height left under the attached element in its scroll parent, so its columns scroll and the page doesn't. */
function useFillHeight(bottomGap: number) {
  const [height, setHeight] = useState<number | undefined>(undefined);
  const observer = useRef<ResizeObserver | null>(null);
  const attach = useCallback(
    (el: HTMLElement | null) => {
      observer.current?.disconnect();
      observer.current = null;
      const scroller = el && scrollParentOf(el);
      if (!el || !scroller) return;
      const measure = () => {
        const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        setHeight(Math.max(SPLIT_MIN_HEIGHT_PX, scroller.clientHeight - top - bottomGap));
      };
      measure();
      observer.current = new ResizeObserver(measure);
      observer.current.observe(scroller);
    },
    [bottomGap],
  );
  return [height, attach] as const;
}

const LIST_GRIP = "-ml-1 flex size-6 shrink-0 items-center justify-center touch:size-11";
const LIST_ROW = "flex items-center gap-1 rounded-md pl-2 pr-1 transition-colors";

/** `touch-none`, so a finger on it drags while the rest of the row scrolls the page. */
function ListGrip({ onPointerDown }: { onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <span aria-hidden data-drag-grip onPointerDown={onPointerDown} className={cn(LIST_GRIP, "cursor-grab touch-none text-muted-foreground/50")}>
      <GripVertical className="size-4" />
    </span>
  );
}

/**
 * The community's channels and categories. A row opens the editor: beside the
 * list where the pane is `split`, over the page otherwise. MANAGE_CHANNELS drags
 * a row by its grip, with the same `useChannelDrag` and optimistic order as the sidebar.
 */
function ChannelsSection({
  community,
  canManage,
  split,
  editorOps,
  onNewChannel,
}: {
  community: Community;
  canManage: boolean;
  split: boolean;
  editorOps?: EditorOps;
  onNewChannel?: () => void;
}) {
  const intl = useIntl();
  const channels = useChannels(community);
  const { setChannelCategory, arrangeChannels, nameCategory } = useCommunityManagement(community);
  const { moveCategory } = useRankedRoles(community);
  const rankedControls = useRankedCategoryControls(community, canManage);
  const { ranked } = rankedControls;
  // MANAGE_ROLES alone still opens the editor, for its permissions.
  const canOpen = canManage || Boolean(rankedControls.openChannelPermissions);

  // A Category drop shows at once, until the fold moves on from the order it was made against.
  const [pendingCategories, setPendingCategories] = useState<{ from: string; order: readonly string[] } | null>(null);
  const foldedCategoryOrder = useMemo(() => rankedControls.categories.map((c) => c.idHex).join(), [rankedControls.categories]);
  if (pendingCategories && pendingCategories.from !== foldedCategoryOrder) setPendingCategories(null);
  const rankedCategories = useMemo(() => {
    if (!pendingCategories) return rankedControls.categories;
    const byId = new Map(rankedControls.categories.map((c) => [c.idHex, c]));
    return pendingCategories.order.flatMap((id) => byId.get(id) ?? []);
  }, [rankedControls.categories, pendingCategories]);

  // Dropped as soon as the fold agrees, so others' later changes aren't masked (channelArrangement.ts).
  const [pendingArrangement, setPendingArrangement] = useState<PendingArrangement | null>(null);
  /** On the vsk-13 Roster a drop names Categories by id (CORD-03 §4); this reads one back. */
  const rankedNames = useMemo(
    () => {
      if (!ranked) return undefined;
      const names = new Map(rankedCategories.map((c) => [c.idHex, c.name || c.idHex.slice(0, 8)]));
      return (id: string) => names.get(id);
    },
    [ranked, rankedCategories],
  );
  const arrangedChannels = useMemo(
    () => applyArrangement(channels, pendingArrangement, rankedNames),
    [channels, pendingArrangement, rankedNames],
  );
  useEffect(() => {
    if (pendingArrangement && arrangementSettled(channels, pendingArrangement, Boolean(rankedNames))) {
      setPendingArrangement(null);
    }
  }, [channels, pendingArrangement, rankedNames]);

  const { uncategorized: uncategorizedChannels, categories: channelCategories } = useMemo(() => {
    const grouped = groupChannelsByCategory(arrangedChannels, (c) => c.category);
    // Every vsk-13 Category, an empty one included (CORD-03 §4).
    return ranked ? { ...grouped, categories: withRankedCategories(grouped.categories, rankedCategories, () => true) } : grouped;
  }, [arrangedChannels, ranked, rankedCategories]);

  // Drop indexes refer to THIS flattened order.
  const renderedChannels = useMemo(
    () => [...uncategorizedChannels, ...channelCategories.flatMap((group) => group.channels)],
    [uncategorizedChannels, channelCategories],
  );
  const renderedIndexOf = useMemo(
    () => new Map(renderedChannels.map((c, index) => [c.idHex, index])),
    [renderedChannels],
  );
  /** Where a drop into an empty Category lands in the flattened order. */
  const emptyIndexOf = useMemo(() => {
    const out = new Map<string, number>();
    let at = uncategorizedChannels.length;
    for (const g of channelCategories) {
      if (g.channels.length === 0) out.set(g.key, at);
      at += g.channels.length;
    }
    return out;
  }, [uncategorizedChannels, channelCategories]);

  const [scope, setScope] = useState<EditorScope | undefined>(undefined);
  const [paneDirty, setPaneDirty] = useState(false);
  // A row picked for the pane must not open the overlay when the pane narrows.
  const [wasSplit, setWasSplit] = useState(split);
  if (wasSplit !== split) {
    setWasSplit(split);
    setScope(undefined);
  }
  /** What the pane shows: the picked row while it exists, else the first channel. */
  const pickedExists = scope && (scope.kind === "channel"
    ? renderedChannels.some((c) => c.idHex === scope.idHex)
    : channelCategories.some((g) => g.key === scope.idHex));
  const firstChannel = renderedChannels[0];
  const paneScope: EditorScope | undefined = !split
    ? undefined
    : scope && pickedExists
    ? scope
    : firstChannel && { idHex: firstChannel.idHex, kind: "channel", name: firstChannel.name };
  const shownKey = paneScope && editorScopeKey(paneScope);
  const fill = Boolean(paneScope);
  const [fillHeight, attachFill] = useFillHeight(16);

  const open = (next: EditorScope) => {
    if (split && paneDirty && editorScopeKey(next) !== shownKey) {
      toast({ title: t({ id: "communitySettingsView.channels.unsaved", defaultMessage: "Save or cancel your changes first." }) });
      return;
    }
    setScope(next);
  };
  const closeEditor = useCallback(() => setScope(undefined), []);

  const [categoryPrompt, setCategoryPrompt] = useState<
    { channels: readonly Channel[]; initial: string; categoryId?: string } | null
  >(null);

  const submitCategoryName = (prompt: { channels: readonly Channel[]; categoryId?: string }, name: string) => {
    if (!ranked) return void refileCategory(prompt.channels, name);
    void nameCategory({ channelIds: prompt.channels.map((c) => c.idHex), categoryId: prompt.categoryId, name }).catch((e: unknown) =>
      toast({
        title: t({ id: "rankedCategory.saveFailed", defaultMessage: "Couldn't save the category" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      }),
    );
  };

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

  /** The list scrolls with the page, so the drag pans the pane around it. */
  const channelScrollRef = useRef<HTMLElement | null>(null);
  const categoryScrollRef = useRef<HTMLElement | null>(null);
  const channelListRef = useRef<HTMLDivElement | null>(null);

  const measureDropSlots = useCallback((): ChannelDropSlot[] => {
    const root = channelListRef.current;
    if (!root) return [];
    const out: ChannelDropSlot[] = [];
    let rows = 0;
    for (const el of root.querySelectorAll<HTMLElement>("[data-ch-slot]")) {
      const index = Number(el.dataset.chIndex);
      if (!Number.isInteger(index)) continue;
      const category = el.dataset.chCategory || undefined;
      const rect = el.getBoundingClientRect();
      // An empty Category is one slot, at its place in the list.
      if (el.dataset.chEmpty !== undefined) {
        out.push({ index, category, y: rect.top + rect.height / 2 });
        continue;
      }
      rows++;
      out.push({ index, category, y: rect.top });
      out.push({ index: index + 1, category, y: rect.bottom });
    }
    const zone = root.querySelector<HTMLElement>("[data-ch-newzone]");
    if (zone) {
      const rect = zone.getBoundingClientRect();
      out.push({
        index: rows,
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
      const before = arrangedBefore(renderedChannels, Boolean(rankedNames));
      const plan = planChannelDrop(before, sourceIdHex, drop.index, drop.category);
      const changes = dropChanges(before, plan, sourceIdHex, Boolean(rankedNames));
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
    [renderedChannels, arrangeChannels, rankedNames],
  );

  const channelDrag = useChannelDrag({
    enabled: canManage,
    columnRef: channelScrollRef,
    boundsRef: channelListRef,
    measure: measureDropSlots,
    onDrop: commitDrop,
    handle: true,
  });

  /** A Category is dropped between whole Categories: before the one at `index`. */
  const measureCategorySlots = useCallback((): ChannelDropSlot[] => {
    const root = channelListRef.current;
    if (!root) return [];
    const out: ChannelDropSlot[] = [];
    for (const el of root.querySelectorAll<HTMLElement>("[data-cat-slot]")) {
      const index = Number(el.dataset.catIndex);
      if (!Number.isInteger(index)) continue;
      const rect = el.getBoundingClientRect();
      out.push({ index, category: undefined, y: rect.top });
      out.push({ index: index + 1, category: undefined, y: rect.bottom });
    }
    return out;
  }, []);

  const commitCategoryDrop = useCallback(
    (sourceIdHex: string, drop: ChannelDrop) => {
      const order = rankedCategories.map((c) => c.idHex);
      const from = order.indexOf(sourceIdHex);
      if (from < 0) return;
      // `moveCategory` counts positions among the OTHER Categories.
      const index = drop.index > from ? drop.index - 1 : drop.index;
      if (index === from) return;
      order.splice(from, 1);
      order.splice(index, 0, sourceIdHex);
      setPendingCategories({ from: foldedCategoryOrder, order });
      void moveCategory({ idHex: sourceIdHex, index }).catch((e: unknown) => {
        setPendingCategories(null);
        toast({
          title: t({ id: "rankedCategory.moveFailed", defaultMessage: "Couldn't move the category" }),
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        });
      });
    },
    [rankedCategories, foldedCategoryOrder, moveCategory],
  );

  const categoryDrag = useChannelDrag({
    enabled: canManage && ranked,
    columnRef: categoryScrollRef,
    boundsRef: channelListRef,
    measure: measureCategorySlots,
    onDrop: commitCategoryDrop,
    handle: true,
  });

  const attachChannelColumn = channelDrag.attachColumn;
  const attachCategoryColumn = categoryDrag.attachColumn;
  const attachChannelList = useCallback(
    (el: HTMLDivElement | null) => {
      channelListRef.current = el;
      const scroller = el ? (scrollParentOf(el) ?? el) : null;
      attachChannelColumn(scroller);
      attachCategoryColumn(scroller);
    },
    [attachChannelColumn, attachCategoryColumn],
  );

  const draggedChannel = channelDrag.sourceIdHex
    ? (renderedChannels.find((c) => c.idHex === channelDrag.sourceIdHex) ?? null)
    : null;
  const draggedCategory = categoryDrag.sourceIdHex
    ? (channelCategories.find((g) => g.key === categoryDrag.sourceIdHex) ?? null)
    : null;
  const drag = categoryDrag.dragging ? categoryDrag : channelDrag;

  const draggedOutline = (
    <span className="pointer-events-none absolute inset-x-0 inset-y-px clip-hairline-lg [--edge:var(--primary)/0.5] [--fill:var(--primary)/0.05] [--fill-hover:var(--primary)/0.05]" />
  );

  const renderChannelRow = (ch: Channel) => {
    const index = renderedIndexOf.get(ch.idHex) ?? 0;
    const dragged = channelDrag.sourceIdHex === ch.idHex;
    const selected = shownKey === `channel:${ch.idHex}`;
    const body = (
      <>
        <ChannelGlyph isPrivate={ch.isPrivate} view={ch.view} className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{ch.name}</span>
      </>
    );
    const bodyClass = "flex min-h-9 min-w-0 flex-1 items-center gap-2 text-left touch:min-h-11";
    return (
      <div
        key={ch.idHex}
        data-ch-slot
        data-ch-index={index}
        data-ch-category={(rankedNames ? ch.categoryId : ch.category) ?? ""}
        className="relative"
      >
        {/* Dragged row stays MOUNTED (invisible): unmounting it cancels the touch gesture. */}
        <div className={cn(LIST_ROW, canOpen && "hover:bg-secondary/70", selected && "bg-secondary", dragged && "invisible")}>
          {canManage && <ListGrip onPointerDown={channelDrag.onPointerDown(ch.idHex)} />}
          {canOpen ? (
            <button
              type="button"
              aria-current={selected || undefined}
              onClick={() => open({ idHex: ch.idHex, kind: "channel", name: ch.name })}
              className={bodyClass}
            >
              {body}
            </button>
          ) : (
            <div className={bodyClass}>{body}</div>
          )}
        </div>
        {dragged && draggedOutline}
      </div>
    );
  };

  const renderCategory = (group: (typeof channelCategories)[number], index: number) => {
    const dragged = categoryDrag.sourceIdHex === group.key;
    const selected = shownKey === `category:${group.key}`;
    const aimed =
      channelDrag.dragging &&
      !channelDrag.target?.newCategory &&
      channelDrag.target?.category === (rankedNames ? group.key : group.name);
    const labelClass = cn(
      "flex min-h-8 min-w-0 flex-1 items-center text-left text-2xs font-semibold uppercase tracking-wider transition-colors touch:min-h-11",
      aimed || selected ? "text-primary" : "text-muted-foreground/80",
    );
    return (
      <div key={group.key} data-cat-slot data-cat-index={index} className="relative pt-1">
        {/* Mounted while dragged, like a channel row. */}
        <div className={cn("space-y-1", dragged && "invisible")}>
          <div className={cn(LIST_ROW, canOpen && "hover:bg-secondary/70", selected && "bg-secondary")}>
            {canManage && (ranked
              ? <ListGrip onPointerDown={categoryDrag.onPointerDown(group.key)} />
              : <span aria-hidden className={LIST_GRIP} />)}
            {canOpen ? (
              <button
                type="button"
                aria-current={selected || undefined}
                onClick={() => open({ idHex: group.key, kind: "category", name: group.name })}
                className={cn(labelClass, !aimed && !selected && "hover:text-foreground")}
              >
                <span className="truncate">{group.name}</span>
              </button>
            ) : (
              <div className={labelClass}>
                <span className="truncate">{group.name}</span>
              </div>
            )}
          </div>
          {group.channels.map(renderChannelRow)}
          {group.channels.length === 0 && canManage && channelDrag.dragging && (
            <div data-ch-slot data-ch-empty data-ch-index={emptyIndexOf.get(group.key) ?? 0} data-ch-category={group.key} className="h-6" />
          )}
        </div>
        {dragged && draggedOutline}
      </div>
    );
  };

  const list = (
    <div className={fill ? "flex min-h-0 flex-col gap-1.5" : "space-y-1.5"}>
      <div className="flex shrink-0 items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <FormattedMessage id="communitySettingsView.channels.title" defaultMessage="Channels" />
        </span>
        {canManage && (
          <span className="flex items-center">
            {ranked && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 text-muted-foreground touch:size-11"
                aria-label={intl.formatMessage({ id: "communitySettingsView.categories.add", defaultMessage: "Add category" })}
                onClick={() => setCategoryPrompt({ channels: [], initial: "" })}
              >
                <FolderPlus className="size-4" />
              </Button>
            )}
            {onNewChannel && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7 shrink-0 text-muted-foreground touch:size-11"
                aria-label={intl.formatMessage({ id: "communitySettingsView.channels.add", defaultMessage: "Add channel" })}
                onClick={onNewChannel}
              >
                <Plus className="size-4" />
              </Button>
            )}
          </span>
        )}
      </div>
      <div className={fill ? "min-h-0 overflow-y-auto overscroll-contain rounded-lg" : undefined}>
        {/* Keyed so the drags re-read their scroller when the list gains or loses one of its own. */}
        <div key={fill ? "own" : "page"} ref={attachChannelList} className="space-y-1 rounded-lg bg-secondary/40 p-1">
          {uncategorizedChannels.map(renderChannelRow)}
          {channelCategories.map(renderCategory)}
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
        </div>
      </div>
    </div>
  );

  return (
    <>
      {paneScope ? (
        <div
          ref={attachFill}
          style={{ height: fillHeight }}
          className="grid grid-cols-[16rem_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-6"
        >
          {list}
          <ChannelEditorPane
            key={editorScopeKey(paneScope)}
            community={community}
            scope={paneScope}
            ops={editorOps}
            className="max-h-full self-start"
            onRemoved={closeEditor}
            onDirtyChange={setPaneDirty}
          />
        </div>
      ) : (
        list
      )}

      {drag.pointer && (draggedChannel || draggedCategory) && (
        <div
          className="pointer-events-none fixed z-[300] -translate-y-1/2 animate-in zoom-in-75 duration-150"
          style={{ left: (drag.columnX?.left ?? 0) + 12, top: drag.pointer.y }}
        >
          <span className="flex max-w-48 items-center gap-2 rotate-[-2deg] scale-105 clip-corner-lg bg-muted px-3 py-1.5 text-sm font-medium ring-2 ring-primary [filter:drop-shadow(0_8px_16px_rgba(0,0,0,0.55))_drop-shadow(0_0_8px_hsl(var(--primary)/0.6))]">
            {draggedChannel
              ? <ChannelGlyph isPrivate={draggedChannel.isPrivate} view={draggedChannel.view} className="size-4 shrink-0" />
              : <Folder className="size-4 shrink-0" />}
            <span className="truncate">{draggedChannel?.name ?? draggedCategory?.name}</span>
          </span>
        </div>
      )}
      {drag.dragging && (
        <div className="fixed inset-0 z-[298] cursor-grabbing" aria-hidden />
      )}
      {drag.indicatorY !== null && !drag.target?.newCategory && (
        <div
          aria-hidden
          className="pointer-events-none fixed z-[299] h-0.5 rounded-full bg-primary shadow-[0_0_6px_hsl(var(--primary)/0.7)]"
          style={{
            top: drag.indicatorY - 1,
            left: (drag.columnX?.left ?? 0) + 6,
            width: (drag.columnX?.width ?? 0) - 12,
          }}
        />
      )}

      <CategoryNameDialog
        open={Boolean(categoryPrompt)}
        initial={categoryPrompt?.initial ?? ""}
        count={categoryPrompt?.channels.length ?? 0}
        onOpenChange={(next) => !next && setCategoryPrompt(null)}
        onSubmit={(name) => categoryPrompt && submitCategoryName(categoryPrompt, name)}
        ranked={ranked}
      />
      <ChannelEditor community={community} scope={split ? undefined : scope} ops={editorOps} onClose={closeEditor} />
    </>
  );
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
