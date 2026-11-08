import { useNostr } from "@nostrify/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { ToastAction } from "@/components/ui/toast";
import { assertNotDissolved, DissolvedCommunityError } from "@/concord/hooks/useCommunityActions";
import { useCommunity, useCommunityEntry, useUpdateCommunityList } from "@/concord/hooks/useCommunityList";
import { invalidateControl, useControlFold } from "@/concord/hooks/useControlPlane";
import { useInviteInbox, type ParkedInvite } from "@/concord/hooks/useDirectInvites";
import { judgeCatchUpChannels, type CatchUpJudgement, type CatchUpVerdict } from "@/concord/lib/catchUpAdoption";
import { setCatchUpVerdict, verdictIsManual } from "@/concord/lib/catchUpVerdicts";
import { heldMembershipOf } from "@/concord/lib/directInvite";
import { sweepControl } from "@/concord/lib/planeSync";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { t } from "@/i18n";

/**
 * How long a staff-sent catch-up the fold refuses is treated as fold lag: the key
 * is sent right after the Grant that entitles it, so it often outruns it.
 */
const CATCH_UP_GRACE_MS = 20_000;
/** When, within the grace, to re-read the Control Plane for a Grant the live sub missed. */
const CATCH_UP_RESWEEP_MS = 4_000;

/**
 * Passive notifier for direct Concord invites (CORD-05 §6): a toast pointing
 * to `/invites`, where joining is decided. Exception: a catch-up (a private
 * channel key for an existing community, vended by a role grant) that the
 * fold confirms (`judgeCatchUp`) is APPLIED here — the Grant was the consent.
 * Never fetches the sender's profile before the user decides.
 */
export function DirectInviteNotifier() {
  const { items, catchUps } = useInviteInbox();
  const { pathname } = useLocation();
  // Session-scoped so polls don't re-toast; a relaunch nudges once more.
  const announced = useRef<Set<string>>(new Set());
  // Wait for each catch-up's verdict rather than toast a decision about to be made.
  const [verdicts, setVerdicts] = useState<ReadonlyMap<string, CatchUpVerdict>>(new Map());
  const onVerdict = useCallback((wrapId: string, verdict: CatchUpVerdict) => {
    setCatchUpVerdict(wrapId, verdict);
    setVerdicts((prev) => (prev.get(wrapId) === verdict ? prev : new Map(prev).set(wrapId, verdict)));
  }, []);
  const onAdopted = useCallback((wrapId: string) => {
    announced.current.add(wrapId);
  }, []);

  const onInbox = pathname === "/invites";

  useEffect(() => {
    if (onInbox) {
      for (const it of items) announced.current.add(it.invite.wrapId);
      return;
    }

    const fresh = items.filter((it) => {
      if (!it.unread || announced.current.has(it.invite.wrapId)) return false;
      if (!it.invite.catchUp) return true;
      // Catch-ups are offered only once judged a manual Accept.
      return verdictIsManual(verdicts.get(it.invite.wrapId));
    });
    if (fresh.length === 0) return;
    for (const it of fresh) announced.current.add(it.invite.wrapId);

    const newest = fresh[0].invite;
    const title =
      fresh.length > 1
        ? t({ id: "directInviteNotifier.newInvites", defaultMessage: "{count, plural, one {# new community invite} other {# new community invites}}" }, { count: fresh.length })
        : newest.catchUp
          ? t({ id: "directInviteNotifier.newChannelKeys", defaultMessage: "New channel keys offered" })
          : t({ id: "directInviteNotifier.newInvite", defaultMessage: "New community invite" });

    toast({
      title,
      description: fresh.length > 1 ? undefined : newest.name,
      action: (
        <ToastAction altText={t({ id: "directInviteNotifier.viewInvites", defaultMessage: "View invites" })} asChild>
          <Link to="/invites">{t({ id: "directInviteNotifier.view", defaultMessage: "View" })}</Link>
        </ToastAction>
      ),
    });
  }, [items, onInbox, verdicts]);

  return (
    <>
      {catchUps.map((invite) => (
        <CatchUpAdopter key={invite.wrapId} invite={invite} onVerdict={onVerdict} onAdopted={onAdopted} />
      ))}
    </>
  );
}

