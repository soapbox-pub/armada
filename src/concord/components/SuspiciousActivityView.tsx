import { Ban, Clock, Copy, Loader2, ShieldCheck, UserMinus } from "lucide-react";
import { useState } from "react";
import { nip19 } from "nostr-tools";

import { DisplayName } from "@/components/DisplayName";
import { SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { useSuspiciousActivity } from "@/concord/hooks/useSuspiciousActivity";
import { useTimeTravelers } from "@/concord/hooks/useTimeTravelers";
import { describeAttempts, type SuspiciousActor } from "@/concord/lib/auditLog";
import { describeAhead, travelerRank, type TimeTraveler } from "@/concord/lib/timeTravelers";
import type { FoldedControl } from "@/concord/lib/control";
import type { Channel, Community } from "@/concord/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { FormattedMessage, useIntl } from "@/i18n";

function ActorRow({
  actor,
  onBan,
  busy,
}: {
  actor: SuspiciousActor;
  onBan: (target: string) => void;
  busy: boolean;
}) {
  const author = useAuthor(actor.author);
  const name = useScopedDisplayName(actor.author, author.data?.metadata);
  return (
    <li className="clip-corner-lg bg-destructive/10 p-3">
      <p className="text-sm">
        <FormattedMessage
          id="suspiciousActivityView.actor"
          defaultMessage="<b>{name}</b> is not an admin here, but has tried to make <b>{attempts}</b>."
          values={{
            name: <DisplayName pubkey={actor.author} name={name} />,
            attempts: describeAttempts(actor.attempts),
            b: (chunks) => <span className="font-semibold">{chunks}</span>,
          }}
        />
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        <FormattedMessage
          id="suspiciousActivityView.actorHint"
          defaultMessage="None of it worked, so nothing in the community has actually changed. Banning them also changes the community's keys, so they lose access rather than just being silenced."
        />
      </p>
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={busy || actor.banned}
          onClick={() => onBan(actor.author)}
        >
          {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
          {actor.banned ? (
            <FormattedMessage id="suspiciousActivityView.alreadyBanned" defaultMessage="Already banned" />
          ) : (
            <FormattedMessage id="suspiciousActivityView.banLockOut" defaultMessage="Ban and lock them out" />
          )}
        </Button>
      </div>
    </li>
  );
}

/** A member with future-dated messages: usually a wrong clock, but also a spam vector, so the remedy is offered. */
function TravelerRow({
  traveler,
  onKick,
  onBan,
  canKick,
  canBan,
  busy,
}: {
  traveler: TimeTraveler;
  onKick: (target: string) => void;
  onBan: (target: string) => void;
  canKick: boolean;
  canBan: boolean;
  busy: boolean;
}) {
  const author = useAuthor(traveler.author);
  const name = useScopedDisplayName(traveler.author, author.data?.metadata);
  const intl = useIntl();

  const copyNpub = () => {
    try {
      const npub = nip19.npubEncode(traveler.author);
      void navigator.clipboard?.writeText(npub);
      toast({ title: intl.formatMessage({ id: "suspiciousActivityView.copiedNpub", defaultMessage: "Copied their npub" }) });
    } catch {
      toast({
        title: intl.formatMessage({ id: "suspiciousActivityView.copyFailed", defaultMessage: "Couldn't copy" }),
        variant: "destructive",
      });
    }
  };

  return (
    <li className="clip-corner-lg bg-primary/10 p-3">
      <div className="flex items-start gap-3">
        <UserAvatar
          pubkey={traveler.author}
          metadata={author.data?.metadata}
          imeta={author.data?.imeta?.picture}
          alt=""
          className="size-9 shrink-0"
          fallback={<Clock className="size-4" />}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate font-semibold">
              <DisplayName pubkey={traveler.author} name={name} />
            </span>
            <span className="rounded-full bg-primary/20 px-2 py-0.5 text-3xs font-bold uppercase tracking-wide text-primary">
              {travelerRank(traveler.aheadMs)}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {traveler.count > 1 ? (
              <FormattedMessage
                id="suspiciousActivityView.aheadMany"
                defaultMessage="Broadcasting from <b>{ahead}</b> ahead of you ({count} messages)."
                values={{
                  ahead: describeAhead(traveler.aheadMs),
                  count: traveler.count,
                  b: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
                }}
              />
            ) : (
              <FormattedMessage
                id="suspiciousActivityView.ahead"
                defaultMessage="Broadcasting from <b>{ahead}</b> ahead of you."
                values={{
                  ahead: describeAhead(traveler.aheadMs),
                  b: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
                }}
              />
            )}
          </p>
          {traveler.sample ? (
            <p className="mt-1 line-clamp-2 rounded bg-background/50 px-2 py-1 text-xs italic text-muted-foreground">
              “{traveler.sample}”
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={copyNpub}>
              <Copy className="mr-1.5 size-3.5" />
              <FormattedMessage id="suspiciousActivityView.copyNpub" defaultMessage="Copy npub" />
            </Button>
            {canKick ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onKick(traveler.author)}>
                <UserMinus className="mr-1.5 size-3.5" />
                <FormattedMessage id="suspiciousActivityView.kick" defaultMessage="Kick" />
              </Button>
            ) : null}
            {canBan ? (
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => onBan(traveler.author)}>
                {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Ban className="mr-1.5 size-3.5" />}
                <FormattedMessage id="suspiciousActivityView.ban" defaultMessage="Ban" />
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * The `suspicious` pane: control-plane abuse rows and time travelers, both
 * with the real kick/ban remedy. `canBan`/`canKick` gate the traveler remedy.
 */
export function SuspiciousActivityView({
  community,
  channels,
  folded,
  ban,
  kick,
  canBan,
  canKick,
}: {
  community: Community | undefined;
  channels: Channel[];
  folded: FoldedControl | undefined;
  ban: (args: { target: string; forceRotate?: boolean }) => Promise<{ rekeyed: boolean; publicBan: boolean }>;
  kick: (target: string) => Promise<void>;
  canBan: (target: string) => boolean;
  canKick: (target: string) => boolean;
}) {
  const { actors, unreadable, flooded, alert, dismiss } = useSuspiciousActivity(community, folded);
  const travelers = useTimeTravelers(community, channels);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const intl = useIntl();

  const onBan = (target: string) => {
    setBusy(target);
    // Always rotate: a banlist alone leaves the flooder holding the root.
    ban({ target, forceRotate: true })
      .then((r) => {
        toast({
          title: intl.formatMessage({ id: "suspiciousActivityView.banned", defaultMessage: "Member banned" }),
          description: r.rekeyed
            ? intl.formatMessage({
                id: "suspiciousActivityView.bannedRekeyed",
                defaultMessage: "The community's keys were changed, so they no longer have access.",
              })
            : intl.formatMessage({
                id: "suspiciousActivityView.bannedSilenced",
                defaultMessage: "They can no longer act in this community.",
              }),
        });
      })
      .catch((e) =>
        toast({
          title: intl.formatMessage({ id: "suspiciousActivityView.banFailed", defaultMessage: "Couldn't remove them" }),
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
      )
      .finally(() => setBusy(undefined));
  };

  const onKick = (target: string) => {
    setBusy(target);
    kick(target)
      .then(() =>
        toast({ title: intl.formatMessage({ id: "suspiciousActivityView.kicked", defaultMessage: "Member kicked" }) }),
      )
      .catch((e) =>
        toast({
          title: intl.formatMessage({ id: "suspiciousActivityView.kickFailed", defaultMessage: "Couldn't kick them" }),
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
      )
      .finally(() => setBusy(undefined));
  };

  const nothing = !alert && travelers.length === 0;

  return (
    <SettingsGroup title={intl.formatMessage({ id: "suspiciousActivityView.title", defaultMessage: "Suspicious activity" })}>
      {nothing ? (
        <SettingsRow
          icon={ShieldCheck}
          tone="success"
          label={intl.formatMessage({ id: "suspiciousActivityView.clearLabel", defaultMessage: "All clear" })}
          description={intl.formatMessage({ id: "suspiciousActivityView.clearHint", defaultMessage: "Members acting without permission, or with a badly wrong clock, would show up here." })}
        />
      ) : (
        <SettingsRow>
        <div className="space-y-6">
          {alert ? (
            <section className="space-y-3">
              {flooded ? (
                // The read hit our own limit with history unread; this also explains why nobody is named.
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    <FormattedMessage
                      id="suspiciousActivityView.flooded1"
                      defaultMessage="This community's history has grown so large we can no longer read all of it. That takes deliberate effort, and only a member can do it, so someone here is burying it on purpose."
                    />
                  </p>
                  <p>
                    <FormattedMessage
                      id="suspiciousActivityView.flooded2"
                      defaultMessage="Until it is cleared up, roles and bans may be out of date on new devices, and we cannot say for certain who is responsible. Changing the community's keys is what stops it, but only once they have been removed, so it is worth closing the community to new joins and reviewing anyone who joined recently or has never spoken."
                    />
                  </p>
                </div>
              ) : actors.length === 0 ? (
                // Junk is signed with the shared key, so it names nobody; hence prune-and-rotate.
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    <FormattedMessage
                      id="suspiciousActivityView.junk1"
                      defaultMessage="Someone inside this community is flooding it with junk. They can only do that because they are a member: the events are signed with a key every member shares, which is also why there is no way to tell which of them it is."
                    />
                  </p>
                  <p>
                    <FormattedMessage
                      id="suspiciousActivityView.junk2"
                      defaultMessage="Changing the community's keys is what stops it, but only once they have been removed. It is worth closing the community to new joins first, then reviewing anyone who joined recently, has never spoken, or you already had doubts about."
                    />
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  <FormattedMessage
                    id="suspiciousActivityView.actorsIntro"
                    defaultMessage="{count, plural, one {Someone is trying to perform admin actions in this community without permission. What should we do about them?} other {# people are trying to perform admin actions in this community without permission. What should we do about them?}}"
                    values={{ count: actors.length }}
                  />
                </p>
              )}

              {actors.length > 0 ? (
                <ul className="space-y-2">
                  {actors.map((actor) => (
                    <ActorRow key={actor.author} actor={actor} onBan={onBan} busy={busy === actor.author} />
                  ))}
                </ul>
              ) : null}

              {unreadable > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {actors.length > 0 ? (
                    <FormattedMessage
                      id="suspiciousActivityView.unreadableWithActors"
                      defaultMessage="Also seen: <b>{count} unreadable events</b>, slowing everyone's sync. These can't be traced to anyone, so banning the member above may not stop them. It is worth removing anyone else you don't trust, especially members who joined recently or have never spoken."
                      values={{ count: unreadable, b: (chunks) => <span className="font-semibold text-destructive">{chunks}</span> }}
                    />
                  ) : (
                    <FormattedMessage
                      id="suspiciousActivityView.unreadable"
                      defaultMessage="Also seen: <b>{count} unreadable events</b>, slowing everyone's sync."
                      values={{ count: unreadable, b: (chunks) => <span className="font-semibold text-destructive">{chunks}</span> }}
                    />
                  )}
                </p>
              ) : null}

              <div className="flex justify-end">
                <Button variant="ghost" size="sm" onClick={dismiss}>
                  {actors.length === 0 ? (
                    <FormattedMessage id="suspiciousActivityView.understood" defaultMessage="Understood" />
                  ) : (
                    <FormattedMessage id="suspiciousActivityView.ignore" defaultMessage="Ignore for now" />
                  )}
                </Button>
              </div>
            </section>
          ) : null}

          {travelers.length > 0 ? (
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <Clock className="size-4 text-primary" />
                <h3 className="text-sm font-semibold text-primary">
                  <FormattedMessage
                    id="suspiciousActivityView.travelers"
                    defaultMessage="{count, plural, one {Time traveler detected} other {# time travelers detected}}"
                    values={{ count: travelers.length }}
                  />
                </h3>
              </div>
              <p className="text-xs text-muted-foreground">
                <FormattedMessage
                  id="suspiciousActivityView.travelersHint"
                  defaultMessage="Messages dated in the future stay hidden until their timestamp comes around. Usually a wrong device clock, but if one is being used to jump the timeline, kick or ban."
                />
              </p>
              <ul className="space-y-2">
                {travelers.map((t) => (
                  <TravelerRow
                    key={t.author}
                    traveler={t}
                    onKick={onKick}
                    onBan={onBan}
                    canKick={canKick(t.author)}
                    canBan={canBan(t.author)}
                    busy={busy === t.author}
                  />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
        </SettingsRow>
      )}
    </SettingsGroup>
  );
}
