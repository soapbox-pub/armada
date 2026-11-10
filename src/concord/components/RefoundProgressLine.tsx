import { OperationProgress } from "@/components/ui/operation-progress";
import type { RefoundProgress } from "@/concord/hooks/useRekey";
import { useIntl } from "@/i18n";

/** What a key rotation (a Refounding, CORD-06 §3) is doing now, as a line over a bar. */
export function RefoundProgressLine({ progress, className }: { progress: RefoundProgress | null; className?: string }) {
  const intl = useIntl();
  const { step, done, total } = progress ?? { step: "reading" as const };
  const counted = done !== undefined && total !== undefined && total > 0;
  const n = { done: counted ? Math.min(done + 1, total) : 0, total: total ?? 0 };
  const label = (() => {
    switch (step) {
      case "reading":
        return intl.formatMessage({ id: "refoundProgress.reading", defaultMessage: "Reading the community's current state…" });
      case "encrypting":
        return counted
          ? intl.formatMessage({ id: "refoundProgress.encryptingCount", defaultMessage: "Sealing the new key for each member ({done} of {total}). Your signer may ask for each one." }, n)
          : intl.formatMessage({ id: "refoundProgress.encrypting", defaultMessage: "Sealing the new key for each member…" });
      case "rolling":
        return intl.formatMessage({ id: "refoundProgress.rolling", defaultMessage: "Publishing the new keys…" });
      case "carrying":
        return counted
          ? intl.formatMessage({ id: "refoundProgress.carryingCount", defaultMessage: "Carrying the community's settings over ({done} of {total})…" }, n)
          : intl.formatMessage({ id: "refoundProgress.carrying", defaultMessage: "Carrying the community's settings over…" });
      case "guestbook":
        return intl.formatMessage({ id: "refoundProgress.guestbook", defaultMessage: "Recording who's in the community…" });
      case "channels":
        return counted
          ? intl.formatMessage({ id: "refoundProgress.channelsCount", defaultMessage: "Rotating private channel keys ({done} of {total})…" }, n)
          : intl.formatMessage({ id: "refoundProgress.channels", defaultMessage: "Rotating private channel keys…" });
      case "links":
        return intl.formatMessage({ id: "refoundProgress.links", defaultMessage: "Updating your invite links…" });
      case "saving":
        return intl.formatMessage({ id: "refoundProgress.saving", defaultMessage: "Saving…" });
    }
  })();
  return <OperationProgress label={label} {...(counted ? { done, total } : {})} className={className} />;
}
