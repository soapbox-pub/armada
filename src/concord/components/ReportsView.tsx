import { Flag, Loader2 } from "lucide-react";

import { DisplayName } from "@/components/DisplayName";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useConcordReports, type ReportEntry } from "@/concord/hooks/useConcordReports";
import { reportSubject } from "@/concord/lib/report";
import type { Community } from "@/concord/lib/types";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { shortTimeAgo } from "@/lib/formatTime";
import { REPORT_REASONS } from "@/lib/report";
import { FormattedMessage, useIntl, type IntlShape } from "@/i18n";
import { AvatarInitial } from "@/components/AvatarInitial";

function reasonLabel(intl: IntlShape, reason: string | undefined): string {
  if (!reason) return intl.formatMessage({ id: "reportsView.reported", defaultMessage: "Reported" });
  // Tolerates the table's labels being strings or message descriptors.
  const label = REPORT_REASONS.find((r) => r.value === reason)?.label as unknown;
  if (label === undefined) return reason;
  return typeof label === "string" ? label : intl.formatMessage(label as Parameters<IntlShape["formatMessage"]>[0]);
}

/** Read-only report queue for staff; actions live on their own permission-checked surfaces. */
export function ReportsView({ community }: { community: Community }) {
  const { data: reports, isLoading } = useConcordReports(community);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4">
      <p className="text-sm text-muted-foreground">
        <FormattedMessage
          id="reportsView.description"
          defaultMessage="Reports members sent to this community's moderators. Only moderators can read them."
        />
      </p>
      {isLoading && !reports ? (
        <div className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <FormattedMessage id="reportsView.loading" defaultMessage="Loading reports…" />
        </div>
      ) : !reports || reports.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-md bg-foreground/5 px-4 py-8 text-sm text-muted-foreground">
          <Flag className="size-5" />
          <FormattedMessage id="reportsView.empty" defaultMessage="No reports." />
        </div>
      ) : (
        <ul className="space-y-2">
          {reports.map((report) => (
            <ReportRow key={report.wrapId} report={report} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportRow({ report }: { report: ReportEntry }) {
  const subject = reportSubject(report.rumor);
  const accused = subject.pubkey ?? report.rumor.pubkey;
  const accusedAuthor = useAuthor(accused);
  const accusedName = useScopedDisplayName(accused, accusedAuthor.data?.metadata);
  const reporterAuthor = useAuthor(report.reporter);
  const reporterName = useScopedDisplayName(report.reporter, reporterAuthor.data?.metadata);
  const intl = useIntl();

  return (
    <li className="space-y-2 rounded-md bg-foreground/5 px-3 py-2.5 text-sm">
      <div className="flex items-center gap-2.5">
        <Avatar className="size-6 shrink-0">
          <AvatarImage src={accusedAuthor.data?.metadata?.picture} imeta={accusedAuthor.data?.imeta?.picture} alt={accusedName} />
          <AvatarFallback className="bg-destructive/20 text-3xs text-destructive">
            <AvatarInitial name={accusedName} />
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate font-medium">
          <DisplayName pubkey={accused} name={accusedName} />
        </span>
        <span className="shrink-0 rounded-full bg-destructive/15 px-2 py-0.5 text-2xs text-destructive">
          {reasonLabel(intl, subject.reason)}
        </span>
      </div>

      {/* Only when this moderator's store has the message. */}
      {report.messageText && (
        <blockquote className="border-l-2 border-border pl-2.5 text-muted-foreground line-clamp-4 whitespace-pre-wrap break-words">
          {report.messageText}
        </blockquote>
      )}

      {report.rumor.content && (
        <p className="whitespace-pre-wrap break-words">{report.rumor.content}</p>
      )}

      <p className="text-xs text-muted-foreground">
        <FormattedMessage
          id="reportsView.reportedBy"
          defaultMessage="Reported by {name} · {ago}"
          values={{
            name: <DisplayName pubkey={report.reporter} name={reporterName} />,
            ago: shortTimeAgo(report.rumor.created_at),
          }}
        />
      </p>
    </li>
  );
}
