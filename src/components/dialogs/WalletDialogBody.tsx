import { Check, ChevronDown, Copy, RefreshCw } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, ChromeDialogContent } from "@/components/ui/dialog";
import { QRCodeCanvas } from "@/components/ui/qrcode";
import { useBitcoinWallet } from "@/hooks/useBitcoinWallet";
import { common, FormattedMessage, useIntl, type IntlShape } from "@/i18n";
import { satsToUSD, formatBTC } from "@/lib/bitcoin";
import { writeClipboardText } from "@/lib/clipboard";

export interface WalletDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WalletDialogBody({ open, onOpenChange }: WalletDialogProps) {
  const intl = useIntl();
  // Rendered unconditionally by the parent, so gate queries on `open` or they poll Esplora all session.
  const { bitcoinAddress, addressData, btcPrice, transactions, isLoading, error, refetch } = useBitcoinWallet({ enabled: open });
  const [copiedAddress, setCopiedAddress] = useState(false);

  const copyAddress = () => {
    if (!bitcoinAddress) return;
    void writeClipboardText(bitcoinAddress);
    setCopiedAddress(true);
    setTimeout(() => setCopiedAddress(false), 2000);
  };

  const truncatedAddress = bitcoinAddress
    ? `${bitcoinAddress.slice(0, 12)}...${bitcoinAddress.slice(-8)}`
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ChromeDialogContent
        title={intl.formatMessage({ id: "walletDialog.title", defaultMessage: "Wallet" })}
        className="max-w-[95vw] sm:max-w-sm"
        contentClassName="max-h-[90dvh] overflow-y-auto"
      >
        <div className="flex flex-col items-center px-1 pt-2 pb-4 space-y-5">
          {isLoading ? (
            <div className="flex flex-col items-center space-y-2">
              <Skeleton className="h-10 w-40 rounded-lg" />
              <Skeleton className="h-4 w-24 rounded" />
            </div>
          ) : error ? (
            <div className="text-center space-y-3">
              <p className="text-sm text-destructive">
                <FormattedMessage id="walletDialog.loadFailed" defaultMessage="Failed to load balance" />
              </p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                <RefreshCw className="size-3.5 mr-1.5" />
                <FormattedMessage {...common.retry} />
              </Button>
            </div>
          ) : addressData ? (
            <div className="flex flex-col items-center space-y-1">
              <span className="text-4xl font-bold tracking-tight">
                {btcPrice ? satsToUSD(addressData.totalBalance, btcPrice) : "---"}
              </span>
              <span className="text-sm text-muted-foreground">
                {formatBTC(addressData.totalBalance)} BTC
              </span>
              {addressData.pendingBalance !== 0 && (
                <span className="flex items-center gap-1 text-xs text-orange-500 pt-1">
                  <RefreshCw className="size-3 animate-spin" />
                  {btcPrice ? (
                    <FormattedMessage
                      id="walletDialog.amountPending"
                      defaultMessage="{amount} pending"
                      values={{ amount: satsToUSD(addressData.pendingBalance, btcPrice) }}
                    />
                  ) : (
                    <FormattedMessage id="walletDialog.pending" defaultMessage="pending" />
                  )}
                </span>
              )}
            </div>
          ) : null}

          <div className="rounded-2xl bg-white p-3 shadow-sm">
            <QRCodeCanvas value={bitcoinAddress} size={180} level="M" className="block" />
          </div>

          <button
            onClick={copyAddress}
            className="flex items-center gap-2 px-2 py-1 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors cursor-pointer focus:outline-none focus-visible:ring-0"
          >
            <span className="truncate">{truncatedAddress}</span>
            {copiedAddress ? (
              <Check className="size-3.5 text-green-500 shrink-0" />
            ) : (
              <Copy className="size-3.5 shrink-0" />
            )}
          </button>

          {transactions && transactions.length > 0 && (
            <details className="w-full group">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground transition-colors list-none flex items-center gap-1">
                <FormattedMessage id="walletDialog.transactions" defaultMessage="Transactions" />
                <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
              </summary>
              <div className="w-full divide-y mt-2">
                {transactions.slice(0, 10).map((tx) => (
                  <TxRow key={tx.txid} tx={tx} btcPrice={btcPrice} />
                ))}
              </div>
            </details>
          )}
        </div>
      </ChromeDialogContent>
    </Dialog>
  );
}

function formatTxDate(intl: IntlShape, timestamp?: number): string {
  if (!timestamp) return intl.formatMessage({ id: "walletDialog.txPending", defaultMessage: "Pending" });
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return intl.formatMessage({ id: "walletDialog.today", defaultMessage: "Today" });
  if (diffDays === 1) return intl.formatMessage({ id: "walletDialog.yesterday", defaultMessage: "Yesterday" });
  if (diffDays < 7) return intl.formatMessage({ id: "walletDialog.daysAgo", defaultMessage: "{days}d ago" }, { days: diffDays });
  return date.toLocaleDateString(intl.locale, { month: "short", day: "numeric" });
}

function TxRow({ tx, btcPrice }: { tx: import("@/lib/bitcoin").Transaction; btcPrice?: number }) {
  const intl = useIntl();
  const isReceive = tx.type === "receive";
  return (
    <div className="flex items-center justify-between py-2.5">
      <div>
        <p className="text-xs font-medium">{isReceive ? <FormattedMessage id="walletDialog.received" defaultMessage="Received" /> : <FormattedMessage id="walletDialog.sent" defaultMessage="Sent" />}</p>
        <p className="text-2xs text-muted-foreground">{formatTxDate(intl, tx.timestamp)}</p>
      </div>
      <div className="text-right">
        <p className={`text-xs font-medium ${isReceive ? "text-green-600" : "text-red-600"}`}>
          {isReceive ? "+" : "-"}
          {btcPrice ? satsToUSD(tx.amount, btcPrice) : `${formatBTC(tx.amount)} BTC`}
        </p>
      </div>
    </div>
  );
}