/** Judges one parked catch-up against its community's fold and applies it if confirmed. */
function CatchUpAdopter({
  invite,
  onVerdict,
  onAdopted,
}: {
  invite: ParkedInvite;
  onVerdict: (wrapId: string, verdict: CatchUpVerdict) => void;
  onAdopted: (wrapId: string) => void;
}) {
  const { user } = useCurrentUser();
  const { nostr } = useNostr();
  const entry = useCommunityEntry(invite.communityId);
  const community = useCommunity(invite.communityId);
  const { data: folded } = useControlFold(community);
  const { mutateAsync: updateList } = useUpdateCommunityList();
  const queryClient = useQueryClient();
  // The `add` merge is epoch-monotonic (CORD-02 §8), so a racing re-apply can't regress keys.
  const applied = useRef(false);

  const held = useMemo(() => (entry ? heldMembershipOf(entry) : undefined), [entry]);
  const judged: CatchUpJudgement = useMemo(() => {
    // An unreadable membership list is not a verdict.
    if (!user || !held) return { verdict: "no-fold", adopt: [] };
    return judgeCatchUpChannels(folded, user.pubkey, invite.sender, invite.bundle, held);
  }, [folded, user, invite, held]);
  const verdict = judged.verdict;

  // A refusal that a Grant still in flight would overturn waits out the grace
  // (re-reading the plane once) before it becomes a manual Accept.
  const mayBeLag = verdict === "not-entitled" || verdict === "sender-unauthorized";
  const [graceOver, setGraceOver] = useState(false);
  const sweepRef = useRef<() => void>(() => undefined);
  sweepRef.current = () => {
    if (!community) return;
    void sweepControl(nostr, community)
      .then(() => invalidateControl(queryClient, community.idHex))
      .catch(() => undefined);
  };
  useEffect(() => {
    if (!mayBeLag || graceOver) return;
    const resweep = setTimeout(() => sweepRef.current(), CATCH_UP_RESWEEP_MS);
    const expire = setTimeout(() => setGraceOver(true), CATCH_UP_GRACE_MS);
    return () => {
      clearTimeout(resweep);
      clearTimeout(expire);
    };
  }, [mayBeLag, graceOver]);

  useEffect(() => {
    onVerdict(invite.wrapId, mayBeLag && !graceOver ? "no-fold" : verdict);
  }, [invite.wrapId, verdict, mayBeLag, graceOver, onVerdict]);

  useEffect(() => {
    if (judged.verdict !== "adopt" || applied.current || !entry) return;
    applied.current = true;
    const adopt = new Set(judged.adopt);
    const channels = invite.bundle.channels.filter((c) => adopt.has(c.id.toLowerCase()));
    const names = channels.map((c) => c.name);
    void (async () => {
      try {
        // A dissolved community takes no new keys; the inbox's Accept explains why.
        await assertNotDissolved(nostr, invite.bundle);
        // Only the judged keys, on the held entry: a vend seats keys and moves nothing else.
        await updateList({ type: "add", entry: { ...entry, current: { ...entry.current, channels: channels.map((c) => ({ id: c.id, key: c.key, epoch: c.epoch, name: c.name })) } } });
      } catch (e) {
        if (e instanceof DissolvedCommunityError) return;
        // Vault write failed; a later render or Accept retries.
        applied.current = false;
        return;
      }
      onAdopted(invite.wrapId);
      toast({
        title: t(
          { id: "directInviteNotifier.channelsAdded", defaultMessage: "{count, plural, one {Channel added} other {# channels added}}" },
          { count: names.length },
        ),
        description: t(
          { id: "directInviteNotifier.channelsAddedDescription", defaultMessage: "{channels} in {community}" },
          { channels: names.map((n) => `#${n}`).join(", "), community: invite.name },
        ),
      });
      queryClient.invalidateQueries({ queryKey: ["concord", "direct-invites"] });
      queryClient.invalidateQueries({ queryKey: ["concord", "list"] });
    })();
  }, [judged, entry, invite, nostr, updateList, onAdopted, queryClient]);

  return null;
}
