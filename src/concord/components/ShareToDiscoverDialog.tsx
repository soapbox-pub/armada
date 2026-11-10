import { useQueryClient } from "@tanstack/react-query";
import { useNostr } from "@nostrify/react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, AlertTriangle, Loader2, Megaphone } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Button } from "@/components/ui/button";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useCommunity, useLiveCommunities } from "@/concord/hooks/useCommunityList";
import { useDecryptedImage } from "@/concord/hooks/useDecryptedImage";
import { useInviteActions, useInviteList } from "@/concord/hooks/useInvites";
import { useUnlistAnnouncements } from "@/concord/hooks/useDiscoverListings";
import {
  KIND_COMMUNITY_ANNOUNCEMENT,
  announcementFromEvent,
  buildCommunityAnnouncement,
  extractInviteUrls,
  type DiscoveredInvite,
} from "@/concord/lib/inviteDiscovery";
import { parseInviteLink } from "@/concord/lib/invite";
import { badgeOf } from "@/concord/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useListingRelays } from "@/hooks/useDiscover";
import { useNostrPublish } from "@/hooks/useNostrPublish";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";

import type { ImagePointer } from "@/concord/lib/types";
import { nowSecs } from "@/lib/relayClock";

/**
 * Share a community to Discover (a kind-33302 announcement carrying a live
 * invite link). The picker offers only owned/admin communities that ALREADY
 * have a live link, so a misclick can't mint the first link and flip it
 * public; that path is only via the community's own menu (`communityId`), with a confirm.
 */
