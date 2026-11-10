import { useQueryClient } from "@tanstack/react-query";
import { useQueries } from "@tanstack/react-query";
import { Ban, Crown, KeyRound, Loader2, Shield, ShieldAlert, ShieldOff, TriangleAlert, UserMinus, Users } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { SearchField } from "@/components/ui/search-field";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BanMemberDialog } from "@/concord/components/BanMemberDialog";
import { KickMembersDialog } from "@/concord/components/KickMembersDialog";
import { useChannels, useControlFold } from "@/concord/hooks/useControlPlane";
import { useCommunityRumors } from "@/concord/hooks/useCommunityRumors";
import { useMembers } from "@/concord/hooks/useGuestbook";
import { useInviteActions } from "@/concord/hooks/useInvites";
import { useModeration } from "@/concord/hooks/useModeration";
import { useRoles } from "@/concord/hooks/useRoles";
import { useSuspiciousActivity } from "@/concord/hooks/useSuspiciousActivity";
import { describeAttempts, type SuspiciousActor } from "@/concord/lib/auditLog";
import { KIND_COMMENT, KIND_MESSAGE } from "@/concord/lib/kinds";
import { banShouldRotateMany } from "@/concord/lib/control";
import {
  buildMemberRows,
  filterMemberRows,
  hoistSuspicious,
  type MemberDirectoryRow,
  type MemberSortKey,
  sortMemberRows,
} from "@/concord/lib/memberDirectory";
import { clickRow, emptySelection, pruneSelection, type SelectionState } from "@/concord/lib/rosterSelection";
import { badgeOf, stockTierOf, tierMoves, type StockTier } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { authorQueryOptions, useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useMutedPubkeys } from "@/hooks/useMuteList";
import { profileMatches, type SearchProfile } from "@/hooks/useSearchProfiles";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { shortTimeAgoPhrase } from "@/lib/formatTime";
import { toast } from "@/hooks/useToast";
import { useEventStore } from "@/hooks/useEventStore";
import { defineMessages, FormattedMessage, t, useIntl } from "@/i18n";
import { AvatarInitial } from "@/components/AvatarInitial";

/** Render cap before "Show all" (slicing, not virtualization). */
const RENDER_CAP = 150;

/**
 * Full community roster with mass moderation. Epoch health: a member last seen
 * under an older epoch missed a rotation; "Send keys" re-sends via Direct Invite.
 */
