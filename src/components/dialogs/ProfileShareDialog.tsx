import QRCode from "qrcode";
import { Check, Copy, Link2, Loader2, Share2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { useAuthor } from "@/hooks/useAuthor";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "@/hooks/useToast";
import { common, FormattedMessage, t, useIntl } from "@/i18n";
import { getAvatarShape } from "@/lib/avatarShape";
import { writeClipboardText } from "@/lib/clipboard";
import { getThemedQRColors } from "@/lib/qrColors";
import { tryNpubEncode } from "@/lib/safeNip19";
import { canShare, share as nativeShare } from "@/lib/share";
import { shareOrigin } from "@/lib/shareOrigin";
import { AvatarInitial } from "@/components/AvatarInitial";

interface ProfileShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Profile QR + link. Uses {@link shareOrigin} so it works on native, where the
 * WebView origin is unreachable. QR tinted via {@link getThemedQRColors}.
 */
export function ProfileShareDialog({ open, onOpenChange }: ProfileShareDialogProps) {
  const intl = useIntl();
  const { user } = useCurrentUser();
  const author = useAuthor(user?.pubkey);
  const metadata = author.data?.metadata;
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");

  const npub = tryNpubEncode(user?.pubkey);
  const displayName = metadata?.name || metadata?.display_name ||
    intl.formatMessage({ id: "profileShareDialog.yourProfile", defaultMessage: "your profile" });
  const url = npub ? `${shareOrigin()}/${npub}` : "";

  useEffect(() => {
    if (!url || !open) return;
    // Read at open time so a theme switch is reflected.
    const { dark, light } = getThemedQRColors();
    // SVG, not canvas: fingerprint blockers (Brave, Tor, resistFingerprinting)
    // poison canvas readback and would blank the QR. Loaded via data URL, so it's script-sandboxed.
    QRCode.toString(url, {
      type: "svg",
      width: 400,
      margin: 2,
      color: { dark, light },
      errorCorrectionLevel: "M",
    })
      .then((svg) => setQrDataUrl(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`))
      .catch(() => setQrDataUrl(""));
  }, [url, open]);

  const copy = () => {
    if (!url) return;
    writeClipboardText(url).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => toast({ title: t({ id: "profileShareDialog.copyFailed", defaultMessage: "Copy failed" }), variant: "destructive" }),
    );
  };

  const share = () => {
    if (!url) return;
    void nativeShare({
      title: t({ id: "profileShareDialog.shareTitle", defaultMessage: "{name} on Armada" }, { name: displayName }),
      text: t({ id: "profileShareDialog.shareText", defaultMessage: "Find me on Armada" }),
      url,
    });
  };

  const showShare = canShare();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={intl.formatMessage({ id: "profileShareDialog.title", defaultMessage: "Share your profile" })}
        // Stop Radix auto-focusing the link button.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <Avatar shape={getAvatarShape(metadata)} className="size-14 ring-2 ring-primary/20">
            <AvatarImage src={metadata?.picture} imeta={author.data?.imeta?.picture} alt={displayName} />
            <AvatarFallback className="text-lg font-semibold">
              <AvatarInitial name={displayName} pubkey={user?.pubkey} />
            </AvatarFallback>
          </Avatar>
          <h2 className="chrome-dialog-title font-mono font-bold lowercase tracking-tight text-foreground">
            <FormattedMessage id="profileShareDialog.heading" defaultMessage="share your profile" />
          </h2>
          <p className="text-sm text-muted-foreground">
            <FormattedMessage
              id="profileShareDialog.intro"
              defaultMessage="Scan or share this link to open <hl>{name}</hl> in Armada."
              values={{ name: displayName, hl: (chunks) => <span className="text-foreground">{chunks}</span> }}
            />
          </p>
        </div>

        <div className="mt-6 space-y-4 min-w-0">
          {!url ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />{" "}
              <FormattedMessage id="profileShareDialog.preparing" defaultMessage="Preparing your link…" />
            </div>
          ) : (
            <>
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={intl.formatMessage({ id: "profileShareDialog.qrAlt", defaultMessage: "Profile QR code" })}
                  className="mx-auto w-64 clip-corner-lg"
                  decoding="async"
                />
              ) : (
                <div className="mx-auto size-64 clip-corner-lg bg-muted animate-pulse" />
              )}

              <button
                type="button"
                onClick={copy}
                className="group w-full min-w-0 max-w-full overflow-hidden flex items-center gap-2 clip-corner-lg bg-background/40 px-3 py-3 text-left transition-colors hover:bg-background/70"
              >
                <Link2 className="size-4 shrink-0 text-muted-foreground" />
                <span className="flex-1 min-w-0 truncate font-mono text-sm">{url}</span>
                {copied
                  ? <Check className="size-4 shrink-0 text-primary" />
                  : <Copy className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />}
              </button>

              <div className="flex gap-2">
                <Button className="flex-1 clip-corner-lg" onClick={copy}>
                  {copied
                    ? <><Check className="size-4 mr-2" /> <FormattedMessage {...common.copied} /></>
                    : <><Copy className="size-4 mr-2" /> <FormattedMessage {...common.copyLink} /></>}
                </Button>
                {showShare && (
                  <Button variant="outline" className="clip-corner-lg" onClick={share} aria-label={intl.formatMessage(common.share)}>
                    <Share2 className="size-4" />
                  </Button>
                )}
              </div>
            </>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}
