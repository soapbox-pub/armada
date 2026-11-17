import { useRef, useState, type ReactNode } from "react";

import { AccessReviewDialog } from "@/concord/components/accessReview/AccessReviewDialog";
import { reviewMessages } from "@/concord/components/accessReview/reviewMessages";
import { rotateAgain, useApplyRun, type ApplyPhase } from "@/concord/components/accessReview/useApplyRun";
import type { SettleFollow } from "@/concord/hooks/rosterSettle";
import type { WriteProgressSink } from "@/concord/hooks/useRankedRoles";
import { withGrant } from "@/concord/lib/accessDuty";
import { keyWork, reviewAccess, reviewMoves, type AccessReview } from "@/concord/lib/accessReview";
import { channelView } from "@/concord/lib/channelView";
import { channelDisplayName } from "@/concord/lib/community";
import type { FoldedControl } from "@/concord/lib/control";
import { effectivePermissions, PERMISSION_LABELS, roleById } from "@/concord/lib/roles";
import type { Community } from "@/concord/lib/types";
import { toast } from "@/hooks/useToast";
import { t } from "@/i18n";

interface GrantReviewOptions {
  community: Community | undefined;
  folded: FoldedControl | undefined;
  me: string | undefined;
  /** The member's Role ids as this client last asked for them. */
  rolesFor: (member: string) => string[];
  /** Publishes the toggle, counting its editions into `progress` and reporting the keys it moves through `follow`. Resolves false for a repeat in flight. */
  toggle: (member: string, roleId: string, on: boolean, follow: SettleFollow, progress: WriteProgressSink) => Promise<boolean>;
  rotate?: (channelIdHex: string) => Promise<void>;
  /** The toggle landed and its keys moved. */
  onDone: (on: boolean) => void;
}

interface Asked {
  member: string;
  roleId: string;
  on: boolean;
  access: AccessReview;
  permissions: { gained: string[]; lost: string[] };
  plan: ApplyPhase[];
}

/**
 * A Role toggle that changes what a member can see or do is shown before it is
 * written, and its dialog stays until the keys it moves have moved. `ask`
 * answers false for a toggle that changes neither, which the caller writes itself.
 */
export function useGrantReview(o: GrantReviewOptions): { ask: (member: string, roleId: string, on: boolean) => boolean; dialog: ReactNode } {
  const [asked, setAsked] = useState<Asked | null>(null);
  const run = useApplyRun();
  const [written, setWritten] = useState({ published: 0, planned: 0 });
  const showing = useRef(false);
  const { community, folded } = o;

  const ask = (member: string, roleId: string, on: boolean): boolean => {
    if (!folded || member === folded.ownerHex) return false;
    // One change is reviewed at a time; a second is dropped rather than written unseen.
    if (asked) return true;
    const held = o.rolesFor(member);
    if (held.includes(roleId) === on) return false;
    const before = withGrant(folded.roster, member, held);
    const after = withGrant(folded.roster, member, on ? [...held, roleId] : held.filter((id) => id !== roleId));
    const channels = [...folded.channels.values()]
      .filter((c) => !c.deleted)
      .map((c) => ({ idHex: c.channelIdHex, wasPrivate: c.isPrivate, isPrivate: c.isPrivate }));
    const access = reviewAccess({ before, after, ownerHex: folded.ownerHex, banned: folded.banned, members: [member], channels });
    const was = effectivePermissions(before, member);
    const now = effectivePermissions(after, member);
    const labels = (bits: bigint) =>
      PERMISSION_LABELS.filter((p) => (bits & p.bit) !== 0n && (folded.rankedRoster || !p.rankedRoles)).map((p) => p.label);
    const permissions = { gained: labels(now & ~was), lost: labels(was & ~now) };
    if (!reviewMoves(access) && permissions.gained.length === 0 && permissions.lost.length === 0) return false;
    const work = keyWork(access, o.me);
    const plan: ApplyPhase[] = ["save", ...(work.rotate.length ? (["rotate"] as const) : []), ...(work.send.length ? (["send"] as const) : [])];
    run.reset();
    showing.current = true;
    setAsked({ member, roleId, on, access, permissions, plan });
    return true;
  };

  const hide = () => {
    showing.current = false;
    setAsked(null);
    run.reset();
  };
  const settle = (on: boolean) => (outcome: "clean" | "unfinished") => {
    if (showing.current) {
      if (outcome === "unfinished") return;
      hide();
      o.onDone(on);
      return;
    }
    // Closed as stuck: the outcome still has to be said somewhere.
    run.reset();
    if (outcome === "clean") o.onDone(on);
    else toast({ title: t(reviewMessages.applyUnfinished), variant: "destructive" });
  };
  const progress: WriteProgressSink = {
    planned: (count) => setWritten((w) => ({ ...w, planned: w.planned + count })),
    published: () => setWritten((w) => ({ ...w, published: w.published + 1 })),
  };
  const apply = (a: Asked, keep = false) =>
    void run
      .start(
        a.plan,
        async (sink) => {
          sink.at("save");
          setWritten({ published: 0, planned: 0 });
          await o.toggle(a.member, a.roleId, a.on, { watch: sink.at, onSettled: sink.settled }, progress);
        },
        { keep },
      )
      .then(settle(a.on));

  if (!asked || !folded) return { ask, dialog: null };

  const unrotated = run.report?.rotationFailed.map((f) => f.channelIdHex) ?? [];
  const { rotate } = o;
  const retry =
    run.status !== "unfinished"
      ? undefined
      : run.failure === "write"
        ? () => apply(asked, true)
        : unrotated.length > 0 && rotate
          ? () => void rotateAgain(run, unrotated, rotate).then(settle(asked.on))
          : undefined;

  return {
    ask,
    dialog: (
      <AccessReviewDialog
        subject={{ kind: "member", pubkey: asked.member }}
        review={asked.access}
        permissions={asked.permissions}
        roleName={(id) => roleById(folded.roster, id)?.name}
        channel={(id) => {
          const def = folded.channels.get(id);
          return { name: channelDisplayName(community, folded, id), isPrivate: def?.isPrivate ?? false, view: def ? channelView(def.metadata) : undefined };
        }}
        me={o.me}
        run={run}
        published={written.published}
        planned={written.planned}
        onApply={() => run.status === "review" && apply(asked)}
        onCancel={hide}
        onClose={hide}
        onRetry={retry}
      />
    ),
  };
}