export function MembersView({
  community,
  memberPubkeys,
  canModerate,
  canManageRoles,
}: {
  community: Community;
  /** The keep-list a rotating mass ban preserves. */
  memberPubkeys: string[];
  /** May kick or ban. */
  canModerate: boolean;
  canManageRoles: boolean;
}) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const { mutedPubkeys } = useMutedPubkeys();
  const queryClient = useQueryClient();
  const eventStore = useEventStore();
  const channels = useChannels(community);
  const channelIds = useMemo(() => channels.map((c) => c.idHex), [channels]);
  const { byChannel } = useCommunityRumors(community.idHex, channelIds);
  const { data: folded } = useControlFold(community);
  const moderation = useModeration(community, memberPubkeys);
  const { sendDirectInvite } = useInviteActions(community);
  const { setTier, isSettingTier } = useRoles(community);
  const selectable = canModerate || canManageRoles;
  const { actors: suspiciousActors } = useSuspiciousActivity(community, folded);
  const suspiciousOf = useMemo(() => {
    const map = new Map<string, SuspiciousActor>();
    for (const a of suspiciousActors) if (!a.banned) map.set(a.author, a);
    return map;
  }, [suspiciousActors]);
  const suspiciousSet = useMemo(() => new Set(suspiciousOf.keys()), [suspiciousOf]);

  const observed = useMemo(() => {
    const epochOf = new Map<string, bigint>();
    const seenMs = new Map<string, number>();
    for (const list of byChannel.values()) {
      for (const m of list) {
        if (m.kind !== KIND_MESSAGE && m.kind !== KIND_COMMENT) continue;
        const prevE = epochOf.get(m.author);
        if (prevE === undefined || m.epoch > prevE) epochOf.set(m.author, m.epoch);
        const prevMs = seenMs.get(m.author) ?? 0;
        if (m.ms > prevMs) seenMs.set(m.author, m.ms);
      }
    }
    return { epochOf, seenMs };
  }, [byChannel]);

  const { members, coalesced } = useMembers(community, observed.seenMs);

  // Muted people are hidden here too (unmute to act on them), since this view is open to all members.
  const allRows = useMemo(
    () =>
      buildMemberRows({
        members,
        coalesced,
        observedEpochOf: observed.epochOf,
        observedSeenMs: observed.seenMs,
        roster: folded?.roster,
        currentEpoch: community.rootEpoch,
        ownerHex: folded?.ownerHex ?? community.owner,
        selfHex: user?.pubkey,
        suspicious: suspiciousSet,
      }).filter((row) => !mutedPubkeys.has(row.pubkey)),
    [members, coalesced, observed, folded, community, user, suspiciousSet, mutedPubkeys],
  );

  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<MemberSortKey>("role");
  const [roleFilter, setRoleFilter] = useState<string>("all"); // "all" | "none" | roleId
  const [behindOnly, setBehindOnly] = useState(false);
  const [suspiciousOnly, setSuspiciousOnly] = useState(false);
  const [inviterFilter, setInviterFilter] = useState<string>("all"); // "all" | "any" | creator hex
  const [showAll, setShowAll] = useState(false);

  // Batch-resolve so search sees every member, not just rendered rows.
  const pubkeys = useMemo(() => allRows.map((r) => r.pubkey), [allRows]);
  const profileResults = useQueries({
    queries: pubkeys.map((pk) => authorQueryOptions(queryClient, eventStore, pk)),
  });
  // Stable key so the map changes only when a resolved profile does.
  const profileKey = pubkeys
    .map((pk, i) => `${pk}:${profileResults[i]?.data?.metadata?.name ?? ""}:${profileResults[i]?.data?.metadata?.display_name ?? ""}:${profileResults[i]?.data?.metadata?.nip05 ?? ""}`)
    .join("|");
  const profileOf = useMemo(() => {
    const map = new Map<string, SearchProfile>();
    pubkeys.forEach((pk, i) => {
      const data = profileResults[i]?.data;
      if (data?.metadata && data.event) map.set(pk, { pubkey: pk, metadata: data.metadata, event: data.event });
    });
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileKey]);

  const rows = useMemo(() => {
    const filtered = filterMemberRows(allRows, {
      query,
      nameMatch: (pk, q) => {
        const p = profileOf.get(pk);
        return p ? profileMatches(p, q) : false;
      },
      roleIds: roleFilter !== "all" && roleFilter !== "none" ? [roleFilter] : undefined,
      noRole: roleFilter === "none",
      behindOnly,
      suspiciousOnly,
      viaInvite: inviterFilter === "any",
      inviter: inviterFilter !== "all" && inviterFilter !== "any" ? inviterFilter : undefined,
    });
    const collator = new Intl.Collator(intl.locale, { sensitivity: "base", numeric: true });
    const nameOf = (pk: string) => {
      const m = profileOf.get(pk)?.metadata;
      const name = m?.display_name || m?.name;
      return typeof name === "string" && name.trim() ? name.trim() : undefined;
    };
    // Nameless members last.
    const byName = (a: string, b: string) => {
      const na = nameOf(a);
      const nb = nameOf(b);
      if (na && nb) return collator.compare(na, nb) || (a < b ? -1 : 1);
      if (na || nb) return na ? -1 : 1;
      return a < b ? -1 : 1;
    };
    return hoistSuspicious(sortMemberRows(filtered, sortKey, byName));
  }, [allRows, query, roleFilter, behindOnly, suspiciousOnly, inviterFilter, sortKey, profileOf, intl.locale]);

  const visible = showAll ? rows : rows.slice(0, RENDER_CAP);
  const visibleOrder = useMemo(() => visible.map((r) => r.pubkey), [visible]);

  const [selection, setSelection] = useState<SelectionState>(emptySelection());

  // Hidden-but-selected members must not ride into a mass action, so reset.
  const filterSig = `${query}|${roleFilter}|${behindOnly}|${suspiciousOnly}|${inviterFilter}`;
  const prevFilterSig = useRef(filterSig);
  useEffect(() => {
    if (prevFilterSig.current !== filterSig) {
      prevFilterSig.current = filterSig;
      setSelection(emptySelection());
    }
  }, [filterSig]);
  const visibleSet = useMemo(() => new Set(visibleOrder), [visibleOrder]);
  useEffect(() => {
    setSelection((s) => pruneSelection(s, visibleSet));
  }, [visibleSet]);

  const selected = useMemo(
    () => visible.filter((r) => selection.selected.has(r.pubkey)).map((r) => r.pubkey),
    [visible, selection],
  );
  const kickable = selected.filter((pk) => moderation.canKick(pk));
  const bannable = selected.filter((pk) => moderation.canBan(pk));
  // One member at a time: a tier move may first mint the stock role, which the
  // next member's move would mint again before the fold caught up.
  const tierTarget = canManageRoles && selected.length === 1 ? selected[0] : undefined;
  const tierOptions = tierTarget && folded && user
    ? tierMoves(folded.roster, user.pubkey, folded.ownerHex ?? community.owner, tierTarget)
    : [];
  const tierCurrent = tierTarget && folded ? stockTierOf(folded.roster, tierTarget) : undefined;
  const runSetTier = async (member: string, tier: StockTier | null) => {
    try {
      await setTier({ member, tier });
      toast({
        title:
          tier === "admin"
            ? t({ id: "membersView.madeAdmin", defaultMessage: "Made admin" })
            : tier === "moderator"
              ? t({ id: "membersView.madeModerator", defaultMessage: "Made moderator" })
              : t({ id: "membersView.roleRemoved", defaultMessage: "Role removed" }),
      });
      setSelection(emptySelection());
    } catch (e) {
      toast({ title: t({ id: "membersView.roleFailed", defaultMessage: "Couldn't change role" }), description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };
  const healTargets = useMemo(() => {
    const behind = new Set(visible.filter((r) => r.behind).map((r) => r.pubkey));
    return selected.filter((pk) => behind.has(pk) && pk !== user?.pubkey);
  }, [visible, selected, user]);

  const allVisibleSelected = visible.length > 0 && visible.every((r) => selection.selected.has(r.pubkey));
  const someVisibleSelected = visible.some((r) => selection.selected.has(r.pubkey));
  const toggleAllVisible = () => {
    setSelection((s) => {
      const next = new Set(s.selected);
      if (allVisibleSelected) for (const pk of visibleOrder) next.delete(pk);
      else for (const pk of visibleOrder) next.add(pk);
      return { selected: next, anchor: s.anchor };
    });
  };

  const [kickTargets, setKickTargets] = useState<string[] | null>(null);
  const [banTargets, setBanTargets] = useState<string[] | null>(null);
  const [healing, setHealing] = useState<{ done: number; total: number } | null>(null);

  const banWillRotate =
    banTargets !== null &&
    !!folded &&
    !!user &&
    banShouldRotateMany(folded, user.pubkey, banTargets) &&
    moderation.canRekey;

  const runMassHeal = async () => {
    if (healTargets.length === 0 || healing) return;
    setHealing({ done: 0, total: healTargets.length });
    let sent = 0;
    const failed: string[] = [];
    // Sequential: remote signers wedge under parallel load.
    for (const [i, pk] of healTargets.entries()) {
      try {
        await sendDirectInvite({ recipientPubkey: pk });
        sent += 1;
      } catch {
        failed.push(pk);
      }
      setHealing({ done: i + 1, total: healTargets.length });
    }
    setHealing(null);
    setSelection(emptySelection());
    toast({
      title: t(
        {
          id: "membersView.keysSent",
          defaultMessage: "{count, plural, one {Sent current keys to # member} other {Sent current keys to # members}}",
        },
        { count: sent },
      ),
      description:
        failed.length > 0
          ? t(
              { id: "membersView.keysFailed", defaultMessage: "{count} failed. Try them again shortly." },
              { count: failed.length },
            )
          : undefined,
      variant: failed.length > 0 ? "destructive" : undefined,
    });
  };

  const inviters = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) if (r.invite) set.add(r.invite.creator);
    return [...set].sort();
  }, [allRows]);
  const behindCount = allRows.filter((r) => r.behind).length;
  const roles = useMemo(
    () => [...(folded?.roster.roles ?? [])].sort((a, b) => a.position - b.position),
    [folded],
  );

  // Measure the pane itself (viewport breakpoints lie inside panes).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [density, setDensity] = useState<"full" | "compact" | "minimal">("full");
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      setDensity(w < 280 ? "minimal" : w < 470 ? "compact" : "full");
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={containerRef} className="mx-auto w-full max-w-3xl space-y-4 p-4 pb-24">
      <div className="flex items-center gap-2">
        <Users className="size-5 text-primary" />
        <h2 className="text-lg font-semibold">
          <FormattedMessage id="membersView.title" defaultMessage="Members" />
        </h2>
        <span className="text-sm text-muted-foreground">{allRows.length}</span>
      </div>

      {suspiciousSet.size > 0 && (
        <button
          type="button"
          onClick={() => setSuspiciousOnly((v) => !v)}
          className={`flex w-full items-center gap-2 clip-corner-lg px-3 py-2 text-left text-sm transition-colors ${
            suspiciousOnly ? "bg-destructive/25 text-destructive" : "bg-destructive/10 text-destructive"
          }`}
        >
          <ShieldAlert className="size-4 shrink-0" />
          <FormattedMessage
            id="membersView.suspiciousBanner"
            defaultMessage="{count, plural, one {# member has tried to make changes they aren't allowed to. Nothing worked, but they're worth a look.} other {# members have tried to make changes they aren't allowed to. Nothing worked, but they're worth a look.}}"
            values={{ count: suspiciousSet.size }}
          />
          <span className="ml-auto shrink-0 text-xs underline">
            {suspiciousOnly ? (
              <FormattedMessage id="membersView.showAll" defaultMessage="Show all" />
            ) : (
              <FormattedMessage id="membersView.showThem" defaultMessage="Show them" />
            )}
          </span>
        </button>
      )}

      {behindCount > 0 && (
        <button
          type="button"
          onClick={() => setBehindOnly((v) => !v)}
          className={`flex w-full items-center gap-2 clip-corner-lg px-3 py-2 text-left text-sm transition-colors ${
            behindOnly ? "bg-warning/20 text-warning" : "bg-warning/10 text-warning"
          }`}
        >
          <TriangleAlert className="size-4 shrink-0" />
          <FormattedMessage
            id="membersView.behindBanner"
            defaultMessage="{count, plural, one {# member was last seen on an older epoch and never adopted a key rotation.} other {# members were last seen on an older epoch and never adopted a key rotation.}}"
            values={{ count: behindCount }}
          />
          <span className="ml-auto shrink-0 text-xs underline">
            {behindOnly ? (
              <FormattedMessage id="membersView.showAll" defaultMessage="Show all" />
            ) : (
              <FormattedMessage id="membersView.showThem" defaultMessage="Show them" />
            )}
          </span>
        </button>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <SearchField value={query} onChange={setQuery} placeholder={intl.formatMessage({ id: "membersView.searchPlaceholder", defaultMessage: "Search members" })} className="min-w-40 flex-1" />
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-36 shrink-0">
            <SelectValue placeholder={intl.formatMessage({ id: "membersView.rolePlaceholder", defaultMessage: "Role" })} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              <FormattedMessage id="membersView.everyRole" defaultMessage="Every role" />
            </SelectItem>
            {roles.map((r) => (
              <SelectItem key={r.roleId} value={r.roleId}>
                {r.name}
              </SelectItem>
            ))}
            <SelectItem value="none">
              <FormattedMessage id="membersView.noRole" defaultMessage="No role" />
            </SelectItem>
          </SelectContent>
        </Select>
        {inviters.length > 0 && (
          <Select value={inviterFilter} onValueChange={setInviterFilter}>
            <SelectTrigger className="w-40 shrink-0">
              <SelectValue
                placeholder={intl.formatMessage({ id: "membersView.invitedByPlaceholder", defaultMessage: "Invited by" })}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                <FormattedMessage id="membersView.anyArrival" defaultMessage="Any arrival" />
              </SelectItem>
              <SelectItem value="any">
                <FormattedMessage id="membersView.invitedAnyLink" defaultMessage="Invited (any link)" />
              </SelectItem>
              {inviters.map((pk) => (
                <SelectItem key={pk} value={pk}>
                  <FormattedMessage
                    id="membersView.byInviter"
                    defaultMessage="by {name}"
                    values={{ name: <InviterName pubkey={pk} /> }}
                  />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={sortKey} onValueChange={(v) => setSortKey(v as MemberSortKey)}>
          <SelectTrigger className="w-40 shrink-0">
            <SelectValue placeholder={intl.formatMessage({ id: "membersView.sortPlaceholder", defaultMessage: "Sort" })} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="role">
              <FormattedMessage id="membersView.sortRole" defaultMessage="By role" />
            </SelectItem>
            <SelectItem value="name">
              <FormattedMessage id="membersView.sortName" defaultMessage="By name" />
            </SelectItem>
            <SelectItem value="seen">
              <FormattedMessage id="membersView.sortSeen" defaultMessage="Recently seen" />
            </SelectItem>
            <SelectItem value="joined-newest">
              <FormattedMessage id="membersView.sortNewest" defaultMessage="Newest members" />
            </SelectItem>
            <SelectItem value="joined-oldest">
              <FormattedMessage id="membersView.sortOldest" defaultMessage="Oldest members" />
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {selectable && visible.length > 0 && (
        <label className="flex w-fit cursor-pointer items-center gap-2 px-1 text-xs text-muted-foreground">
          <Checkbox
            checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
            onCheckedChange={toggleAllVisible}
          />
          <FormattedMessage id="membersView.selectAllShown" defaultMessage="Select all shown" />
        </label>
      )}

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md bg-foreground/5 px-4 py-8 text-sm text-muted-foreground">
          <Users className="size-5" />
          {allRows.length === 0 ? (
            <FormattedMessage id="membersView.noneObserved" defaultMessage="No members observed yet." />
          ) : (
            <FormattedMessage id="membersView.noneMatch" defaultMessage="No members match." />
          )}
        </div>
      ) : (
        <ul className="space-y-1.5">
          {visible.map((row) => (
            <MemberRow
              key={row.pubkey}
              row={row}
              density={density}
              currentEpoch={community.rootEpoch}
              selectable={selectable}
              selected={selection.selected.has(row.pubkey)}
              onToggle={(shiftKey) => setSelection((s) => clickRow(s, visibleOrder, row.pubkey, shiftKey))}
              roleNames={roles.filter((r) => row.roleIds.includes(r.roleId)).map((r) => r.name)}
              badge={folded ? badgeOf(folded.roster, row.pubkey) : undefined}
              suspicion={suspiciousOf.get(row.pubkey)}
            />
          ))}
        </ul>
      )}

      {!showAll && rows.length > RENDER_CAP && (
        <Button type="button" variant="outline" className="w-full" onClick={() => setShowAll(true)}>
          <FormattedMessage id="membersView.showAllCount" defaultMessage="Show all {count}" values={{ count: rows.length }} />
        </Button>
      )}

      {selectable && selected.length > 0 && (
        <div className="vessel-lift sticky bottom-2 z-10">
          <div className="vessel flex flex-wrap items-center gap-2 px-3 py-2 pb-safe">
            <span className="text-sm font-medium">
              <FormattedMessage
                id="membersView.selectedCount"
                defaultMessage="{count} selected"
                values={{ count: selected.length }}
              />
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {healTargets.length > 0 && (
                <Button type="button" size="sm" variant="secondary" disabled={healing !== null} onClick={runMassHeal}>
                  {healing ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      <FormattedMessage
                        id="membersView.sendingProgress"
                        defaultMessage="Sending {done}/{total}"
                        values={{ done: healing.done, total: healing.total }}
                      />
                    </>
                  ) : (
                    <>
                      <KeyRound className="size-3.5" />
                      <FormattedMessage
                        id="membersView.sendKeys"
                        defaultMessage="Send keys ({count})"
                        values={{ count: healTargets.length }}
                      />
                    </>
                  )}
                </Button>
              )}
              {tierTarget && tierOptions.map((tier) => (
                <Button
                  key={tier ?? "none"}
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={isSettingTier}
                  onClick={() => void runSetTier(tierTarget, tier)}
                >
                  {tier === "admin" ? <Crown className="size-3.5" /> : tier === "moderator" ? <Shield className="size-3.5" /> : <ShieldOff className="size-3.5" />}
                  {tier === "admin" ? (
                    <FormattedMessage id="membersView.makeAdmin" defaultMessage="Make admin" />
                  ) : tier === "moderator" ? (
                    tierCurrent === "admin" ? (
                      <FormattedMessage id="membersView.demoteToModerator" defaultMessage="Demote to moderator" />
                    ) : (
                      <FormattedMessage id="membersView.makeModerator" defaultMessage="Make moderator" />
                    )
                  ) : tierCurrent === "admin" ? (
                    <FormattedMessage id="membersView.removeAdmin" defaultMessage="Remove admin" />
                  ) : (
                    <FormattedMessage id="membersView.removeModerator" defaultMessage="Remove moderator" />
                  )}
                </Button>
              ))}
              {canModerate && (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={kickable.length === 0}
                    onClick={() => setKickTargets(kickable)}
                  >
                    <UserMinus className="size-3.5" />
                    {kickable.length > 0 ? (
                      <FormattedMessage
                        id="membersView.kickCount"
                        defaultMessage="Kick ({count})"
                        values={{ count: kickable.length }}
                      />
                    ) : (
                      <FormattedMessage id="membersView.kick" defaultMessage="Kick" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={bannable.length === 0}
                    onClick={() => setBanTargets(bannable)}
                  >
                    <Ban className="size-3.5" />
                    {bannable.length > 0 ? (
                      <FormattedMessage
                        id="membersView.banCount"
                        defaultMessage="Ban ({count})"
                        values={{ count: bannable.length }}
                      />
                    ) : (
                      <FormattedMessage id="membersView.ban" defaultMessage="Ban" />
                    )}
                  </Button>
                </>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => setSelection(emptySelection())}>
                <FormattedMessage id="membersView.clear" defaultMessage="Clear" />
              </Button>
            </div>
          </div>
        </div>
      )}

      <KickMembersDialog
        targets={kickTargets}
        ineligible={selected.filter((pk) => !moderation.canKick(pk))}
        onClose={() => {
          setKickTargets(null);
          setSelection(emptySelection());
        }}
        onConfirm={async (targets, onProgress) => {
          const result = await moderation.kickMany({ targets, onProgress });
          if (result.failed.length === 0) {
            toast({
              title: t(
                {
                  id: "membersView.kicked",
                  defaultMessage: "{count, plural, one {Kicked # member} other {Kicked # members}}",
                },
                { count: result.kicked.length },
              ),
            });
          }
          return result;
        }}
      />
      <BanMemberDialog
        targets={banTargets}
        ineligible={selected.filter((pk) => !moderation.canBan(pk))}
        willRotate={banWillRotate}
        onClose={() => {
          setBanTargets(null);
          setSelection(emptySelection());
        }}
        onConfirm={async (targets, onPhase, onStripProgress, onRekeyProgress) => {
          const { rekeyed, publicBan, banned } = await moderation.banMany({ targets, onPhase, onStripProgress, onRekeyProgress });
          const title = t(
            {
              id: "membersView.banned",
              defaultMessage: "{count, plural, one {Banned # member} other {Banned # members}}",
            },
            { count: banned.length },
          );
          if (rekeyed || publicBan) {
            toast({
              title,
              description: t({
                id: "membersView.bannedSilenced",
                defaultMessage: "They are silenced for everyone in this community.",
              }),
            });
          } else {
            toast({
              title,
              description: t({
                id: "membersView.bannedPending",
                defaultMessage: "They're silenced; the final lock-out will finish on your next visit.",
              }),
            });
          }
        }}
      />
    </div>
  );
}

const JOIN_PROVENANCE = defineMessages({
  join: { id: "membersView.provenance.join", defaultMessage: "From their own join." },
  snapshot: {
    id: "membersView.provenance.snapshot",
    defaultMessage: "Estimated. This is the time of a key rotation, not the actual join.",
  },
  observed: {
    id: "membersView.provenance.observed",
    defaultMessage: "Unknown. Inferred from activity because no join was observed.",
  },
}) satisfies Record<MemberDirectoryRow["joinKind"], unknown>;

function MemberRow({
  row,
  density,
  currentEpoch,
  selectable,
  selected,
  onToggle,
  roleNames,
  badge,
  suspicion,
}: {
  row: MemberDirectoryRow;
  density: "full" | "compact" | "minimal";
  currentEpoch: bigint;
  selectable: boolean;
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
  roleNames: string[];
  badge: "admin" | "moderator" | undefined;
  suspicion: SuspiciousActor | undefined;
}) {
  const author = useAuthor(row.pubkey);
  const name = useScopedDisplayName(row.pubkey, author.data?.metadata);
  const intl = useIntl();

  return (
    <li
      className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors ${
        row.suspicious
          ? selected
            ? "bg-destructive/25"
            : "bg-destructive/10"
          : selected
            ? "bg-primary/10"
            : "bg-foreground/5"
      } ${selectable ? "cursor-pointer select-none" : ""}`}
      onClick={selectable ? (e) => onToggle(e.shiftKey) : undefined}
      onMouseDown={selectable ? (e) => e.shiftKey && e.preventDefault() : undefined}
    >
      {selectable && (
        <Checkbox
          checked={selected}
          // Only onClick: onCheckedChange would toggle twice.
          onClick={(e) => {
            e.stopPropagation();
            onToggle(e.shiftKey);
          }}
          aria-label={intl.formatMessage({ id: "membersView.selectMember", defaultMessage: "Select {name}" }, { name })}
        />
      )}
      <Avatar className="size-6 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-3xs text-primary">
          <AvatarInitial name={name} pubkey={row.pubkey} />
        </AvatarFallback>
      </Avatar>
      {/* flex-auto, not flex-1: with basis 0% the chips would crush the name. */}
      <span className="min-w-0 flex-auto truncate font-medium">
        <DisplayName pubkey={row.pubkey} name={name} />
        {row.isSelf && <span className="ml-1.5 text-xs font-normal text-muted-foreground">
            <FormattedMessage id="membersView.you" defaultMessage="(you)" />
          </span>}
      </span>

      {suspicion && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-full bg-destructive/15 px-1.5 py-0.5 text-3xs font-medium text-destructive">
              <ShieldAlert className="size-3 shrink-0" />
              <span className="truncate">
                <FormattedMessage id="membersView.suspicious" defaultMessage="Suspicious" />
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-60 text-xs">
            <FormattedMessage
              id="membersView.suspiciousTooltip"
              defaultMessage="Tried to make {attempts} without permission. None of it worked, and nothing in the community changed."
              values={{ attempts: describeAttempts(suspicion.attempts) }}
            />
          </TooltipContent>
        </Tooltip>
      )}
      {row.isOwner && (
        <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-3xs font-medium text-amber-500">
          <Crown className="size-3 shrink-0" />
          <span className="truncate">
            <FormattedMessage id="membersView.owner" defaultMessage="Owner" />
          </span>
        </span>
      )}
      {!row.isOwner && badge && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`inline-flex min-w-0 shrink items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium ${
                badge === "admin" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
              }`}
            >
              <Shield className="size-3 shrink-0" />
              <span className="truncate">
                {badge === "admin" ? (
                  <FormattedMessage id="membersView.admin" defaultMessage="Admin" />
                ) : (
                  <FormattedMessage id="membersView.mod" defaultMessage="Mod" />
                )}
              </span>
            </span>
          </TooltipTrigger>
          {roleNames.length > 0 && (
            <TooltipContent className="max-w-52 text-xs">{roleNames.join(", ")}</TooltipContent>
          )}
        </Tooltip>
      )}

      {/* Chips shrink before the name (flex, not breakpoints). */}
      {density === "full" && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 shrink-[3] truncate text-xs tabular-nums text-muted-foreground">
              {row.joinMs !== undefined ? (
                <FormattedMessage
                  id="membersView.joinedAgo"
                  defaultMessage="joined {ago}"
                  values={{ ago: shortTimeAgoPhrase(Math.floor(row.joinMs / 1000)) }}
                />
              ) : (
                <FormattedMessage id="membersView.joinUnknown" defaultMessage="join unknown" />
              )}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-56 space-y-0.5 text-xs">
            {row.joinMs !== undefined && <p>{new Date(row.joinMs).toLocaleString(intl.locale)}</p>}
            <p>
              <FormattedMessage {...JOIN_PROVENANCE[row.joinKind]} />
            </p>
            {row.invite && (
              <p>
                {row.invite.label ? (
                  <FormattedMessage
                    id="membersView.invitedByThrough"
                    defaultMessage={'Invited by {name} through "{label}".'}
                    values={{ name: <InviterName pubkey={row.invite.creator} />, label: row.invite.label }}
                  />
                ) : (
                  <FormattedMessage
                    id="membersView.invitedBy"
                    defaultMessage="Invited by {name}."
                    values={{ name: <InviterName pubkey={row.invite.creator} /> }}
                  />
                )}
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      )}

      {density === "full" && row.invite && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="min-w-0 shrink-[4] truncate text-xs text-muted-foreground">
              <FormattedMessage
                id="membersView.via"
                defaultMessage="via {name}"
                values={{ name: <InviterName pubkey={row.invite.creator} /> }}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-56 text-xs">
            {row.invite.label ? (
              <FormattedMessage
                id="membersView.joinedThroughLabel"
                defaultMessage={'Joined through the "{label}" invite link created by {name}.'}
                values={{ label: row.invite.label, name: <InviterName pubkey={row.invite.creator} /> }}
              />
            ) : (
              <FormattedMessage
                id="membersView.joinedThrough"
                defaultMessage="Joined through an invite link created by {name}."
                values={{ name: <InviterName pubkey={row.invite.creator} /> }}
              />
            )}
          </TooltipContent>
        </Tooltip>
      )}
      {density !== "minimal" && (
        <span
          className="min-w-0 shrink-[2] truncate text-xs tabular-nums text-muted-foreground"
          title={row.lastSeenMs > 0 ? new Date(row.lastSeenMs).toLocaleString(intl.locale) : undefined}
        >
          {row.lastSeenMs > 0 ? (
            <FormattedMessage
              id="membersView.seenAgo"
              defaultMessage="seen {ago}"
              values={{ ago: shortTimeAgoPhrase(Math.floor(row.lastSeenMs / 1000)) }}
            />
          ) : (
            <FormattedMessage id="membersView.notSeen" defaultMessage="not seen" />
          )}
        </span>
      )}

      {row.behind && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-3xs font-medium text-warning">
              <TriangleAlert className="size-3" />
              <FormattedMessage id="membersView.epochChip" defaultMessage="epoch {epoch}" values={{ epoch: row.epoch?.toString() }} />
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-52 text-xs">
            <FormattedMessage
              id="membersView.behindTooltip"
              defaultMessage="Last seen posting under epoch {epoch}, but the community is on {current}. Select them and use Send keys to catch them up."
              values={{ epoch: row.epoch?.toString(), current: currentEpoch.toString() }}
            />
          </TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

function InviterName({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <>{name}</>;
}
