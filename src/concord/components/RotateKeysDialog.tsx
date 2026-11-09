import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ChromeDialogContent, ChromeDialogFooter, ChromeDialogHeader, Dialog } from "@/components/ui/dialog";
import { common, FormattedMessage, t, useIntl } from "@/i18n";

interface RotateKeysDialogProps {
  open: boolean;
  memberCount: number;
  privateChannelCount: number;
  /** A live invite link belongs to someone else (it goes stale). */
  strandsForeignLinks: boolean;
  /** Framed as the legacy upgrade (CORD-06 §3): the same Refounding, which mints the split Control Plane. */
  upgrade?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

/** Standalone rotation (Refounding excluding nobody). Stays up while it runs; 30s grace re-enables Cancel. */
export function RotateKeysDialog({
  open,
  memberCount,
  privateChannelCount,
  strandsForeignLinks,
  upgrade = false,
  onClose,
  onConfirm,
}: RotateKeysDialogProps) {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setError(null);
    setStuck(false);
  }, [open]);

  useEffect(() => {
    if (!busy) {
      setStuck(false);
      return;
    }
    const t = setTimeout(() => setStuck(true), 30_000);
    return () => clearTimeout(t);
  }, [busy]);

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
      setBusy(false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t({ id: "rotateKeysDialog.error", defaultMessage: "Couldn't rotate the keys." }));
      setBusy(false);
    }
  };

  const close = () => {
    if (busy && !stuck) return;
    setBusy(false);
    setError(null);
    setStuck(false);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <ChromeDialogContent
        title={
          upgrade
            ? intl.formatMessage({ id: "rotateKeysDialog.upgradeTitle", defaultMessage: "Upgrade security?" })
            : intl.formatMessage({ id: "rotateKeysDialog.title", defaultMessage: "Rotate this community's keys?" })
        }
        className="sm:max-w-sm"
      >
        <ChromeDialogHeader
          icon={upgrade ? ShieldCheck : KeyRound}
          tone="warning"
          title={
            upgrade
              ? intl.formatMessage({ id: "rotateKeysDialog.upgradeHeading", defaultMessage: "upgrade security?" })
              : intl.formatMessage({ id: "rotateKeysDialog.heading", defaultMessage: "rotate keys?" })
          }
          description={
            upgrade
              ? intl.formatMessage({
                  id: "rotateKeysDialog.upgradeDescription",
                  defaultMessage: "This community uses an older, less secure format. Upgrading rotates its keys.",
                })
              : intl.formatMessage({
                  id: "rotateKeysDialog.description",
                  defaultMessage:
                    "New messages are encrypted to new keys. Old keys still read the history they already unlocked, and nothing after.",
                })
          }
        />

        {!upgrade && (
          <ul className="mt-5 space-y-1 text-sm text-muted-foreground">
            <li>
              <FormattedMessage
                id="rotateKeysDialog.members"
                defaultMessage="{count, plural, one {# member keeps access. Nobody is removed.} other {# members keep access. Nobody is removed.}}"
                values={{ count: memberCount }}
              />
            </li>
            {privateChannelCount > 0 && (
              <li>
                <FormattedMessage
                  id="rotateKeysDialog.privateChannels"
                  defaultMessage="{count, plural, one {# private channel is rekeyed alongside it.} other {# private channels are rekeyed alongside it.}}"
                  values={{ count: privateChannelCount }}
                />
              </li>
            )}
          </ul>
        )}

        {strandsForeignLinks && (
          <p className="mt-3 text-sm text-destructive">
            <FormattedMessage
              id="rotateKeysDialog.foreignLinks"
              defaultMessage="Other members' invite links will stop working until they next open the app."
            />
          </p>
        )}

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
        {stuck && busy && (
          <p className="mt-3 text-sm text-muted-foreground">
            <FormattedMessage
              id="rotateKeysDialog.stuck"
              defaultMessage="This is taking longer than expected. Your signer may be slow or offline. You can close this and try again. A rotation that already landed is picked up automatically."
            />
          </p>
        )}

        <ChromeDialogFooter>
          <Button type="button" variant="ghost" onClick={close} disabled={busy && !stuck}>
            {busy && stuck ? <FormattedMessage {...common.close} /> : <FormattedMessage {...common.cancel} />}
          </Button>
          <Button type="button" variant="destructive" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : upgrade ? <ShieldCheck className="size-4" /> : <KeyRound className="size-4" />}
            {busy ? (
              upgrade ? (
                <FormattedMessage id="rotateKeysDialog.upgrading" defaultMessage="Upgrading" />
              ) : (
                <FormattedMessage id="rotateKeysDialog.rotating" defaultMessage="Rotating" />
              )
            ) : upgrade ? (
              <FormattedMessage id="rotateKeysDialog.upgradeConfirm" defaultMessage="Upgrade" />
            ) : (
              <FormattedMessage id="rotateKeysDialog.confirm" defaultMessage="Rotate keys" />
            )}
          </Button>
        </ChromeDialogFooter>
      </ChromeDialogContent>
    </Dialog>
  );
}
