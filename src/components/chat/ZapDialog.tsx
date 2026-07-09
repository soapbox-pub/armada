import { lazy, Suspense } from "react";

import { Dialog, DialogContent } from "@/components/ui/dialog";

import type { ChatMsg, ZapPayment } from "@/components/chat/transport";

/**
 * Lazy shell for the zap dialog: the trigger (a toolbar button) renders with
 * zero cost, and the payment machinery (@getalby/sdk, bolt11 decoding, QR)
 * loads only when a dialog actually opens.
 */
const LazyZapDialogImpl = lazy(() => import("@/components/chat/ZapDialogImpl"));

export interface ZapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ChatMsg;
  /** CORD.md announcement publisher (Concord v2); absent = NIP-57 surface. */
  sendZap?: (target: ChatMsg, payment: ZapPayment) => Promise<void>;
}

export function ZapDialog({ open, onOpenChange, target, sendZap }: ZapDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && (
          <Suspense fallback={<div className="h-64" />}>
            <LazyZapDialogImpl target={target} sendZap={sendZap} onDone={() => onOpenChange(false)} />
          </Suspense>
        )}
      </DialogContent>
    </Dialog>
  );
}
