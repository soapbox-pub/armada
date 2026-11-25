import { DoorOpen, Loader2, ShieldAlert, UserCheck, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { InfoTip, SettingsGroup, SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useApprovalGate } from "@/concord/hooks/useApprovalGate";
import { adoptableRoles, carriedOver } from "@/concord/lib/approvalGate";
import type { FoldedControl } from "@/concord/lib/control";
import { PERMISSION_LABELS, Permissions } from "@/concord/lib/roles";
import type { Channel, Community } from "@/concord/lib/types";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { clockNowMs } from "@/lib/relayClock";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WINDOW_DAYS = 30;
const NO_WELCOME = "none";
/** The role picker's "make one" choice; role ids are hex, so it can't collide. */
const CREATE_ROLE = "create";

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
            : gate.restricted
              ? intl.formatMessage({ id: "approvalGate.restrictedRow", defaultMessage: "Off. Everyone already can't send messages, so only members whose roles let them can post. That's set under Roles." })
            : gate.canSwitch
              ? intl.formatMessage({ id: "approvalGate.offRow", defaultMessage: "New members can post as soon as they join." })
              : intl.formatMessage({ id: "approvalGate.needsManageRoles", defaultMessage: "Changing this needs the Manage roles permission." })
        }
        info={intl.formatMessage({
          id: "approvalGate.descriptionRole",
          defaultMessage: "New members can read, but can't post, react, start threads, share files or join voice channels until a moderator approves them. Approving gives them the role that lets members post. A banned member coming back on a new account has to be approved again.",
        })}
      >
        <Switch
          checked={gate.on}
          disabled={!gate.canSwitch || gate.switching}
          onCheckedChange={(next) => setDialog(next ? "on" : "off")}
          aria-label={intl.formatMessage({ id: "approvalGate.title", defaultMessage: "Require approval to post" })}
        />
      </SettingsRow>
      {gate.on && (
        <WelcomeRow
          channels={channels}
          folded={folded}
          welcome={gate.welcome}
          canChange={gate.canSwitch && !gate.switching}
          setWelcome={gate.setWelcome}
        />
      )}
      {gate.leaves !== 0n && (
        <LeavesRow leaves={gate.leaves} canChange={gate.canTighten && !gate.switching} busy={gate.switching} tighten={gate.tighten} />
      )}
      {gate.progress && !dialog && <ProgressRow progress={gate.progress} />}

      {dialog === "on" && (
        <TurnOnDialog
          folded={folded}
          channels={channels}
          members={members}
          observed={observed}
          onClose={() => setDialog(null)}
          turnOn={gate.turnOn}
          progress={gate.progress}
        />
      )}
      {dialog === "off" && <TurnOffDialog restorable={gate.restorable} onClose={() => setDialog(null)} turnOff={gate.turnOff} />}
    </SettingsGroup>
  );
}

/** Channels a welcome overwrite can open: a synced one takes its Category's rules, and a Private one is closed to @everyone. */
function welcomeCandidates(channels: Channel[], folded: FoldedControl): Channel[] {
  return channels.filter((c) => !c.isPrivate && !folded.roster.syncs?.[c.idHex.toLowerCase()]);
}

