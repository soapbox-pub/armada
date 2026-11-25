import { Loader2, UserCheck, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { InfoTip, SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useApprovalGate } from "@/concord/hooks/useApprovalGate";
import { carriedOver, gateState } from "@/concord/lib/approvalGate";
import type { FoldedControl } from "@/concord/lib/control";
import type { Channel, Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { clockNowMs } from "@/lib/relayClock";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_DAYS = 30;
const NO_WELCOME = "none";

type Progress = { done: number; total: number } | undefined;

/**
 * Safety › "Require approval to post", as a switch. Switching it takes Manage Roles,
 * as any `@everyone` edit does (CORD-04 §2); both directions confirm first.
 */
export function ApprovalGateSection({
  community,
  folded,
  channels,
  members,
  observed,
}: {
  community: Community;
  folded: FoldedControl | undefined;
  channels: Channel[];
  members: readonly string[];
  observed: ReadonlyMap<string, number>;
}) {
  const intl = useIntl();
  const gate = useApprovalGate(community);
  const [dialog, setDialog] = useState<"on" | "off" | null>(null);

  if (!folded?.rankedRoster) return null;

  return (
    <SettingsGroup title={intl.formatMessage({ id: "approvalGate.groupTitle", defaultMessage: "Joining" })}>
      <SettingsRow
        icon={UserCheck}
        tone="primary"
        label={intl.formatMessage({ id: "approvalGate.title", defaultMessage: "Require approval to post" })}
        description={
          gate.on
            ? intl.formatMessage(
                { id: "approvalGate.onRow", defaultMessage: "{count, plural, =0 {On. Nobody is waiting.} one {On. # member is waiting.} other {On. # members are waiting.}}" },
                { count: gate.awaiting.size },
              )
            : gate.canSwitch
              ? intl.formatMessage({ id: "approvalGate.offRow", defaultMessage: "New members can post as soon as they join." })
              : intl.formatMessage({ id: "approvalGate.needsManageRoles", defaultMessage: "Changing this needs the Manage roles permission." })
        }
        info={intl.formatMessage({
          id: "approvalGate.description",
          defaultMessage: "New members can read and react, but can't post, start threads or share files until a moderator approves them. Approving gives them the Verified role. A banned member coming back on a new account has to be approved again.",
        })}
      >
        <Switch
          checked={gate.on}
          disabled={!gate.canSwitch || gate.switching}
          onCheckedChange={(next) => setDialog(next ? "on" : "off")}
          aria-label={intl.formatMessage({ id: "approvalGate.title", defaultMessage: "Require approval to post" })}
        />
      </SettingsRow>
      {gate.progress && !dialog && <ProgressRow progress={gate.progress} />}

      {dialog === "on" && (
        <TurnOnDialog
          community={community}
          folded={folded}
          channels={channels}
          members={members}
          observed={observed}
          onClose={() => setDialog(null)}
          turnOn={gate.turnOn}
          progress={gate.progress}
        />
      )}
      {dialog === "off" && <TurnOffDialog onClose={() => setDialog(null)} turnOff={gate.turnOff} />}
    </SettingsGroup>
  );
}

function ProgressRow({ progress }: { progress: NonNullable<Progress> }) {
  return (
    <SettingsRow>
      <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <FormattedMessage id="approvalGate.progress" defaultMessage="Publishing {done} of {total}. Keep this page open." values={progress} />
      </p>
    </SettingsRow>
  );
}

function TurnOnDialog({
  community,
  folded,
  channels,
  members,
  observed,
  onClose,
  turnOn,
  progress,
}: {
  community: Community;
  folded: FoldedControl;
  channels: Channel[];
  members: readonly string[];
  observed: ReadonlyMap<string, number>;
  onClose: () => void;
  turnOn: ReturnType<typeof useApprovalGate>["turnOn"];
  progress: Progress;
}) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const [keep, setKeep] = useState<"active" | "everyone">("active");
  const [welcome, setWelcome] = useState(NO_WELCOME);
  const [busy, setBusy] = useState(false);

  // A Channel synced to a Category takes its Category's rules, and a Private one is closed to @everyone.
  const welcomeChoices = useMemo(
    () => channels.filter((c) => !c.isPrivate && !folded.roster.syncs?.[c.idHex.toLowerCase()]),
    [channels, folded],
  );
  // Read once per open, so the counts don't shift while the reader decides.
  const [nowMs] = useState(clockNowMs);
  const activeSinceMs = keep === "everyone" ? 0 : nowMs - ACTIVE_WINDOW_DAYS * DAY_MS;
  const plan = useMemo(
    () => (user ? carriedOver(folded, user.pubkey, members, observed, activeSinceMs, gateState(folded, community.idHex).role?.roleId) : { grant: [], unreachable: [], waiting: 0 }),
    [folded, user, members, observed, activeSinceMs, community.idHex],
  );

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await turnOn({
        members,
        observed,
        activeSinceMs,
        ...(welcome !== NO_WELCOME ? { welcomeChannel: welcome } : {}),
      });
      toast({
        title: t({ id: "approvalGate.onDone", defaultMessage: "Approval to post is on" }),
        description: result.unreachable.length > 0
          ? t(
              { id: "approvalGate.onDoneUnreachable", defaultMessage: "{count, plural, one {# member ranked at or above you couldn't be given Verified; someone above them has to.} other {# members ranked at or above you couldn't be given Verified; someone above them has to.}}" },
              { count: result.unreachable.length },
            )
          : undefined,
      });
      onClose();
    } catch (e) {
      toast({
        title: t({ id: "approvalGate.onFailed", defaultMessage: "Couldn't turn approval on" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <ChromeDialogContent title={intl.formatMessage({ id: "approvalGate.title", defaultMessage: "Require approval to post" })}>
        <ChromeDialogHeader
          icon={UserCheck}
          title={<FormattedMessage id="approvalGate.onTitle" defaultMessage="Require approval to post?" />}
          description={<FormattedMessage id="approvalGate.onLead" defaultMessage="New members can read, but can't post until a moderator approves them." />}
        />

        <div className="mt-6 space-y-2">
          <p className="text-sm font-medium">
            <FormattedMessage id="approvalGate.keepLabel" defaultMessage="Who keeps posting" />
          </p>
          <div className="grid grid-cols-2 gap-2" role="radiogroup">
            {(["active", "everyone"] as const).map((choice) => (
              <Button
                key={choice}
                type="button"
                role="radio"
                aria-checked={keep === choice}
                variant={keep === choice ? "default" : "secondary"}
                className="clip-corner-lg touch:h-11"
                disabled={busy}
                onClick={() => setKeep(choice)}
              >
                {choice === "active"
                  ? <FormattedMessage id="approvalGate.keepActiveShort" defaultMessage="Active members" />
                  : <FormattedMessage id="approvalGate.keepAll" defaultMessage="Everyone" />}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {keep === "active"
              ? <FormattedMessage id="approvalGate.keepActiveHint" defaultMessage="Posted in the last {days} days, or holds a role." values={{ days: ACTIVE_WINDOW_DAYS }} />
              : <FormattedMessage id="approvalGate.keepAllHint" defaultMessage="Every current member keeps posting; only people who join later wait." />}
          </p>
        </div>

        <div className="mt-5 space-y-2">
          <p className="text-sm font-medium">
            <FormattedMessage id="approvalGate.welcomeLabel" defaultMessage="Welcome channel" />
          </p>
          <Select value={welcome} onValueChange={setWelcome} disabled={busy}>
            <SelectTrigger className="clip-corner-lg" aria-label={intl.formatMessage({ id: "approvalGate.welcomeLabel", defaultMessage: "Welcome channel" })}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_WELCOME}>
                <FormattedMessage id="approvalGate.welcomeNone" defaultMessage="None" />
              </SelectItem>
              {welcomeChoices.map((c) => (
                <SelectItem key={c.idHex} value={c.idHex}>#{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            <FormattedMessage id="approvalGate.welcomeHint" defaultMessage="Anyone can still post there, so newcomers can ask to be approved." />
          </p>
        </div>

        <div className="mt-5 flex items-center justify-center gap-2 text-center text-sm">
          <Users className="size-4 shrink-0 text-muted-foreground" />
          <FormattedMessage
            id="approvalGate.counts"
            defaultMessage="{grant, plural, one {# keeps posting} other {# keep posting}} · {waiting, plural, one {# waits for approval} other {# wait for approval}}"
            values={{ grant: plan.grant.length, waiting: plan.waiting }}
          />
          <InfoTip>
            <FormattedMessage
              id="approvalGate.keysInfo"
              defaultMessage="Afterwards each channel's posting key goes to every member who keeps posting. Your device sends them as it goes; in a large community that takes a while, so keep the page open."
            />
          </InfoTip>
        </div>
        {plan.unreachable.length > 0 && !busy && (
          <p className="mt-2 text-center text-xs text-warning">
            <FormattedMessage
              id="approvalGate.unreachable"
              defaultMessage="{count, plural, one {# member ranks at or above you, so you can't give them Verified. Unless one of their roles can send messages, they stop posting until someone above them does.} other {# members rank at or above you, so you can't give them Verified. Unless one of their roles can send messages, they stop posting until someone above them does.}}"
              values={{ count: plan.unreachable.length }}
            />
          </p>
        )}
        {busy && progress && (
          <p className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            <Loader2 className="size-3.5 animate-spin" />
            <FormattedMessage id="approvalGate.progress" defaultMessage="Publishing {done} of {total}. Keep this page open." values={progress} />
          </p>
        )}

        <ChromeDialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            <FormattedMessage {...common.cancel} />
          </Button>
          <Button type="button" disabled={busy} onClick={() => void confirm()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            <FormattedMessage id="approvalGate.onConfirm" defaultMessage="Turn on" />
          </Button>
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}

function TurnOffDialog({ onClose, turnOff }: { onClose: () => void; turnOff: () => Promise<void> }) {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      await turnOff();
      toast({ title: t({ id: "approvalGate.offDone", defaultMessage: "Anyone can post again" }) });
      onClose();
    } catch (e) {
      toast({
        title: t({ id: "approvalGate.offFailed", defaultMessage: "Couldn't turn approval off" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <ChromeDialogContent title={intl.formatMessage({ id: "approvalGate.offTitle", defaultMessage: "Let everyone post again?" })}>
        <ChromeDialogHeader
          icon={UserCheck}
          tone="warning"
          title={<FormattedMessage id="approvalGate.offTitle" defaultMessage="Let everyone post again?" />}
          description={
            <FormattedMessage
              id="approvalGate.offDescription"
              defaultMessage="Everyone waiting for approval will be able to post right away. The Verified role stays, so turning approval back on later is quick."
            />
          }
        />
        <ChromeDialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            <FormattedMessage {...common.cancel} />
          </Button>
          <Button type="button" disabled={busy} onClick={() => void confirm()}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            <FormattedMessage id="approvalGate.offConfirm" defaultMessage="Turn off" />
          </Button>
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}
