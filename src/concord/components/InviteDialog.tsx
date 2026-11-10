import { Check, ChevronRight, Copy, Info, Link as LinkIcon, Loader2, Share2, UserPlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ArmadaCrest, ArmadaCrestKeyframes } from "@/components/brand/ArmadaCrest";
import { ProfileSearchSelect } from "@/components/chat/ProfileSearchSelect";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useInviteActions } from "@/concord/hooks/useInvites";
import { useIsMobile } from "@/hooks/useIsMobile";
import { PortalContainerProvider } from "@/hooks/usePortalContainer";
import { toast } from "@/hooks/useToast";
import type { SearchProfile } from "@/hooks/useSearchProfiles";
import { writeClipboardText } from "@/lib/clipboard";
import { canShare, share } from "@/lib/share";
import { cn } from "@/lib/utils";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import type { Community } from "@/concord/lib/types";
import { nowSecs } from "@/lib/relayClock";

/**
 * Invite people (CORD-05): a direct gift-wrapped key handoff (community stays
 * Private), or a public link whose `#fragment` unlock token never reaches a
 * server. Bottom sheet on phones, modal on pointer devices.
 */
export function InviteDialog({
  community,
  open,
  onOpenChange,
  canCreateLink,
}: {
  community: Community | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owner/admin only; members can still invite directly. */
  canCreateLink: boolean;
}) {
  const intl = useIntl();
  const isMobile = useIsMobile();
  const title = intl.formatMessage({ id: "inviteDialog.title", defaultMessage: "Invite people" });
  // Radix RemoveScroll only allows scrolling in the content node, so popovers
  // portal into it (also lets vaul treat the list as scrollable).
  const [portalNode, setPortalNode] = useState<HTMLDivElement | null>(null);

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent
          ref={setPortalNode}
          className="mt-0 h-[100dvh] max-h-[100dvh] rounded-none bg-chrome pt-[env(safe-area-inset-top)]"
        >
          <DrawerTitle className="sr-only">{title}</DrawerTitle>
          {/* A full-screen sheet has no visible edge to swipe, so offer a close button. */}
          <DrawerClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={intl.formatMessage(common.close)}
              className="absolute right-2 top-[calc(env(safe-area-inset-top)+0.5rem)] z-10 size-9 touch:size-11"
            >
              <X className="size-5" />
            </Button>
          </DrawerClose>
          {/* The popover is fixed against the transformed sheet; an overflow box between would clip it. */}
          <div className="chrome-dialog flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-6">
            <PortalContainerProvider value={portalNode ?? undefined}>
              <InviteBody community={community} canCreateLink={canCreateLink} />
            </PortalContainerProvider>
          </div>
          <ArmadaCrestKeyframes />
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent ref={setPortalNode} title={title}>
        <PortalContainerProvider value={portalNode ?? undefined}>
          <InviteBody community={community} canCreateLink={canCreateLink} />
        </PortalContainerProvider>
        <ArmadaCrestKeyframes />
      </ChromeDialogContent>
    </Dialog>
  );
}

