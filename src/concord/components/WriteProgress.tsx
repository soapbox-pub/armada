import { OperationProgress } from "@/components/ui/operation-progress";
import { useIntl } from "@/i18n";

/**
 * What a role write is doing while it runs: one change can be many signed editions
 * (a Tenure per holder, re-signed Grants), each a signer round-trip, so a bare spinner
 * reads as frozen. The total grows as the write plans more.
 */
export function WriteProgress({ published, planned, className }: { published: number; planned: number; className?: string }) {
  const intl = useIntl();
  const label = planned === 0
    ? intl.formatMessage({ id: "rankedRolesView.progress.starting", defaultMessage: "Reading the community and waiting for your signer…" })
    : intl.formatMessage(
      { id: "rankedRolesView.progress.publishing", defaultMessage: "Signing and publishing change {done} of {total}…" },
      { done: Math.min(published + 1, planned), total: planned },
    );
  return <OperationProgress label={label} {...(planned > 0 ? { done: published, total: planned } : {})} className={className} />;
}
