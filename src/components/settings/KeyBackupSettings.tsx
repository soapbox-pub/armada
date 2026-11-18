import { Capacitor } from "@capacitor/core";
import { Check, Copy, Download, Eye, EyeOff, Lock, Share2, ShieldAlert } from "lucide-react";
import { nip19 } from "nostr-tools";
import { useEffect, useState } from "react";

import { SettingsRow } from "@/components/settings/SettingsSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { writeClipboardText } from "@/lib/clipboard";
import { saveNsec } from "@/lib/credentialManager";
import { desktopSecretsStatus, isDesktop } from "@/lib/desktop";
import { clearKeyBackupPending } from "@/lib/keyBackup";
import { share } from "@/lib/share";

import type { SecretsStatus } from "@/lib/desktop";

/**
 * Desktop key-at-rest storage. `basic_text` is Chromium's no-keyring
 * fallback (obfuscated, not encrypted); say so rather than claim protection.
 */
function KeyStorageRow() {
  const intl = useIntl();
  const [status, setStatus] = useState<SecretsStatus | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    desktopSecretsStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isDesktop() || !status) return null;

  const encrypted = status.available && status.backend !== "basic_text";

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "keyBackupSettings.storage", defaultMessage: "Storage on this device" })}
      description={
        encrypted
          ? intl.formatMessage({ id: "keyBackupSettings.storageEncrypted", defaultMessage: "Encrypted by your system's credential store." })
          : status.available
            ? intl.formatMessage({ id: "keyBackupSettings.storageObfuscated", defaultMessage: "Only obfuscated on disk." })
            : intl.formatMessage({ id: "keyBackupSettings.storageUnencrypted", defaultMessage: "Stored unencrypted on this device." })
      }
      info={
        !encrypted && status.available
          ? intl.formatMessage({ id: "keyBackupSettings.storageInfo", defaultMessage: "No system keyring was found, so your key is only obfuscated on disk. Installing a keyring (GNOME Keyring or KWallet) enables real encryption." })
          : undefined
      }
    >
      {encrypted ? (
        <Lock className="size-4 text-success" aria-label={intl.formatMessage({ id: "keyBackupSettings.encrypted", defaultMessage: "Encrypted" })} />
      ) : (
        <ShieldAlert className="size-4 text-warning" aria-label={intl.formatMessage({ id: "keyBackupSettings.notEncrypted", defaultMessage: "Not encrypted" })} />
      )}
    </SettingsRow>
  );
}

interface KeyBackupSettingsProps {
  nsec: string;
  pubkey: string;
}

/** Reveal/copy/download the secret key. Only rendered for nsec logins. */
export function KeyBackupSettings({ nsec, pubkey }: KeyBackupSettingsProps) {
  const intl = useIntl();
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState<"nsec" | "npub" | null>(null);
  const npub = nip19.npubEncode(pubkey);

  const copy = async (text: string, which: "nsec" | "npub") => {
    try {
      await writeClipboardText(text);
      setCopied(which);
      if (which === "nsec") clearKeyBackupPending(pubkey);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      toast({
        title: t({ id: "keyBackupSettings.copyFailed", defaultMessage: "Copy failed" }),
        description: t({ id: "keyBackupSettings.copyFailedDescription", defaultMessage: "Could not copy to the clipboard. Please select and copy it manually." }),
        variant: "destructive",
      });
    }
  };

  // Native WebViews can't do blob downloads, so use the share sheet.
  const backup = async () => {
    try {
      if (Capacitor.isNativePlatform()) {
        await share({
          title: t({ id: "keyBackupSettings.shareTitle", defaultMessage: "Armada secret key" }),
          text: nsec,
          dialogTitle: t({ id: "keyBackupSettings.shareDialogTitle", defaultMessage: "Back up your secret key" }),
        });
      } else {
        await saveNsec(npub, nsec);
      }
      // Neither path reports a cancel; a deliberate backup from here counts.
      clearKeyBackupPending(pubkey);
    } catch {
      toast({
        title: t({ id: "keyBackupSettings.backupFailed", defaultMessage: "Backup failed" }),
        description: t({ id: "keyBackupSettings.backupFailedDescription", defaultMessage: "Could not save the key. Please copy it manually." }),
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <SettingsRow>
        <div className="clip-corner-lg bg-warning/10 p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-warning">
              <FormattedMessage id="keyBackupSettings.warningTitle" defaultMessage="Keep this key secret" />
            </span>
          </div>
          <p className="text-xs text-warning">
            <FormattedMessage
              id="keyBackupSettings.warning"
              defaultMessage="It's the only way into your account, with no reset, and anyone who sees it controls your identity. Keep it in a password manager."
            />
          </p>
        </div>
      </SettingsRow>

      <SettingsRow>
        <div className="space-y-2">
          <div className="text-sm font-medium leading-tight">
            <FormattedMessage id="keyBackupSettings.secretKey" defaultMessage="Secret key" />
          </div>
          <div className="relative">
            <Input
              type={showKey ? "text" : "password"}
              value={nsec}
              readOnly
              className="pr-10 font-mono"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
              onClick={() => setShowKey(!showKey)}
              aria-label={showKey
                ? intl.formatMessage({ id: "keyBackupSettings.hideKey", defaultMessage: "Hide secret key" })
                : intl.formatMessage({ id: "keyBackupSettings.revealKey", defaultMessage: "Reveal secret key" })}
            >
              {showKey ? (
                <EyeOff className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Eye className="h-4 w-4 text-muted-foreground" />
              )}
            </Button>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1 clip-corner-lg"
              onClick={() => copy(nsec, "nsec")}
            >
              {copied === "nsec" ? (
                <Check className="size-4 text-success" />
              ) : (
                <Copy className="size-4" />
              )}
              <FormattedMessage {...common.copy} />
            </Button>
            <Button variant="secondary" className="flex-1 clip-corner-lg" onClick={backup}>
              {Capacitor.isNativePlatform() ? (
                <Share2 className="size-4" />
              ) : (
                <Download className="size-4" />
              )}
              <FormattedMessage id="keyBackupSettings.backUp" defaultMessage="Back up" />
            </Button>
          </div>
        </div>
      </SettingsRow>

      <KeyStorageRow />

      <SettingsRow
        label={intl.formatMessage({ id: "keyBackupSettings.publicKey", defaultMessage: "Public key" })}
        description={intl.formatMessage({ id: "keyBackupSettings.publicKeyDescription", defaultMessage: "Your public identity, safe to share with anyone." })}
      >
        <Button
          variant="ghost"
          size="icon"
          className="size-9 touch:size-11"
          onClick={() => copy(npub, "npub")}
          aria-label={intl.formatMessage({ id: "keyBackupSettings.copyPublicKey", defaultMessage: "Copy public key" })}
        >
          {copied === "npub" ? (
            <Check className="size-4 text-success" />
          ) : (
            <Copy className="size-4" />
          )}
        </Button>
      </SettingsRow>
    </>
  );
}
