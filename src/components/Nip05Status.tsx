import { BadgeCheck, CircleAlert, Loader2 } from "lucide-react";
import { useMemo } from "react";

import { useNip05Resolve } from "@/hooks/useNip05Resolve";
import { useIntl } from "@/i18n";
import { parseNip05Address } from "@/lib/nip05Address";
import { cn } from "@/lib/utils";

/**
 * A profile's NIP-05 identifier, checked against its domain's `/.well-known/nostr.json`.
 * Verified only when the name maps to this pubkey; a failed lookup and a mismatch read alike.
 */
export function Nip05Status({ pubkey, nip05, className }: { pubkey: string; nip05: string; className?: string }) {
  const intl = useIntl();
  const address = useMemo(() => parseNip05Address(nip05), [nip05]);
  const resolve = useNip05Resolve(address);
  if (!address) return null;

  const state = resolve.isPending
    ? "checking"
    : resolve.data?.toLowerCase() === pubkey.toLowerCase()
      ? "verified"
      : "unverified";

  const label = state === "verified"
    ? intl.formatMessage(
      { id: "nip05Status.verified", defaultMessage: "{address} is verified by {domain}" },
      { address: address.display, domain: address.domain },
    )
    : state === "unverified"
      ? intl.formatMessage(
        { id: "nip05Status.unverified", defaultMessage: "{domain} did not confirm {address} for this account" },
        { address: address.display, domain: address.domain },
      )
      : intl.formatMessage(
        { id: "nip05Status.checking", defaultMessage: "Checking {address}…" },
        { address: address.display },
      );

  const Icon = state === "verified" ? BadgeCheck : state === "unverified" ? CircleAlert : Loader2;

  return (
    <span
      className={cn("flex items-center gap-1 min-w-0 text-xs text-muted-foreground", className)}
      title={label}
      data-nip05-state={state}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          state === "verified" && "text-primary",
          state === "unverified" && "text-destructive",
          state === "checking" && "animate-spin",
        )}
      />
      <span className="truncate">{address.display}</span>
      {state === "unverified" && (
        <span aria-hidden className="shrink-0 text-destructive">
          {intl.formatMessage({ id: "nip05Status.notVerified", defaultMessage: "not verified" })}
        </span>
      )}
      <span className="sr-only">{label}</span>
    </span>
  );
}
