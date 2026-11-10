import { Ban, Check, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ChromeDialogContent, Dialog } from "@/components/ui/dialog";
import { RefoundProgressLine } from "@/concord/components/RefoundProgressLine";
import type { BanPhase } from "@/concord/hooks/useModeration";
import type { RefoundProgress } from "@/concord/hooks/useRekey";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { AvatarInitial } from "@/components/AvatarInitial";

interface BanMemberDialogProps {
  /** The pubkeys queued for banning; null keeps the dialog closed. */
  targets: string[] | null;
  /** Members the actor can't act on — shown as skipped, never sent. */
  ineligible?: string[];
  willRotate: boolean;
  onClose: () => void;
  onConfirm: (
    targets: string[],
    onPhase: (phase: BanPhase) => void,
    onStripProgress: (done: number, total: number) => void,
    onRekeyProgress: (progress: RefoundProgress) => void,
  ) => Promise<void>;
}

const PHASE_ORDER: Record<BanPhase, number> = { silence: 0, roles: 1, rekey: 2 };

/**
 * Ban confirmation + progress. Several sequential publishes (banlist, grant
 * strips, and in Private mode a Refounding), so the dialog stays up until all land.
 */
export function BanMemberDialog({ targets, ineligible, willRotate, onClose, onConfirm }: BanMemberDialogProps) {
  const intl = useIntl();
  const [phase, setPhase] = useState<BanPhase | null>(null);
  const [strip, setStrip] = useState<{ done: number; total: number } | null>(null);
  const [rekey, setRekey] = useState<RefoundProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Signer calls have no timeout; after a grace period re-enable Cancel so the
  // user isn't trapped (the ban is idempotent and self-heals).
  const [stuck, setStuck] = useState(false);
  const busy = phase !== null;
  const count = targets?.length ?? 0;

  useEffect(() => {
    setPhase(null);
    setStrip(null);
    setError(null);
    setStuck(false);
  }, [targets]);

  useEffect(() => {
    if (!busy) {
      setStuck(false);
      return;
    }
    const timer = setTimeout(() => setStuck(true), 30_000);
    return () => clearTimeout(timer);
  }, [busy]);

  const steps: Array<{ key: BanPhase; label: string }> = [
    {
      key: "silence",
      label: count > 1
        ? intl.formatMessage({ id: "banMemberDialog.step.blockingMembers", defaultMessage: "Blocking members" })
        : intl.formatMessage({ id: "banMemberDialog.step.blockingMember", defaultMessage: "Blocking member" }),
    },
    {
      key: "roles",
      label:
        strip && strip.total > 1
          ? intl.formatMessage(
            { id: "banMemberDialog.step.removingRolesProgress", defaultMessage: "Removing their roles ({done}/{total})" },
            { done: strip.done, total: strip.total },
          )
          : intl.formatMessage({ id: "banMemberDialog.step.removingRoles", defaultMessage: "Removing their roles" }),
    },
    ...(willRotate
      ? [{ key: "rekey" as BanPhase, label: intl.formatMessage({ id: "banMemberDialog.step.lockingOut", defaultMessage: "Locking them out" }) }]
      : []),
  ];

  const run = async () => {
    if (!targets || targets.length === 0) return;
    setError(null);
    setPhase("silence");
    setRekey(null);
    try {
      await onConfirm(targets, setPhase, (done, total) => setStrip({ done, total }), setRekey);
      setPhase(null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "banMemberDialog.error", defaultMessage: "Couldn't ban." }));
      setPhase(null);
    }
  };

  const close = () => {
    if (busy && !stuck) return;
    setPhase(null);
    setStrip(null);
    setError(null);
    setStuck(false);
    onClose();
  };

  return (
    <Dialog open={targets !== null && targets.length > 0} onOpenChange={(open) => !open && close()}>
      <ChromeDialogContent
        title={count > 1
          ? intl.formatMessage({ id: "banMemberDialog.titleMany", defaultMessage: "Ban members" })
          : intl.formatMessage({ id: "banMemberDialog.titleOne", defaultMessage: "Ban member" })}
        className="sm:max-w-sm focus:outline-none"
        onOpenAutoFocus={(e) => {
          // Keep initial focus off Cancel (paints a ring on open); focus stays trapped.
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center clip-corner-lg bg-destructive/15 text-destructive">
            <Ban className="size-6" />
          </div>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            {count > 1
              ? <FormattedMessage id="banMemberDialog.headingMany" defaultMessage="ban {count} members?" values={{ count }} />
              : <FormattedMessage id="banMemberDialog.headingOne" defaultMessage="ban member?" />}
          </h2>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage
              id="banMemberDialog.description"
              defaultMessage="They will be removed and silenced for everyone in this community."
            />
          </p>
        </div>

        {targets && targets.length > 0 && (
          <ul className="mt-5 max-h-40 space-y-1 overflow-y-auto text-sm">
            {targets.map((pk) => (
              <TargetRow key={pk} pubkey={pk} />
            ))}
          </ul>
        )}
        {ineligible && ineligible.length > 0 && (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            <FormattedMessage
              id="banMemberDialog.skipped"
              defaultMessage="{count, plural, one {# selected member is} other {# selected members are}} skipped. You don't outrank them."
              values={{ count: ineligible.length }}
            />
          </p>
        )}

        {busy && (
          <ul className="mt-4 space-y-1.5 text-sm" aria-live="polite">
            {steps.map((step) => {
              const state =
                PHASE_ORDER[phase] > PHASE_ORDER[step.key]
                  ? "done"
                  : phase === step.key
                    ? "active"
                    : "pending";
              return (
                <li key={step.key} className="flex items-center gap-2">
                  {state === "done" ? (
                    <Check className="size-4 text-success" />
                  ) : state === "active" ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : (
                    <span className="size-4 rounded-full border border-muted-foreground/40" />
                  )}
                  <span className={state === "pending" ? "text-muted-foreground" : undefined}>
                    {step.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {phase === "rekey" && <RefoundProgressLine progress={rekey} className="mt-3" />}

        {error && <p className="mt-4 text-center text-sm text-destructive">{error}</p>}
        {stuck && busy && (
          <p className="mt-4 text-sm text-muted-foreground">
            <FormattedMessage
              id="banMemberDialog.stuck"
              defaultMessage="This is taking longer than expected. Your signer may be slow or offline. You can close this and try again; anything already sent will finish on its own."
            />
          </p>
        )}

        <div className="mt-6 flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            className="flex-1 clip-corner-lg"
            onClick={close}
            disabled={busy && !stuck}
          >
            {busy && stuck ? <FormattedMessage {...common.close} /> : <FormattedMessage {...common.cancel} />}
          </Button>
          <Button type="button" variant="destructive" className="flex-1 clip-corner-lg" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
            {busy
              ? <FormattedMessage id="banMemberDialog.banning" defaultMessage="Banning" />
              : count > 1
                ? <FormattedMessage id="banMemberDialog.confirmMany" defaultMessage="Ban {count} members" values={{ count }} />
                : <FormattedMessage id="banMemberDialog.titleOne" defaultMessage="Ban member" />}
          </Button>
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}

function TargetRow({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    <li className="flex items-center gap-2">
      <Avatar className="size-5 shrink-0">
        <AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} />
        <AvatarFallback className="bg-primary/20 text-monogram text-primary">
          <AvatarInitial name={name} pubkey={pubkey} />
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate">
        <DisplayName pubkey={pubkey} name={name} />
      </span>
    </li>
  );
}