function WelcomeRow({
  channels,
  folded,
  welcome,
  canChange,
  setWelcome,
}: {
  channels: Channel[];
  folded: FoldedControl;
  welcome: string[];
  canChange: boolean;
  setWelcome: (open: string | null, close?: string) => Promise<void>;
}) {
  const intl = useIntl();
  const choices = useMemo(() => welcomeCandidates(channels, folded), [channels, folded]);
  const current = welcome[0] ?? NO_WELCOME;

  const change = (value: string) => {
    // Only the Channel shown is replaced: another one open to @everyone was opened for its own reasons.
    setWelcome(value === NO_WELCOME ? null : value, welcome[0]).catch((e: unknown) =>
      toast({
        title: t({ id: "approvalGate.welcomeFailed", defaultMessage: "Couldn't change the welcome channel" }),
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      }),
    );
  };

  return (
    <SettingsRow
      icon={DoorOpen}
      tone="success"
      stack
      label={intl.formatMessage({ id: "approvalGate.welcomeLabel", defaultMessage: "Welcome channel" })}
      description={intl.formatMessage({ id: "approvalGate.welcomeHint", defaultMessage: "Anyone can still post there, so newcomers can ask to be approved." })}
    >
      <Select value={current} onValueChange={change} disabled={!canChange}>
        <SelectTrigger className="w-full clip-corner-lg sm:w-44" aria-label={intl.formatMessage({ id: "approvalGate.welcomeLabel", defaultMessage: "Welcome channel" })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={NO_WELCOME}>
            <FormattedMessage id="approvalGate.welcomeNone" defaultMessage="None" />
          </SelectItem>
          {choices.map((c) => (
            <SelectItem key={c.idHex} value={c.idHex}>#{c.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}

/** Shown on a gate that left `@everyone` reacting or joining calls: one step takes that and gives it to whoever posts. */
function LeavesRow({ leaves, canChange, busy, tighten }: { leaves: bigint; canChange: boolean; busy: boolean; tighten: () => Promise<{ unreachable: string[] }> }) {
  const intl = useIntl();
  const open = leaves === Permissions.ADD_REACTIONS ? "reactions" : leaves === Permissions.CONNECT ? "voice" : "both";

  const hold = () => {
    tighten()
      .then(({ unreachable }) =>
        toast({
          title: t({ id: "approvalGate.leavesDone", defaultMessage: "Waiting members are held back" }),
          description: unreachable.length > 0
            ? t(
                { id: "approvalGate.leavesDoneUnreachable", defaultMessage: "{count, plural, one {# member who posts through another role couldn't be given the role that keeps this; someone ranked above them has to.} other {# members who post through another role couldn't be given the role that keeps this; someone ranked above them has to.}}" },
                { count: unreachable.length },
              )
            : undefined,
        }),
      )
      .catch((e: unknown) =>
        toast({
          title: t({ id: "approvalGate.leavesFailed", defaultMessage: "Couldn't hold waiting members back" }),
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
      );
  };

  return (
    <SettingsRow
      icon={ShieldAlert}
      tone="warning"
      stack
      label={intl.formatMessage({ id: "approvalGate.leavesLabel", defaultMessage: "Waiting members can do more than read" })}
      description={intl.formatMessage(
        { id: "approvalGate.leavesHint", defaultMessage: "{open, select, reactions {Members waiting for approval can still add reactions. Holding that back leaves it to members who can post.} voice {Members waiting for approval can still join voice channels. Holding that back leaves it to members who can post.} other {Members waiting for approval can still add reactions and join voice channels. Holding those back leaves them to members who can post.}}" },
        { open },
      )}
    >
      <Button type="button" variant="secondary" className="clip-corner-lg touch:h-11" disabled={!canChange} onClick={hold}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        <FormattedMessage id="approvalGate.leavesAction" defaultMessage="Hold back" />
      </Button>
    </SettingsRow>
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
  folded,
  channels,
  members,
  observed,
  onClose,
  turnOn,
  progress,
}: {
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
  // An existing Verified, as a gate bot or an earlier switch left, is the way in by default.
  const adoptable = useMemo(() => (user ? adoptableRoles(folded, user.pubkey) : []), [folded, user]);
  const [role, setRole] = useState<string>(() => {
    const verified = adoptable.find((r) => r.name.trim().toLowerCase() === "verified");
    return verified ? verified.roleId : CREATE_ROLE;
  });

  const welcomeChoices = useMemo(() => welcomeCandidates(channels, folded), [channels, folded]);
  // Read once per open, so the counts don't shift while the reader decides.
  const [nowMs] = useState(clockNowMs);
  const activeSinceMs = keep === "everyone" ? 0 : nowMs - ACTIVE_WINDOW_DAYS * DAY_MS;
  const plan = useMemo(
    () => (user ? carriedOver(folded, user.pubkey, members, observed, activeSinceMs, role === CREATE_ROLE ? undefined : role) : { grant: [], unreachable: [], waiting: 0, holding: 0 }),
    [folded, user, members, observed, activeSinceMs, role],
  );

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await turnOn({
        members,
        observed,
        activeSinceMs,
        ...(welcome !== NO_WELCOME ? { welcomeChannel: welcome } : {}),
        role: role === CREATE_ROLE ? { create: true } : { adopt: role },
      });
      toast({
        title: t({ id: "approvalGate.onDone", defaultMessage: "Approval to post is on" }),
        description: result.unreachable.length > 0
          ? t(
              { id: "approvalGate.onDoneUnreachableRole", defaultMessage: "{count, plural, one {# member ranked at or above you couldn't be given the role; someone above them has to.} other {# members ranked at or above you couldn't be given the role; someone above them has to.}}" },
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
            <FormattedMessage id="approvalGate.roleLabel" defaultMessage="Role that lets members post" />
          </p>
          <Select value={role} onValueChange={setRole} disabled={busy}>
            <SelectTrigger className="clip-corner-lg" aria-label={intl.formatMessage({ id: "approvalGate.roleLabel", defaultMessage: "Role that lets members post" })}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {adoptable.map((r) => (
                <SelectItem key={r.roleId} value={r.roleId}>{r.name}</SelectItem>
              ))}
              <SelectItem value={CREATE_ROLE}>
                <FormattedMessage id="approvalGate.createRole" defaultMessage="Create a Verified role" />
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {role === CREATE_ROLE ? (
              <FormattedMessage id="approvalGate.createRoleHint" defaultMessage="Approving someone gives them this new role." />
            ) : (
              <FormattedMessage id="approvalGate.adoptRoleHint" defaultMessage="This role gets permission to post, and approving someone gives it to them. Anything that already hands it out, like a bot, keeps working." />
            )}
          </p>
        </div>

        <div className="mt-5 space-y-2">
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
            values={{ grant: plan.grant.length + plan.holding, waiting: plan.waiting + plan.unreachable.length }}
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
              id="approvalGate.unreachableRole"
              defaultMessage="{count, plural, one {# member ranks at or above you, so you can't give them the role. Unless one of their roles can send messages, they stop posting until someone above them does.} other {# members rank at or above you, so you can't give them the role. Unless one of their roles can send messages, they stop posting until someone above them does.}}"
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

/** What turning off can give `@everyone` back besides Send messages, which it always does. */
const RESTORABLE = [Permissions.SEND_IN_THREADS, Permissions.ATTACH_FILES, Permissions.ADD_REACTIONS, Permissions.CONNECT] as const;

function TurnOffDialog({ restorable, onClose, turnOff }: { restorable: bigint; onClose: () => void; turnOff: (restore: bigint) => Promise<void> }) {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  // Nothing records what @everyone held before approval went on, so the person turning it off says.
  const [restore, setRestore] = useState<bigint>(restorable);
  const labelOf = (bit: bigint) => PERMISSION_LABELS.find((l) => l.bit === bit)?.label ?? "";
  const toggle = (bit: bigint, on: boolean) => setRestore((bits) => (on ? bits | bit : bits & ~bit));

  const confirm = async () => {
    setBusy(true);
    try {
      await turnOff(restore);
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
              id="approvalGate.offDescriptionRole"
              defaultMessage="Everyone waiting for approval will be able to post right away. The role that lets members post stays as it is, so turning approval back on later is quick."
            />
          }
        />
        <div className="mt-6 space-y-3">
          <p className="text-sm font-medium">
            <FormattedMessage id="approvalGate.restoreLabel" defaultMessage="Everyone gets back" />
          </p>
          <label className="flex items-center gap-3 touch:min-h-11">
            <Checkbox checked disabled />
            <span className="text-sm">{labelOf(Permissions.SEND_MESSAGES)}</span>
          </label>
          {RESTORABLE.filter((bit) => (restorable & bit) !== 0n).map((bit) => (
            <label key={String(bit)} className="flex cursor-pointer items-center gap-3 touch:min-h-11">
              <Checkbox checked={(restore & bit) !== 0n} disabled={busy} onCheckedChange={(c) => toggle(bit, c === true)} />
              <span className="text-sm">{labelOf(bit)}</span>
            </label>
          ))}
          <p className="text-xs text-muted-foreground">
            <FormattedMessage id="approvalGate.restoreHint" defaultMessage="Untick anything everyone couldn't do before approval was turned on." />
          </p>
        </div>
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
