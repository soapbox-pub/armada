import { Braces, Check, Copy, Globe, Link as LinkIcon, Loader2, Lock, Megaphone, TriangleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
import { ChromeDialogContent, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useControlFold } from "@/concord/hooks/useControlPlane";
import { useCommunityDiscoverListings, useUnlistAnnouncements } from "@/concord/hooks/useDiscoverListings";
import { useInviteActions, useMyLinkEpochs } from "@/concord/hooks/useInvites";
import type { DiscoveredInvite } from "@/concord/lib/inviteDiscovery";
import { parseInviteLink, type InviteListEntry } from "@/concord/lib/invite";
import type { Community } from "@/concord/lib/types";
import { DisplayName } from "@/components/DisplayName";
import { JsonBlock } from "@/components/JsonBlock";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { writeClipboardText } from "@/lib/clipboard";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { AvatarInitial } from "@/components/AvatarInitial";

/**
 * Invite-link admin panel (CORD-05): Public/Private status (registry, vsk 8),
 * Discover listings, my links (only the creator holds a link's secrets, so
 * only mine show URLs), and the community registry (who minted how many).
 */
export function InvitesView({ community }: { community: Community }) {
  const { data: folded } = useControlFold(community);
  const {
    myLinks,
    revokeLink,
    isRevoking,
    revokeAllMyLinks,
    isRevokingAll,
    revokeAllWouldPrivatize,
    isPublic,
    revokeWouldPrivatize,
  } = useInviteActions(community);
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { data: linkEpochs } = useMyLinkEpochs(community);
  const [copied, setCopied] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  // Live links always carry the CURRENT keys (re-posted on rekey, CORD-05 §2).
  const [inspecting, setInspecting] = useState<InviteListEntry | null>(null);
  const epoch = Number(community.rootEpoch);

  const myLinkSigners = useMemo(() => {
    const set = new Set<string>();
    for (const e of myLinks) {
      const parsed = parseInviteLink(e.url);
      if (parsed) set.add(parsed.linkSigner);
    }
    return set;
  }, [myLinks]);

  // My registry coordinates whose secret this account lacks (lost 13303); only "Revoke all" delists them.
  const orphanCount = useMemo(() => {
    const mine = user ? folded?.registriesByCreator.get(user.pubkey) ?? [] : [];
    return mine.filter((s) => !myLinkSigners.has(s)).length;
  }, [folded, user, myLinkSigners]);

  // creatorHex → live link count; the community-wide source of truth.
  const registry = useMemo(() => {
    const out: Array<{ creator: string; count: number; signers: string[] }> = [];
    if (folded) {
      for (const [creator, signers] of folded.registriesByCreator) {
        if (signers.length > 0) out.push({ creator, count: signers.length, signers });
      }
      out.sort((a, b) => b.count - a.count);
    }
    return out;
  }, [folded]);

  const handleCopy = async (url: string) => {
    try {
      await writeClipboardText(url);
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
    } catch {
      toast({ title: t({ id: "invitesView.copyFailed", defaultMessage: "Copy failed" }), variant: "destructive" });
    }
  };

  const handleRevoke = async (url: string) => {
    const privatizes = revokeWouldPrivatize(url);
    if (
      privatizes &&
      !confirm(
        t({
          id: "invitesView.confirmRevokeLast",
          defaultMessage:
            "This is the last live invite link. Revoking it makes the community private: new members can then only be added by direct invite, and banning a member will rotate the community keys.",
        }),
      )
    ) {
      return;
    }
    setRevoking(url);
    try {
      await revokeLink({ url });
      toast({
        title: t({ id: "invitesView.revokedTitle", defaultMessage: "Invite link revoked" }),
        description: privatizes
          ? t({
              id: "invitesView.revokedPrivate",
              defaultMessage: "It can no longer be used to join. This community is now private.",
            })
          : t({ id: "invitesView.revokedDescription", defaultMessage: "It can no longer be used to join." }),
      });
    } catch (e) {
      toast({
        title: t({ id: "invitesView.revokeFailed", defaultMessage: "Couldn't revoke the link" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setRevoking(null);
    }
  };

  const { listings, creatorOf, isLoading: listingsLoading } = useCommunityDiscoverListings(community, myLinkSigners);

  const handleRevokeAll = async () => {
    setRevokeAllOpen(false);
    try {
      const { revoked, delisted, failed } = await revokeAllMyLinks();
      const parts: string[] = [];
      if (revoked > 0) parts.push(t({ id: "invitesView.revokeAll.revoked", defaultMessage: "{count} revoked" }, { count: revoked }));
      if (delisted > revoked) {
        parts.push(
          t(
            { id: "invitesView.revokeAll.delisted", defaultMessage: "{count} delisted from the registry" },
            { count: delisted - revoked },
          ),
        );
      }
      if (failed > 0) {
        parts.push(
          t(
            {
              id: "invitesView.revokeAll.failed",
              defaultMessage: "{count, plural, one {# failed. Try revoking it individually} other {# failed. Try revoking them individually}}",
            },
            { count: failed },
          ),
        );
      }
      toast({
        title:
          failed > 0
            ? t({ id: "invitesView.revokeAll.someFailedTitle", defaultMessage: "Some invite links couldn't be revoked" })
            : t({ id: "invitesView.revokeAll.doneTitle", defaultMessage: "Invite links revoked" }),
        description: t({ id: "invitesView.revokeAll.summary", defaultMessage: "{parts}." }, { parts: parts.join(", ") }),
        variant: failed > 0 ? "destructive" : undefined,
      });
    } catch (e) {
      toast({
        title: t({ id: "invitesView.revokeAll.error", defaultMessage: "Couldn't revoke your links" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-3 py-4">
      <div className="flex items-center gap-2">
        <LinkIcon className="size-5 text-primary" />
        <h2 className="text-lg font-semibold">
          <FormattedMessage id="invitesView.title" defaultMessage="Invite links" />
        </h2>
      </div>

      <section
        className={`flex items-start gap-3 rounded-md px-3 py-3 text-sm ${
          isPublic ? "bg-primary/10" : "bg-foreground/5"
        }`}
      >
        {isPublic ? (
          <Globe className="mt-0.5 size-5 shrink-0 text-primary" />
        ) : (
          <Lock className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0">
          <p className="font-medium">
            {isPublic ? (
              <FormattedMessage id="invitesView.publicTitle" defaultMessage="This community is public" />
            ) : (
              <FormattedMessage id="invitesView.privateTitle" defaultMessage="This community is private" />
            )}
          </p>
          <p className="text-muted-foreground">
            {isPublic ? (
              <FormattedMessage
                id="invitesView.publicDescription"
                defaultMessage="One or more live invite links let anyone with the link join. Revoke every live link to make it private again."
              />
            ) : (
              <FormattedMessage
                id="invitesView.privateDescription"
                defaultMessage="There are no live public invite links. People join only by direct invite."
              />
            )}
          </p>
          {isPublic && listings.length > 0 && (
            <p className="mt-1 flex items-center gap-1.5 font-medium text-primary">
              <Megaphone className="size-3.5 shrink-0" />
              <FormattedMessage
                id="invitesView.listedOnDiscover"
                defaultMessage="Listed on Discover, so anyone browsing can find and join it."
              />
            </p>
          )}
        </div>
      </section>

      <DiscoverListingsSection
        listings={listings}
        loading={listingsLoading}
        creatorOf={creatorOf}
        myLinks={myLinks}
        myLinkSigners={myLinkSigners}
        revoking={revoking}
        onRevoke={handleRevoke}
      />

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <FormattedMessage id="invitesView.yourLiveLinks" defaultMessage="Your live links" />
        </h3>
        {myLinks.length === 0 && orphanCount === 0 && (
          <p className="text-sm text-muted-foreground">
            <FormattedMessage
              id="invitesView.noLinks"
              defaultMessage="You haven't created any invite links for this community."
            />
          </p>
        )}
        {myLinks.length > 0 && (
          <ul className="space-y-1.5">
            {myLinks.map((e) => {
              // Undefined while loading or unfetchable: treat as up to date.
              const servedEpoch = linkEpochs?.[e.token];
              const behind = servedEpoch !== undefined && servedEpoch < epoch;
              return (
              <li key={e.token} className="space-y-1 rounded-md bg-foreground/5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={e.url}
                    className="min-w-0 font-mono text-3xs"
                    onFocus={(ev) => ev.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="shrink-0"
                    aria-label={intl.formatMessage({ id: "invitesView.viewLinkDetails", defaultMessage: "View link details" })}
                    onClick={() => setInspecting(e)}
                  >
                    <Braces className="size-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="shrink-0"
                    aria-label={intl.formatMessage(common.copyLink)}
                    onClick={() => handleCopy(e.url)}
                  >
                    {copied === e.url ? (
                      <Check className="size-3.5 text-success" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-destructive hover:text-destructive"
                    disabled={isRevoking && revoking === e.url}
                    onClick={() => handleRevoke(e.url)}
                  >
                    {revoking === e.url ? <Loader2 className="size-3.5 animate-spin" /> : <FormattedMessage id="invitesView.revoke" defaultMessage="Revoke" />}
                  </Button>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-muted-foreground">
                  <span
                    className="tabular-nums"
                    title={intl.formatMessage({
                      id: "invitesView.epochTitle",
                      defaultMessage:
                        "The community epoch this link's keys belong to. It advances each time the community rekeys.",
                    })}
                  >
                    <FormattedMessage
                      id="invitesView.epoch"
                      defaultMessage="Epoch {epoch}"
                      values={{ epoch: servedEpoch ?? epoch }}
                    />
                  </span>
                  {e.label && (
                    <span>
                      <FormattedMessage id="invitesView.label" defaultMessage="Label: {label}" values={{ label: e.label }} />
                    </span>
                  )}
                  <span>
                    <FormattedMessage
                      id="invitesView.created"
                      defaultMessage="Created {date}"
                      values={{ date: new Date(e.created_at * 1000).toLocaleDateString(intl.locale) }}
                    />
                  </span>
                  {e.expires_at ? (
                    <span className={e.expires_at * 1000 < Date.now() ? "text-destructive" : undefined}>
                      {e.expires_at * 1000 < Date.now() ? (
                        <FormattedMessage
                          id="invitesView.expired"
                          defaultMessage="Expired {date}"
                          values={{ date: new Date(e.expires_at * 1000).toLocaleDateString(intl.locale) }}
                        />
                      ) : (
                        <FormattedMessage
                          id="invitesView.expires"
                          defaultMessage="Expires {date}"
                          values={{ date: new Date(e.expires_at * 1000).toLocaleDateString(intl.locale) }}
                        />
                      )}
                    </span>
                  ) : (
                    <span>
                      <FormattedMessage id="invitesView.neverExpires" defaultMessage="Never expires" />
                    </span>
                  )}
                </div>
                {behind && (
                  <div className="flex items-start gap-1.5 rounded bg-warning/10 px-2 py-1.5 text-2xs text-warning">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      <FormattedMessage
                        id="invitesView.behindEpoch"
                        defaultMessage="This link is on epoch {served}, but the community has since moved to epoch {current}. Someone joining now could land on the old keys. It refreshes automatically when you reopen this community from a device that holds it; if it lingers, revoke and mint a fresh link."
                        values={{ served: servedEpoch, current: epoch }}
                      />
                    </span>
                  </div>
                )}
              </li>
              );
            })}
          </ul>
        )}
        {orphanCount > 0 && (
          <div className="flex items-start gap-1.5 rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              <FormattedMessage
                id="invitesView.orphans"
                defaultMessage={`{count, plural, one {The community registry lists # more invite link of yours whose signing secret isn't on this account (created elsewhere, or the synced record was lost), so it can't be revoked one by one. "Revoke all" removes it from the registry.} other {The community registry lists # more invite links of yours whose signing secret aren't on this account (created elsewhere, or the synced record was lost), so they can't be revoked one by one. "Revoke all" removes them from the registry.}}`}
                values={{ count: orphanCount }}
              />
            </span>
          </div>
        )}
        {(myLinks.length > 0 || orphanCount > 0) && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={isRevokingAll}
            onClick={() => setRevokeAllOpen(true)}
          >
            {isRevokingAll ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />{" "}
                <FormattedMessage id="invitesView.revoking" defaultMessage="Revoking…" />
              </>
            ) : (
              <FormattedMessage
                id="invitesView.revokeAllButton"
                defaultMessage="Revoke all my invite links ({count})"
                values={{ count: myLinks.length + orphanCount }}
              />
            )}
          </Button>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <FormattedMessage id="invitesView.allLinks" defaultMessage="All invite links in this community" />
        </h3>
        <p className="text-xs text-muted-foreground">
          <FormattedMessage
            id="invitesView.allLinksDescription"
            defaultMessage="Every member who has live invite links, and how many. Only a link's creator can see its URL. This list shows who invited and how many links they hold."
          />
        </p>
        {registry.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            <FormattedMessage id="invitesView.noLiveLinks" defaultMessage="No live invite links." />
          </p>
        ) : (
          <ul className="space-y-1.5">
            {registry.map((r) => (
              <RegistryRow
                key={r.creator}
                creator={r.creator}
                count={r.count}
                community={community}
                mine={r.signers.some((s) => myLinkSigners.has(s))}
              />
            ))}
          </ul>
        )}
      </section>

      <LinkDetailsDialog
        entry={inspecting}
        servedEpoch={inspecting ? linkEpochs?.[inspecting.token] : undefined}
        currentEpoch={epoch}
        onClose={() => setInspecting(null)}
      />

      <AlertDialog open={revokeAllOpen} onOpenChange={setRevokeAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <FormattedMessage
                id="invitesView.revokeAllDialog.title"
                defaultMessage="Revoke all {count} of your invite links?"
                values={{ count: myLinks.length + orphanCount }}
              />
            </AlertDialogTitle>
            <AlertDialogDescription>
              <FormattedMessage
                id="invitesView.revokeAllDialog.description"
                defaultMessage="Links whose secrets this device holds stop working immediately."
              />
            </AlertDialogDescription>
            {orphanCount > 0 && (
              <AlertDialogDescription>
                <FormattedMessage
                  id="invitesView.revokeAllDialog.orphans"
                  defaultMessage="{count, plural, one {# of them has no signing secret on this account, so it can only be delisted: anyone who already has the URL may still join until the community next rotates its keys.} other {# of them have no signing secret on this account, so they can only be delisted: anyone who already has the URL may still join until the community next rotates its keys.}}"
                  values={{ count: orphanCount }}
                />
              </AlertDialogDescription>
            )}
            {revokeAllWouldPrivatize() && (
              <AlertDialogDescription>
                <FormattedMessage
                  id="invitesView.revokeAllDialog.privatizes"
                  defaultMessage="These are the last live invite links, so this makes the community private: new members can then only be added by direct invite, and banning a member will rotate the community keys."
                />
              </AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <FormattedMessage {...common.cancel} />
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleRevokeAll()}
            >
              <FormattedMessage id="invitesView.revokeAllDialog.confirm" defaultMessage="Revoke all" />
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Read-only link details with `token` and `signer_sk` REDACTED (they'd let anyone impersonate the link). */
function LinkDetailsDialog({
  entry,
  servedEpoch,
  currentEpoch,
  onClose,
}: {
  entry: InviteListEntry | null;
  servedEpoch: number | undefined;
  currentEpoch: number;
  onClose: () => void;
}) {
  const json = useMemo(() => {
    if (!entry) return "";
    const { token: _token, signer_sk: _sk, ...safe } = entry;
    return JSON.stringify(
      {
        ...safe,
        token: "<redacted>",
        signer_sk: "<redacted>",
        served_epoch: servedEpoch ?? currentEpoch,
        current_epoch: currentEpoch,
      },
      null,
      2,
    );
  }, [entry, servedEpoch, currentEpoch]);
  const intl = useIntl();

  return (
    <Dialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <ChromeDialogContent
        title={intl.formatMessage({ id: "invitesView.details.title", defaultMessage: "Invite link details" })}
        className="sm:max-w-2xl"
      >
        <ChromeDialogHeader
          icon={Braces}
          title={intl.formatMessage({ id: "invitesView.details.header", defaultMessage: "invite link details" })}
          description={intl.formatMessage({
            id: "invitesView.details.description",
            defaultMessage: "The stored record for this link. Secrets are redacted.",
          })}
        />
        <JsonBlock json={json} className="mt-5" />
      </ChromeDialogContent>
    </Dialog>
  );
}

function RegistryRow({
  creator,
  count,
  community,
  mine,
}: {
  creator: string;
  count: number;
  community: Community;
  mine: boolean;
}) {
  const author = useAuthor(creator);
  const name = useScopedDisplayName(creator, author.data?.metadata);
  const isOwner = creator === community.owner;
  return (
    <li className="flex items-center gap-2.5 rounded-md bg-foreground/5 px-3 py-2 text-sm">
      <Avatar className="size-6 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-3xs text-primary">
          <AvatarInitial name={name} />
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate font-medium">
        <DisplayName pubkey={creator} name={name} />
      </span>
      {isOwner && (
        <Badge variant="secondary" className="px-1.5 py-0 text-3xs">
          <FormattedMessage id="invitesView.owner" defaultMessage="Owner" />
        </Badge>
      )}
      {mine && (
        <Badge variant="outline" className="px-1.5 py-0 text-3xs">
          <FormattedMessage id="invitesView.you" defaultMessage="You" />
        </Badge>
      )}
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
        <FormattedMessage
          id="invitesView.liveLinkCount"
          defaultMessage="{count, plural, one {# live link} other {# live links}}"
          values={{ count }}
        />
      </span>
    </li>
  );
}

/**
 * Discover listings of this community's links. Deleting is the AUTHOR's
 * (NIP-09); revoking the link is the CREATOR's and takes down every listing of it.
 */
function DiscoverListingsSection({
  listings,
  loading,
  creatorOf,
  myLinks,
  myLinkSigners,
  revoking,
  onRevoke,
}: {
  listings: DiscoveredInvite[];
  loading: boolean;
  creatorOf: ReadonlyMap<string, string>;
  myLinks: InviteListEntry[];
  myLinkSigners: ReadonlySet<string>;
  revoking: string | null;
  onRevoke: (url: string) => void;
}) {
  const { user } = useCurrentUser();
  const { unlist } = useUnlistAnnouncements();
  const intl = useIntl();
  const [unlisting, setUnlisting] = useState<string | null>(null);

  // One row per (author, link); deleting must delete every copy.
  const rows = useMemo(() => {
    const byKey = new Map<string, DiscoveredInvite[]>();
    for (const listing of listings) {
      const key = `${listing.source.pubkey}:${listing.linkSigner}`;
      byKey.set(key, [...(byKey.get(key) ?? []), listing]);
    }
    return [...byKey.entries()].map(([key, copies]) => ({ key, copies, newest: copies[0] }));
  }, [listings]);

  const myUrlFor = (linkSigner: string) =>
    myLinks.find((e) => parseInviteLink(e.url)?.linkSigner === linkSigner)?.url;

  const handleUnlist = async (key: string, copies: DiscoveredInvite[]) => {
    setUnlisting(key);
    try {
      await unlist(copies);
      toast({ title: t({ id: "invitesView.unlisted", defaultMessage: "Removed from Discover" }) });
    } catch (e) {
      toast({
        title: t({ id: "invitesView.unlistFailed", defaultMessage: "Couldn't remove the listing" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setUnlisting(null);
    }
  };

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <FormattedMessage id="invitesView.discoverListings" defaultMessage="Discover listings" />
      </h3>
      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />{" "}
          <FormattedMessage id="invitesView.checkingDiscover" defaultMessage="Checking Discover…" />
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          <FormattedMessage id="invitesView.notListed" defaultMessage="This community isn't listed on Discover." />
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            <FormattedMessage
              id="invitesView.listingsDescription"
              defaultMessage="Public posts of this community's invite links. Anyone browsing Discover can use them to join."
            />
          </p>
          <ul className="space-y-1.5">
            {rows.map(({ key, copies, newest }) => {
              const mine = !!user && newest.source.pubkey === user.pubkey;
              const myUrl = myLinkSigners.has(newest.linkSigner) ? myUrlFor(newest.linkSigner) : undefined;
              return (
                <ListingRow
                  key={key}
                  author={newest.source.pubkey}
                  linkCreator={creatorOf.get(newest.linkSigner)}
                  postedAt={newest.source.created_at}
                  action={
                    mine ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="shrink-0 text-destructive hover:text-destructive"
                        disabled={unlisting === key}
                        onClick={() => void handleUnlist(key, copies)}
                      >
                        {unlisting === key ? <Loader2 className="size-3.5 animate-spin" /> : <FormattedMessage {...common.remove} />}
                      </Button>
                    ) : myUrl ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="shrink-0 text-destructive hover:text-destructive"
                        disabled={revoking === myUrl}
                        title={intl.formatMessage({
                          id: "invitesView.revokeListingTitle",
                          defaultMessage: "The listing carries your link: revoking it takes the listing down.",
                        })}
                        onClick={() => onRevoke(myUrl)}
                      >
                        {revoking === myUrl ? <Loader2 className="size-3.5 animate-spin" /> : (
                          <FormattedMessage id="invitesView.revokeLink" defaultMessage="Revoke link" />
                        )}
                      </Button>
                    ) : null
                  }
                />
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function ListingRow({
  author,
  linkCreator,
  postedAt,
  action,
}: {
  author: string;
  linkCreator: string | undefined;
  postedAt: number;
  action: ReactNode;
}) {
  const profile = useAuthor(author);
  const name = useScopedDisplayName(author, profile.data?.metadata);
  const creatorProfile = useAuthor(linkCreator && linkCreator !== author ? linkCreator : undefined);
  const creatorName = useScopedDisplayName(linkCreator, creatorProfile.data?.metadata);
  const intl = useIntl();
  return (
    <li className="flex items-center gap-2.5 rounded-md bg-foreground/5 px-3 py-2 text-sm">
      <Avatar className="size-6 shrink-0">
        <AvatarImage src={profile.data?.metadata?.picture} imeta={profile.data?.imeta?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-3xs text-primary">
          <AvatarInitial name={name} />
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          <DisplayName pubkey={author} name={name} />
        </p>
        <p className="truncate text-2xs text-muted-foreground">
          {linkCreator && linkCreator !== author ? (
            <FormattedMessage
              id="invitesView.postedLinkBy"
              defaultMessage="Posted {date} · link by {creator}"
              values={{
                date: new Date(postedAt * 1000).toLocaleDateString(intl.locale),
                creator: <DisplayName pubkey={linkCreator} name={creatorName} />,
              }}
            />
          ) : (
            <FormattedMessage
              id="invitesView.posted"
              defaultMessage="Posted {date}"
              values={{ date: new Date(postedAt * 1000).toLocaleDateString(intl.locale) }}
            />
          )}
        </p>
      </div>
      {action}
    </li>
  );
}