function InviteBody({ community, canCreateLink }: { community: Community | undefined; canCreateLink: boolean }) {
  const intl = useIntl();
  const { createLink, revokeLink, myLinks, sendDirectInvite, isSendingInvite, isPublic, revokeWouldPrivatize } =
    useInviteActions(community);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [expiryDays, setExpiryDays] = useState<number>(0); // 0 = never
  const [label, setLabel] = useState("");
  const [listPublicly, setListPublicly] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [sentPubkey, setSentPubkey] = useState<string | null>(null);
  const [pendingPubkey, setPendingPubkey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A send can settle long after the sheet closed (a remote signer awaiting
  // approval), when a success toast names someone out of nowhere.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const handleSelect = async (profile: SearchProfile) => {
    setError(null);
    setPendingPubkey(profile.pubkey);
    const name = profile.metadata.name || profile.metadata.display_name;
    try {
      await sendDirectInvite({ recipientPubkey: profile.pubkey });
      if (!mounted.current) return;
      setSentPubkey(profile.pubkey);
      toast({
        title: t({ id: "inviteDialog.inviteSent", defaultMessage: "Invite sent" }),
        description: name
          ? t({ id: "inviteDialog.willBeAsked", defaultMessage: "{name} will be asked to accept." }, { name })
          : t({ id: "inviteDialog.theyWillBeAsked", defaultMessage: "They will be asked to accept." }),
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : t({ id: "inviteDialog.sendFailed", defaultMessage: "Couldn't send the invite." });
      // A failure stays worth hearing about after close; nowhere else reports it.
      if (!mounted.current) {
        toast({
          title: name
            ? t({ id: "inviteDialog.inviteFailedNamed", defaultMessage: "Couldn't invite {name}" }, { name })
            : t({ id: "inviteDialog.inviteFailed", defaultMessage: "Couldn't invite them" }),
          description: message,
          variant: "destructive",
        });
        return;
      }
      setError(message);
    } finally {
      if (mounted.current) setPendingPubkey(null);
    }
  };

  /** Newest joinable link, reused so each tap doesn't mint another door to revoke. */
  const liveLink = (() => {
    const now = nowSecs();
    return (
      [...myLinks]
        .filter((e) => !e.expires_at || e.expires_at > now)
        .sort((a, b) => b.created_at - a.created_at)[0]?.url ?? null
    );
  })();

  const mintLink = async (): Promise<string> => {
    // The first live link flips the community Public (CORD-05 §5).
    if (
      !isPublic &&
      !confirm(
        t({
          id: "inviteDialog.confirmPublic",
          defaultMessage: "Creating an invite link makes this community public: anyone with the link can join. Revoking every link makes it private again.",
        }),
      )
    ) {
      throw new Error("Cancelled");
    }
    // Announcing publishes the secret link publicly, so confirm.
    if (
      listPublicly &&
      !confirm(
        t({
          id: "inviteDialog.confirmDiscover",
          defaultMessage: "Sharing to Discover posts this invite link, secret included, as a public note from your account. Anyone can find it and join. Only do this for a community you want strangers to join.",
        }),
      )
    ) {
      throw new Error("Cancelled");
    }
    return createLink({
      expiresAtMs: expiryDays > 0 ? Date.now() + expiryDays * 86400_000 : undefined,
      label: label.trim() || undefined,
      listPublicly: listPublicly || undefined,
    });
  };

  /**
   * Share a live link, minting only if none exists. Reuse skips the await that
   * would otherwise consume the user activation `navigator.share` needs.
   */
  const handleInvite = async (forceNew = false) => {
    setError(null);
    setSharing(true);
    try {
      const url = forceNew || !liveLink ? await mintLink() : liveLink;
      const shared = await share({
        title: community?.name
          ? t({ id: "inviteDialog.shareTitle", defaultMessage: "Join {name}" }, { name: community.name })
          : t({ id: "inviteDialog.shareTitleGeneric", defaultMessage: "Join my community" }),
        url,
        dialogTitle: t({ id: "inviteDialog.shareDialogTitle", defaultMessage: "Share invite link" }),
      });
      if (!shared) {
        await handleCopy(url);
        toast({
          title: t({ id: "inviteDialog.linkCopied", defaultMessage: "Invite link copied" }),
          description: t({ id: "inviteDialog.linkCopiedDescription", defaultMessage: "It's on your clipboard, ready to paste." }),
        });
      }
    } catch (e) {
      if (e instanceof Error && e.message === "Cancelled") return;
      setError(e instanceof Error ? e.message : t({ id: "inviteDialog.createFailed", defaultMessage: "Couldn't create the link." }));
    } finally {
      setSharing(false);
    }
  };

  const handleRevoke = async (url: string) => {
    setError(null);
    const privatizes = revokeWouldPrivatize(url);
    if (
      privatizes &&
      !confirm(
        t({
          id: "inviteDialog.confirmRevokeLast",
          defaultMessage: "This is the last live invite link. Revoking it makes the community private: new members can then only be added by direct invite, and banning a member will rotate the community keys.",
        }),
      )
    ) {
      return;
    }
    setRevoking(url);
    try {
      await revokeLink({ url });
      toast({
        title: t({ id: "inviteDialog.linkRevoked", defaultMessage: "Invite link revoked" }),
        description: privatizes
          ? t({ id: "inviteDialog.linkRevokedPrivate", defaultMessage: "It can no longer be used to join. This community is now private." })
          : t({ id: "inviteDialog.linkRevokedDescription", defaultMessage: "It can no longer be used to join." }),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "inviteDialog.revokeFailed", defaultMessage: "Couldn't revoke the link." }));
    } finally {
      setRevoking(null);
    }
  };

  const handleCopy = async (url: string) => {
    try {
      await writeClipboardText(url);
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
    } catch {
      toast({ title: t({ id: "inviteDialog.copyFailed", defaultMessage: "Copy failed" }), variant: "destructive" });
    }
  };

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <ArmadaCrest size={72} />
        <div className="space-y-1">
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="inviteDialog.heading" defaultMessage="invite people" />
          </h2>
          <p className="text-sm text-muted-foreground">
            {community?.name ? (
              <FormattedMessage
                id="inviteDialog.bringInto"
                defaultMessage="Bring people into <name>{community}</name>."
                values={{ community: community.name, name: (chunks) => <span className="text-foreground">{chunks}</span> }}
              />
            ) : (
              <FormattedMessage id="inviteDialog.bringIntoGeneric" defaultMessage="Bring people into your community." />
            )}
          </p>
        </div>
      </div>

      {/* Not autofocused: on a phone the keyboard would cover the sheet. */}
      <div className="w-full space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <UserPlus className="size-3.5" />
          <FormattedMessage id="inviteDialog.inviteDirectly" defaultMessage="Invite someone directly" />
        </div>
        <ProfileSearchSelect onSelect={handleSelect} busyPubkey={pendingPubkey} />
        {sentPubkey && !isSendingInvite && (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <Check className="size-3.5" />{" "}
            <FormattedMessage id="inviteDialog.sentInline" defaultMessage="Invite sent. Search again to invite more." />
          </p>
        )}
      </div>

      {canCreateLink && (
      <div className="w-full space-y-2 border-t border-chrome pt-5">
        <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <LinkIcon className="size-3.5" />
          <FormattedMessage id="inviteDialog.orShareLink" defaultMessage="Or share a link" />
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className="ml-auto text-muted-foreground/70 hover:text-foreground" aria-label={intl.formatMessage({ id: "inviteDialog.aboutLinks", defaultMessage: "About invite links" })}>
                <Info className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" className="w-64 p-3 text-xs normal-case tracking-normal font-normal text-muted-foreground">
              <FormattedMessage
                id="inviteDialog.aboutLinksBody"
                defaultMessage="Anyone with the link can join. The secret lives in the # fragment, never sent to a server. Revoking a link doesn't require changing anyone's keys."
              />
            </PopoverContent>
          </Popover>
        </div>
        {/* Stays a button after minting so the next invite uses the same gesture. */}
        <Button
          type="button"
          variant="secondary"
          onClick={() => void handleInvite()}
          disabled={sharing || !community}
          className="w-full clip-corner-lg"
        >
          {sharing ? (
            <Loader2 className="size-4 mr-2 animate-spin" />
          ) : canShare() ? (
            <Share2 className="size-4 mr-2" />
          ) : (
            <Copy className="size-4 mr-2" />
          )}
          <FormattedMessage id="inviteDialog.invite" defaultMessage="Invite" />
        </Button>
        <Collapsible open={optionsOpen} onOpenChange={setOptionsOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRight className={cn("size-3.5 transition-transform", optionsOpen && "rotate-90")} />
            <FormattedMessage id="inviteDialog.linkOptions" defaultMessage="Link options" />
            {!optionsOpen && (expiryDays > 0 || label.trim()) && (
              <span className="text-foreground/70">
                {" · "}
                {expiryDays > 0 && label.trim()
                  ? intl.formatMessage(
                    { id: "inviteDialog.optionsSummaryBoth", defaultMessage: "{days, plural, one {expires in # day} other {expires in # days}}, \"{label}\"" },
                    { days: expiryDays, label: label.trim() },
                  )
                  : expiryDays > 0
                    ? intl.formatMessage(
                      { id: "inviteDialog.optionsSummaryExpiry", defaultMessage: "{days, plural, one {expires in # day} other {expires in # days}}" },
                      { days: expiryDays },
                    )
                    : `"${label.trim()}"`}
              </span>
            )}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <div className="flex gap-2">
              <Select value={String(expiryDays)} onValueChange={(v) => setExpiryDays(Number(v))}>
                <SelectTrigger className="w-40 shrink-0" aria-label={intl.formatMessage({ id: "inviteDialog.expiry", defaultMessage: "Link expiry" })}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">
                    <FormattedMessage id="inviteDialog.neverExpires" defaultMessage="Never expires" />
                  </SelectItem>
                  {[1, 7, 30].map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      <FormattedMessage
                        id="inviteDialog.expiresIn"
                        defaultMessage="{days, plural, one {Expires in # day} other {Expires in # days}}"
                        values={{ days }}
                      />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={intl.formatMessage({ id: "inviteDialog.labelPlaceholder", defaultMessage: "Label (optional)" })}
                className="min-w-0 text-sm"
                aria-label={intl.formatMessage({ id: "inviteDialog.labelAria", defaultMessage: "Invite label" })}
              />
            </div>

            <div className="mt-3 clip-hairline-lg [--edge:var(--chrome-divider)] [--fill:var(--chrome)] [--fill-hover:var(--chrome)] p-3 space-y-2.5">
              <Label
                htmlFor="list-publicly"
                className="flex items-start justify-between gap-3 cursor-pointer"
              >
                <span className="space-y-0.5">
                  <span className="block text-sm font-medium normal-case tracking-normal">
                    <FormattedMessage id="inviteDialog.shareToDiscover" defaultMessage="Share to Discover" />
                  </span>
                  <span className="block text-xs font-normal normal-case tracking-normal text-muted-foreground">
                    <FormattedMessage
                      id="inviteDialog.shareToDiscoverHint"
                      defaultMessage="List the community publicly on the Discover page so anyone can find and join it. The link's secret becomes public."
                    />
                  </span>
                </span>
                <Switch id="list-publicly" checked={listPublicly} onCheckedChange={setListPublicly} />
              </Label>
            </div>

            {/* These options only apply to a new link, so they get their own action. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-3 w-full text-muted-foreground"
              onClick={() => void handleInvite(true)}
              disabled={sharing || !community}
            >
              <FormattedMessage id="inviteDialog.createWithOptions" defaultMessage="Create a new link with these options" />
            </Button>
          </CollapsibleContent>
        </Collapsible>
      </div>
      )}

      {canCreateLink && myLinks.length > 0 && (
        <div className="w-full space-y-1.5 border-t border-chrome pt-4">
          <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <FormattedMessage id="inviteDialog.liveLinks" defaultMessage="Your live links" />
          </div>
          {myLinks.map((e) => (
            <div key={e.token} className="flex items-center gap-2">
              <Input readOnly value={e.url} className="min-w-0 font-mono text-3xs" onFocus={(ev) => ev.currentTarget.select()} />
              <Button type="button" size="icon" variant="outline" className="shrink-0" aria-label={intl.formatMessage(common.copyLink)} onClick={() => handleCopy(e.url)}>
                {copied === e.url ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="shrink-0 text-destructive hover:text-destructive"
                disabled={revoking === e.url}
                onClick={() => handleRevoke(e.url)}
              >
                {revoking === e.url ? <Loader2 className="size-3.5 animate-spin" /> : <FormattedMessage id="inviteDialog.revoke" defaultMessage="Revoke" />}
              </Button>
            </div>
          ))}
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