export function ShareToDiscoverDialog({
  open,
  onOpenChange,
  communityId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselect this community and skip the picker (the community-page entry). */
  communityId?: string;
}) {
  const intl = useIntl();
  const [selectedId, setSelectedId] = useState<string | undefined>(communityId);

  useEffect(() => {
    if (open) setSelectedId(communityId);
  }, [open, communityId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent title={intl.formatMessage({ id: "shareToDiscoverDialog.title", defaultMessage: "Share to Discover" })}>
        <div className="flex flex-col items-center gap-6">
          <div className="flex flex-col items-center gap-3 text-center">
            <ArmadaCrest size={72} />
            <div className="space-y-1">
              <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
                <FormattedMessage id="shareToDiscoverDialog.heading" defaultMessage="share to discover" />
              </h2>
              <p className="text-sm text-muted-foreground">
                <FormattedMessage
                  id="shareToDiscoverDialog.description"
                  defaultMessage="List a community publicly so anyone browsing Discover can find and join it."
                />
              </p>
            </div>
          </div>
          {selectedId ? (
            <ShareForm idHex={selectedId} onDone={() => onOpenChange(false)} />
          ) : (
            <CommunityPicker onSelect={setSelectedId} />
          )}
        </div>
        <ArmadaCrestKeyframes />
      </ChromeDialogContent>
    </Dialog>
  );
}

function useCanShare(idHex: string | undefined) {
  const { user } = useCurrentUser();
  const community = useCommunity(idHex);
  const fold = useControlFold(community);
  const folded = fold.data;
  const eligible = Boolean(
    user &&
      folded &&
      (user.pubkey === folded.ownerHex || badgeOf(folded.roster, user.pubkey) === "admin"),
  );
  return { community, folded, eligible, isLoading: fold.isLoading };
}

function OptionIcon({
  icon,
  name,
  className = "size-8",
}: {
  icon: ImagePointer | undefined;
  name: string | undefined;
  className?: string;
}) {
  const url = useDecryptedImage(icon);
  if (url) return <img src={url} alt="" className={`${className} shrink-0 rounded object-cover`} />;
  return (
    <span
      className={`${className} flex shrink-0 items-center justify-center rounded bg-muted text-sm font-semibold uppercase text-muted-foreground`}
    >
      {name?.trim()?.[0] ?? "#"}
    </span>
  );
}

/** Renders only once the fold proves ownership/admin; reports its verdict so the picker can tell "checking" from "none". */
function CommunityOption({
  idHex,
  onSelect,
  onEligibility,
}: {
  idHex: string;
  onSelect: (idHex: string) => void;
  onEligibility: (idHex: string, eligible: boolean) => void;
}) {
  const { community, folded, eligible, isLoading } = useCanShare(idHex);

  useEffect(() => {
    if (isLoading) return;
    onEligibility(idHex, eligible);
  }, [isLoading, eligible, idHex, onEligibility]);

  if (!eligible) return null;
  const name = folded?.metadata?.name ?? community?.name ?? "…";
  return (
    <button
      type="button"
      onClick={() => onSelect(idHex)}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors clip-corner-lg hover:bg-foreground/10"
    >
      <OptionIcon icon={folded?.metadata?.icon} name={name} />
      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function CommunityPicker({ onSelect }: { onSelect: (idHex: string) => void }) {
  const entries = useLiveCommunities();
  const inviteList = useInviteList();
  const [eligibility, setEligibility] = useState<Record<string, boolean>>({});
  const report = useCallback(
    (idHex: string, eligible: boolean) =>
      setEligibility((prev) => (prev[idHex] === eligible ? prev : { ...prev, [idHex]: eligible })),
    [],
  );

  // The Invite List merge already drops revoked tokens; only check expiry.
  const linked = useMemo(() => {
    const now = nowSecs();
    const ids = new Set<string>();
    for (const e of inviteList.data?.entries ?? []) {
      if (!e.expires_at || e.expires_at > now) ids.add(e.community_id);
    }
    return ids;
  }, [inviteList.data]);

  const candidates = entries.filter((e) => linked.has(e.community_id));
  const checking = inviteList.isLoading || !candidates.every((e) => e.community_id in eligibility);
  const noneEligible =
    !checking && (candidates.length === 0 || candidates.every((e) => !eligibility[e.community_id]));

  return (
    <div className="w-full space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Megaphone className="size-3.5" />
        <FormattedMessage id="shareToDiscoverDialog.pick" defaultMessage="Pick a community you own or admin" />
      </div>
      <div className="max-h-64 space-y-0.5 overflow-y-auto p-1 clip-corner-lg bg-secondary">
        {!inviteList.isLoading &&
          candidates.map((e) => (
            <CommunityOption
              key={e.community_id}
              idHex={e.community_id}
              onSelect={onSelect}
              onEligibility={report}
            />
          ))}
        {checking && (
          <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <FormattedMessage id="shareToDiscoverDialog.checkingCommunities" defaultMessage="Checking your communities…" />
          </div>
        )}
        {noneEligible && (
          <p className="px-3 py-2 text-sm text-muted-foreground">
            <FormattedMessage
              id="shareToDiscoverDialog.noneEligible"
              defaultMessage="None of your communities can be listed here: sharing needs a community you own or admin with a live invite link of yours to publish. Create an invite link from the community's menu first."
            />
          </p>
        )}
      </div>
    </div>
  );
}

/** My own kind-3314 listings of this community; NIP-09 deletes only work on one's own events. */
function useMyAnnouncements(idHex: string, myLinkSigners: string[]) {
  const { nostr } = useNostr();
  const { user } = useCurrentUser();
  const relays = useListingRelays();
  const signers = useMemo(() => new Set(myLinkSigners), [myLinkSigners]);

  return useQuery({
    queryKey: ["discover", "my-announcements", user?.pubkey, idHex, [...signers].sort()],
    enabled: Boolean(user) && relays.length > 0,
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const events = await nostr.group(relays).query(
        [{ kinds: [KIND_COMMUNITY_ANNOUNCEMENT], authors: [user!.pubkey], limit: 100 }],
        { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) },
      );
      return events.filter((e) => {
        const [url] = extractInviteUrls(e.content);
        const signer = url ? parseInviteLink(url)?.linkSigner : undefined;
        return !!signer && signers.has(signer);
      });
    },
  });
}

function ShareForm({ idHex, onDone }: { idHex: string; onDone: () => void }) {
  const { community, folded, eligible, isLoading } = useCanShare(idHex);
  const { createLink, myLinks, isPublic, refreshMyLinks, linksLoading } = useInviteActions(community);
  const { mutateAsync: publishEvent } = useNostrPublish();
  const { unlist } = useUnlistAnnouncements();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const intl = useIntl();

  const name =
    folded?.metadata?.name ??
    community?.name ??
    intl.formatMessage({ id: "shareToDiscoverDialog.thisCommunity", defaultMessage: "this community" });

  // Reuse a live link so repeat shares fold to one listing, one revocation from un-listing.
  const now = nowSecs();
  const reusable = myLinks.find((e) => !e.expires_at || e.expires_at > now);
  const willMint = !reusable;

  const myLinkSigners = useMemo(
    () =>
      myLinks
        .map((e) => parseInviteLink(e.url)?.linkSigner)
        .filter((s): s is string => !!s),
    [myLinks],
  );
  const myAnnouncements = useMyAnnouncements(idHex, myLinkSigners);
  const listed = (myAnnouncements.data?.length ?? 0) > 0;

  const handleUnpublish = async () => {
    setError(null);
    const targets = myAnnouncements.data ?? [];
    if (targets.length === 0) return;
    setBusy(true);
    try {
      // NIP-09; Discover also honors these client-side and drops them from cache.
      await unlist(targets.map(announcementFromEvent).filter((a): a is DiscoveredInvite => !!a));
      toast({
        title: t({ id: "shareToDiscoverDialog.unpublished", defaultMessage: "Unpublished from Discover" }),
        description: t(
          { id: "shareToDiscoverDialog.unpublishedDescription", defaultMessage: "{name} is no longer listed by you." },
          { name },
        ),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "shareToDiscoverDialog.unpublishFailed", defaultMessage: "Couldn't unpublish the listing." }));
    } finally {
      setBusy(false);
    }
  };

  const makesPublic = willMint && !isPublic;

  const handleShare = async () => {
    setError(null);
    if (!community || !eligible) return;
    setBusy(true);
    try {
      let url: string;
      if (reusable) {
        url = reusable.url;
        // Re-post the CURRENT bundle so a link minted earlier shows today's name/icon/banner.
        await refreshMyLinks().catch(() => undefined);
      } else {
        url = await createLink({});
      }
      // Just the link: viewers resolve name/icon/banner (and which community) live from the bundle.
      const announcement = buildCommunityAnnouncement({ inviteUrl: url });
      if (!announcement) throw new Error(t({ id: "shareToDiscoverDialog.buildFailed", defaultMessage: "Couldn't build the listing." }));
      await publishEvent(announcement);
      queryClient.invalidateQueries({ queryKey: ["discover", "invite-bundle"] });
      queryClient.invalidateQueries({ queryKey: ["discover", "directory-infinite"] });
      queryClient.invalidateQueries({ queryKey: ["discover", "my-announcements"] });
      queryClient.invalidateQueries({ queryKey: ["discover", "link-announcements"] });
      toast({
        title: t({ id: "shareToDiscoverDialog.shared", defaultMessage: "Shared to Discover" }),
        description: t(
          { id: "shareToDiscoverDialog.sharedDescription", defaultMessage: "{name} is now publicly listed." },
          { name },
        ),
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "shareToDiscoverDialog.shareFailed", defaultMessage: "Couldn't share the community." }));
    } finally {
      setBusy(false);
    }
  };

  // A first listing publishes the secret (and may mint the first link), so confirm.
  const handleShareClick = () => {
    if (!listed) {
      setConfirmOpen(true);
      return;
    }
    void handleShare();
  };

  if (!eligible) {
    return isLoading ? (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <FormattedMessage id="shareToDiscoverDialog.checkingPermissions" defaultMessage="Checking permissions…" />
      </div>
    ) : (
      <Alert>
        <AlertDescription>
          <FormattedMessage
            id="shareToDiscoverDialog.notEligible"
            defaultMessage="Only this community's owner or an admin can share it to Discover."
          />
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="w-full space-y-3">
      <div className="flex items-center gap-3 px-3 py-2.5 clip-corner-lg bg-secondary">
        <OptionIcon icon={folded?.metadata?.icon} name={name} className="size-10" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium leading-tight">{name}</p>
          <p className="text-xs text-muted-foreground">
            {listed ? (
              <FormattedMessage id="shareToDiscoverDialog.isListed" defaultMessage="is listed publicly on Discover" />
            ) : (
              <FormattedMessage id="shareToDiscoverDialog.willBeListed" defaultMessage="will be listed publicly on Discover" />
            )}
          </p>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        <FormattedMessage
          id="shareToDiscoverDialog.stayCurrent"
          defaultMessage="Its name and images come from the community itself, so the listing stays current as they change."
        />
      </p>
      {!listed && makesPublic && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>
            <FormattedMessage
              id="shareToDiscoverDialog.publicWarningTitle"
              defaultMessage="Invite links make communities public"
            />
          </AlertTitle>
          <AlertDescription>
            <FormattedMessage
              id="shareToDiscoverDialog.publicWarning"
              defaultMessage="Anyone who gets the link can read every message sent up to this point in the community's public channels."
            />
          </AlertDescription>
        </Alert>
      )}
      {!listed && (
        <Alert>
          <AlertDescription>
            <FormattedMessage
              id="shareToDiscoverDialog.secretNotice"
              defaultMessage="Sharing publishes an invite link from your account, including its secret, so anyone can find and join."
            />
          </AlertDescription>
        </Alert>
      )}
      <Button
        type="button"
        onClick={handleShareClick}
        // `reusable` is blind until the Invite List loads; sharing early would mint a duplicate.
        disabled={busy || linksLoading || myAnnouncements.isLoading}
        variant={listed ? "secondary" : "default"}
        className="w-full clip-corner-lg"
      >
        {busy ? (
          <>
            <Loader2 className="mr-2 size-4 animate-spin" />{" "}
            <FormattedMessage id="shareToDiscoverDialog.working" defaultMessage="Working…" />
          </>
        ) : listed ? (
          <FormattedMessage id="shareToDiscoverDialog.update" defaultMessage="Update listing" />
        ) : (
          <FormattedMessage id="shareToDiscoverDialog.sharePublicly" defaultMessage="Share publicly" />
        )}
      </Button>
      {listed && (
        <Button
          type="button"
          variant="ghost"
          onClick={handleUnpublish}
          disabled={busy}
          className="w-full clip-corner-lg text-destructive hover:text-destructive"
        >
          <FormattedMessage id="shareToDiscoverDialog.unpublish" defaultMessage="Unpublish from Discover" />
        </Button>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {makesPublic ? (
                <FormattedMessage
                  id="shareToDiscoverDialog.confirmPublicTitle"
                  defaultMessage="Are you sure you want to make this community public?"
                />
              ) : (
                <FormattedMessage id="shareToDiscoverDialog.confirmTitle" defaultMessage="Share this community to Discover?" />
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <FormattedMessage
                id="shareToDiscoverDialog.confirmDescription"
                defaultMessage="The listing publishes the invite link, including its secret, from your account, so anyone can find and join."
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <FormattedMessage {...common.cancel} />
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleShare()}>
              {makesPublic ? (
                <FormattedMessage id="shareToDiscoverDialog.confirmPublic" defaultMessage="Make Room Public and Share" />
              ) : (
                <FormattedMessage id="shareToDiscoverDialog.confirmShare" defaultMessage="Share Publicly" />
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
