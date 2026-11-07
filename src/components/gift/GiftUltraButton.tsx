import { Check, Gift, Link2, Send } from "lucide-react";
import { useState, type ReactNode } from "react";

import { GiftBox } from "@/components/gift/GiftBox";
import { GiftStage } from "@/components/gift/GiftStage";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/hooks/useToast";
import { useUltraGift } from "@/hooks/useUltraGift";
import { common, FormattedMessage, useIntl } from "@/i18n";
import { writeClipboardText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

/** The one way to gift Ultra: a button that opens the gift dialog. */
export function GiftUltraButton({ className, size = "lg", children }: {
  className?: string;
  size?: "default" | "lg";
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size={size}
        onClick={() => setOpen(true)}
        className={cn(
          "group relative overflow-hidden bg-gradient-to-r from-primary via-fuchsia-500 to-accent2 font-semibold text-white shadow-lg shadow-primary/30 hover:brightness-110",
          className,
        )}
      >
        <span aria-hidden className="absolute inset-y-0 -left-1/3 w-1/4 -skew-x-12 bg-white/25 transition-transform duration-700 group-hover:translate-x-[600%]" />
        <Gift className="relative size-4 mr-2" />
        <span className="relative">{children ?? <FormattedMessage id="giftUltra.button" defaultMessage="Gift Ultra" />}</span>
      </Button>
      <GiftUltraDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

export function GiftUltraDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const intl = useIntl();
  const { url, sendToChat } = useUltraGift();
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!url) return;
    writeClipboardText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }, (error: unknown) => {
      toast({
        title: intl.formatMessage(common.error),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm overflow-hidden p-0">
        <div className="relative flex flex-col items-center px-6 pb-6 pt-10 text-center">
          <GiftStage />
          <GiftBox className="relative size-28" />
          <DialogTitle className="relative mt-5 text-2xl font-black tracking-tight">
            <FormattedMessage id="giftUltra.dialogTitle" defaultMessage="Gift Armada Ultra" />
          </DialogTitle>
          <DialogDescription className="relative mt-1 text-sm text-foreground/70">
            <FormattedMessage id="giftUltra.dialogBody" defaultMessage="Anyone with your link can claim it." />
          </DialogDescription>
        </div>
        <div className="grid grid-cols-2 gap-3 px-6 pb-6">
          <GiftOption
            icon={<Send className="size-6" />}
            label={intl.formatMessage({ id: "giftUltra.sendToChat", defaultMessage: "Send to a chat" })}
            onClick={() => {
              onOpenChange(false);
              sendToChat();
            }}
          />
          <GiftOption
            icon={copied ? <Check className="size-6" /> : <Link2 className="size-6" />}
            label={copied
              ? intl.formatMessage({ id: "giftUltra.copied", defaultMessage: "Copied" })
              : intl.formatMessage({ id: "giftUltra.copyLink", defaultMessage: "Copy link" })}
            onClick={copy}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GiftOption({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-2 clip-corner-lg bg-secondary/70 px-3 py-5 text-sm font-semibold transition-colors hover:bg-secondary"
    >
      <span className="flex size-12 items-center justify-center clip-corner-lg bg-gradient-to-br from-primary to-accent2 text-white shadow-md shadow-primary/30">
        {icon}
      </span>
      {label}
    </button>
  );
}
