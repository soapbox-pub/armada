import { CheckCircle2, ChevronDown, ChevronRight, CircleDot, CircleSlash, Clock, ExternalLink, GitPullRequest, Loader2, ScrollText, XCircle } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";


import type { ChannelTimelineEntry, GitChannelTimelineEntry } from "@/components/chat/channelTimeline";
import { ThreadPanel } from "@/components/chat/ThreadPanel";
import { ThreadPanelSlot } from "@/components/chat/ThreadPanelSlot";
import type { ChatMsg, ChatTransport } from "@/components/chat/transport";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { toast } from "@/hooks/useToast";
import { ciGroupsCounts, ciGroupsOutcome, ciRunOutcome, ciWorkflowName, groupCIRunsByWorkflow, type CIRun, type CIRunJob, type CIWorkflowGroup } from "@/lib/ci";
import { shortTimeAgo } from "@/lib/formatTime";
import { gitBodyPreview } from "@/lib/gitSummary";
import {
  GIT_ISSUE_KIND,
  GIT_STATUS_APPLIED_KIND,
  GIT_STATUS_CLOSED_KIND,
  GIT_STATUS_DRAFT_KIND,
  GIT_STATUS_OPEN_KIND,
  gitStatusFromKind,
  type GitComment,
  type GitStatusKind,
  type GitTicket,
  type GitTicketStatus,
  type GitTimelineActivity,
} from "@/lib/gitActivity";
import { gitworkshopTicketUrl } from "@/lib/gitworkshopUrl";
import { cn } from "@/lib/utils";
import { FormattedMessage, defineMessages, t, useIntl, type IntlShape, type MessageDescriptor } from "@/i18n";
import type { ReactNode } from "react";
import { AvatarInitial } from "@/components/AvatarInitial";

/** Callbacks that make the conversation panel writable; absent means read-only. */
export interface TicketPanelActions {
  viewerPubkey?: string;
  /** `tags`: the composer's content-derived tags (NIP-92 imeta, emoji, mentions). */
  onComment?: (ticket: GitTicket, content: string, tags?: readonly string[][]) => Promise<unknown>;
  /** New event + NIP-09 retraction of the old. */
  onEditComment?: (ticket: GitTicket, comment: GitComment, content: string) => Promise<unknown>;
  onDeleteComment?: (ticket: GitTicket, comment: GitComment) => Promise<unknown>;
  onSetStatus?: (ticket: GitTicket, statusKind: GitStatusKind) => Promise<unknown>;
  canSetStatus?: boolean;
}

function TicketIcon({ ticket, className }: { ticket: GitTicket; className?: string }) {
  const Icon = ticket.type === "issue" ? CircleDot : GitPullRequest;
  return <Icon className={cn("size-3.5 shrink-0", ticket.type === "issue" ? "text-emerald-500" : "text-violet-500", className)} />;
}

const TICKET_TYPES = defineMessages({
  issue: { id: "gitTimeline.ticketType.issue", defaultMessage: "Issue" },
  pullRequest: { id: "gitTimeline.ticketType.pullRequest", defaultMessage: "Pull request" },
});

function ticketType(ticket: GitTicket): MessageDescriptor {
  return ticket.type === "issue" ? TICKET_TYPES.issue : TICKET_TYPES.pullRequest;
}

/** A chat row's avatar gutter, so Git row text aligns with messages. */
const GUTTER = "flex w-[3.25rem] shrink-0 justify-end pr-3 pt-0.5";

/** The quietest row: gutter icon and one muted line. */
function NoticeRow({ icon, onClick, label, children, detail }: { icon: ReactNode; onClick?: () => void; label?: string; children: ReactNode; detail?: ReactNode }) {
  return (
    <div data-git-entry className="px-2.5">
      <div className={cn("flex items-start rounded py-1 transition-colors", onClick && "hover:bg-secondary/40")}>
        <span className={GUTTER}>{icon}</span>
        <div className="min-w-0 flex-1 pr-2">
          {onClick
            ? <button type="button" onClick={onClick} aria-label={label} className="block w-full text-left text-xs leading-5 text-muted-foreground">{children}</button>
            : <p className="text-xs leading-5 text-muted-foreground">{children}</p>}
          {detail}
        </div>
      </div>
    </div>
  );
}

interface GitTimelineRowProps {
  entry: GitChannelTimelineEntry;
  onOpen: (ticket: GitTicket) => void;
  /**
   * The timeline's own group, unfiltered: filtering at the call site would
   * allocate each render and defeat the memo. {@link sameType} narrows it.
   */
  related?: readonly ChannelTimelineEntry[];
}

function activityOf(entry: ChannelTimelineEntry): unknown {
  return "activity" in entry ? entry.activity : entry;
}

/**
 * `mergeChannelTimeline` re-wraps every entry on any change; compare the
 * activity object inside instead. NOT the id: a CI run keeps its id while
 * job results (logs) arrive.
 */
function sameActivity(previous: GitTimelineRowProps, next: GitTimelineRowProps): boolean {
  if (previous.entry.activity !== next.entry.activity) return false;
  if (previous.onOpen !== next.onOpen) return false;
  if (previous.related === next.related) return true;
  if (!previous.related || !next.related || previous.related.length !== next.related.length) return false;
  return previous.related.every((entry, index) => activityOf(entry) === activityOf(next.related![index]));
}

/** A Git event as a channel reference; the NIP-34/NIP-22 event is the source of truth. */
export const GitTimelineRow = memo(function GitTimelineRow({ entry, related, onOpen }: GitTimelineRowProps) {
  // Hook-free dispatcher: branching inside one component would reorder hooks.
  if (entry.type === "git-ci-run") {
    return <CIGroupRow entries={sameType(entry, related)} />;
  }
  if (entry.type === "git-status") {
    return <StatusGroupRow entries={sameType(entry, related)} onOpen={onOpen} />;
  }
  if (entry.type === "git-comment") {
    return <CommentGroupRow entries={sameType(entry, related)} onOpen={onOpen} />;
  }
  return <TicketOpenedGroupRow entries={sameType(entry, related)} onOpen={onOpen} />;
}, sameActivity);

/** Narrow a group to the head's variant; checked, not asserted, in case grouping rules change. */
function sameType<T extends GitChannelTimelineEntry["type"]>(
  head: Extract<GitChannelTimelineEntry, { type: T }>,
  related: readonly ChannelTimelineEntry[] | undefined,
): readonly Extract<GitChannelTimelineEntry, { type: T }>[] {
  if (!related || related.length === 0) return [head];
  return related.filter((entry): entry is Extract<GitChannelTimelineEntry, { type: T }> => entry.type === head.type);
}

/** Body as prose; markdown and media are dropped (they're in the panel), uncaptioned. */
function BodyPreview({ content, onOpen, className }: { content: string; onOpen: () => void; className?: string }) {
  const preview = useMemo(() => gitBodyPreview(content), [content]);
  if (!preview.text) return null;
  return (
    <button type="button" onClick={onOpen} className={cn("block w-full text-left", className)}>
      <span className="line-clamp-2 text-sm leading-5 text-muted-foreground">
        {preview.text}
        {preview.truncated && (
          <span className="ml-1 text-muted-foreground/70 underline underline-offset-2">
            <FormattedMessage id="gitTimeline.more" defaultMessage="more" />
          </span>
        )}
      </span>
    </button>
  );
}

function TicketSubject({ ticket, onOpen }: { ticket: GitTicket; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="block w-full truncate text-left text-sm font-medium text-foreground/90 hover:underline">
      {ticket.subject}
    </button>
  );
}

/** Tickets one author opened in one repo, back to back, sharing one byline. */
function TicketOpenedGroupRow({ entries, onOpen }: { entries: readonly Extract<GitChannelTimelineEntry, { type: "git-ticket-opened" }>[]; onOpen: (ticket: GitTicket) => void }) {
  const { ticket, repository } = entries[0].activity;
  const tickets = entries.map((entry) => entry.activity.ticket);
  return (
    <article data-git-entry className="px-2.5">
      <div className="flex items-start gap-3 rounded py-1.5 transition-colors hover:bg-secondary/40">
        <Avatar className="size-10 shrink-0"><ActorAvatar pubkey={ticket.author} /></Avatar>
        <div className="min-w-0 flex-1 pr-2">
          <p className="flex flex-wrap items-baseline gap-x-1.5">
            <ActorName pubkey={ticket.author} className="text-chat" />
            <span className="text-xs text-muted-foreground">
              <FormattedMessage
                id="gitTimeline.opened"
                defaultMessage="{type, select, issue {{count, plural, =1 {opened an issue in {repository}} other {opened # issues in {repository}}}} other {{count, plural, =1 {opened a pull request in {repository}} other {opened # pull requests in {repository}}}}}"
                values={{ type: ticket.type, count: tickets.length, repository: repository.identifier }}
              />
            </span>
          </p>
          {tickets.map((opened) => <TicketSubject key={opened.id} ticket={opened} onOpen={() => onOpen(opened)} />)}
          {tickets.length === 1 && <BodyPreview content={ticket.content} onOpen={() => onOpen(ticket)} />}
        </div>
      </div>
    </article>
  );
}

function CommentGroupRow({ entries, onOpen }: { entries: readonly Extract<GitChannelTimelineEntry, { type: "git-comment" }>[]; onOpen: (ticket: GitTicket) => void }) {
  const { ticket } = entries[0].activity;
  const open = () => onOpen(ticket);
  return (
    <article data-git-entry className="px-2.5">
      <div className="rounded py-1 transition-colors hover:bg-secondary/40">
        <div className="flex items-start">
          <span className={GUTTER} />
          <button type="button" onClick={open} className="min-w-0 flex-1 truncate pr-2 text-left text-xs text-muted-foreground hover:text-foreground">
            <FormattedMessage id="gitTimeline.onTicket" defaultMessage="on {subject}" values={{ subject: ticket.subject }} />
          </button>
        </div>
        {entries.map((entry, index) => (
          <GitCommentRow
            key={entry.id}
            entry={entry}
            onOpen={open}
            continuation={entries[index - 1]?.activity.comment.author === entry.activity.comment.author}
          />
        ))}
      </div>
    </article>
  );
}

function GitCommentRow({ entry, onOpen, continuation }: { entry: Extract<GitChannelTimelineEntry, { type: "git-comment" }>; onOpen: () => void; continuation: boolean }) {
  const { comment } = entry.activity;
  if (continuation) {
    return (
      <div className="flex items-start">
        <span className={GUTTER} />
        <div className="min-w-0 flex-1 pr-2"><BodyPreview content={comment.content} onOpen={onOpen} /></div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3">
      <Avatar className="size-10 shrink-0"><ActorAvatar pubkey={comment.author} /></Avatar>
      <div className="min-w-0 flex-1 pr-2">
        <p><ActorName pubkey={comment.author} className="text-chat" /></p>
        <BodyPreview content={comment.content} onOpen={onOpen} />
      </div>
    </div>
  );
}

/** Status changes on one ticket shown as their outcome. */
function StatusGroupRow({ entries, onOpen }: { entries: readonly Extract<GitChannelTimelineEntry, { type: "git-status" }>[]; onOpen: (ticket: GitTicket) => void }) {
  const last = entries[entries.length - 1];
  const { ticket, status } = last.activity;
  const resolved = gitStatusFromKind(status.kind, ticket.kind);
  const intl = useIntl();
  return (
    <NoticeRow
      icon={<TicketIcon ticket={ticket} />}
      onClick={() => onOpen(ticket)}
      label={intl.formatMessage({ id: "gitTimeline.openTicket", defaultMessage: "Open {subject}" }, { subject: ticket.subject })}
    >
      <FormattedMessage
        id="gitTimeline.statusChanged"
        defaultMessage="{actor} {status, select, closed {closed} merged {merged} resolved {resolved} draft {marked as draft} other {reopened}} {subject}"
        values={{
          actor: <ActorName pubkey={status.author} className="text-xs" />,
          status: resolved,
          subject: <span className="text-foreground/90">{ticket.subject}</span>,
        }}
      />
      {entries.length > 1 && (
        <span className="text-muted-foreground/70">
          {" · "}
          <FormattedMessage
            id="gitTimeline.statusChangeCount"
            defaultMessage="{count, plural, one {# status change} other {# status changes}}"
            values={{ count: entries.length }}
          />
        </span>
      )}
    </NoticeRow>
  );
}

function ActorAvatar({ pubkey }: { pubkey: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <><AvatarImage src={author.data?.metadata?.picture} imeta={author.data?.imeta?.picture} alt={name} /><AvatarFallback className="text-3xs font-semibold"><AvatarInitial name={name} pubkey={pubkey} /></AvatarFallback></>;
}

const CI_OUTCOMES = defineMessages({
  success: { id: "gitTimeline.ci.success", defaultMessage: "succeeded" },
  failure: { id: "gitTimeline.ci.failure", defaultMessage: "failed" },
  timedOut: { id: "gitTimeline.ci.timedOut", defaultMessage: "timed out" },
  startupFailure: { id: "gitTimeline.ci.startupFailure", defaultMessage: "failed to start" },
  cancelled: { id: "gitTimeline.ci.cancelled", defaultMessage: "was cancelled" },
  skipped: { id: "gitTimeline.ci.skipped", defaultMessage: "was skipped" },
  queued: { id: "gitTimeline.ci.queued", defaultMessage: "is queued" },
  inProgress: { id: "gitTimeline.ci.inProgress", defaultMessage: "is running" },
  finished: { id: "gitTimeline.ci.finished", defaultMessage: "finished" },
});

/** Unknown outcomes read as neutral. */
function ciOutcomePresentation(outcome: string): { Icon: typeof CheckCircle2; tone: string; label: MessageDescriptor } {
  switch (outcome) {
    case "success": return { Icon: CheckCircle2, tone: "text-emerald-500", label: CI_OUTCOMES.success };
    case "failure": return { Icon: XCircle, tone: "text-destructive", label: CI_OUTCOMES.failure };
    case "timed_out": return { Icon: Clock, tone: "text-destructive", label: CI_OUTCOMES.timedOut };
    case "startup_failure": return { Icon: XCircle, tone: "text-destructive", label: CI_OUTCOMES.startupFailure };
    case "cancelled": return { Icon: CircleSlash, tone: "text-muted-foreground", label: CI_OUTCOMES.cancelled };
    case "skipped": return { Icon: CircleSlash, tone: "text-muted-foreground", label: CI_OUTCOMES.skipped };
    case "queued": return { Icon: Clock, tone: "text-muted-foreground", label: CI_OUTCOMES.queued };
    case "in_progress": return { Icon: Loader2, tone: "text-muted-foreground", label: CI_OUTCOMES.inProgress };
    default: return { Icon: CircleDot, tone: "text-muted-foreground", label: CI_OUTCOMES.finished };
  }
}

/** Never render an unbounded log body into the timeline. */
const CI_LOG_MAX_BYTES = 512 * 1024;

/**
 * A job's log, fetched from Blossom on first expand. The Job Result's
 * `content` tail previews immediately, so an unreachable host still shows something.
 */
function CIJobLog({ job }: { job: CIRunJob }) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const url = job.result?.logs;
  const tail = job.result?.event.content?.trim() || undefined;

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next || text !== undefined || loading || !url) return;
    if (!/^https:\/\//i.test(url)) {
      setError(t({ id: "gitTimeline.log.notHttps", defaultMessage: "Log URL is not https." }));
      return;
    }
    setLoading(true);
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status}`);
      const body = await response.text();
      setText(body.length > CI_LOG_MAX_BYTES
        ? `${body.slice(0, CI_LOG_MAX_BYTES)}\n${t({ id: "gitTimeline.log.truncated", defaultMessage: "…truncated" })}`
        : body);
    } catch (e) {
      setError(e instanceof Error
        ? t({ id: "gitTimeline.log.loadFailedReason", defaultMessage: "Couldn't load the log ({reason})." }, { reason: e.message })
        : t({ id: "gitTimeline.log.loadFailed", defaultMessage: "Couldn't load the log." }));
    } finally {
      setLoading(false);
    }
  }, [open, text, loading, url]);

  const body = text ?? (error ? tail : undefined);
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2">
        <button type="button" onClick={toggle} className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          <ScrollText className="size-3" />
          <span>{job.result?.name || job.job}</span>
          {loading && <Loader2 className="size-3 animate-spin" />}
        </button>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title={intl.formatMessage({ id: "gitTimeline.log.open", defaultMessage: "Open the full log" })}
            aria-label={intl.formatMessage({ id: "gitTimeline.log.open", defaultMessage: "Open the full log" })}
            className="text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      {open && (
        <>
          {error && <p className="mt-1 text-2xs text-destructive">{error}</p>}
          {body ? (
            <pre className="mt-1 max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-2xs leading-relaxed">
              <code className="font-mono whitespace-pre">{body}</code>
            </pre>
          ) : (
            !loading && !error && (
              <p className="mt-1 text-2xs text-muted-foreground">
                <FormattedMessage id="gitTimeline.log.empty" defaultMessage="No log output." />
              </p>
            )
          )}
        </>
      )}
    </div>
  );
}

/**
 * The run's outcome as prose, naming the signer: nothing on-relay binds a
 * coordinator to a repo, so it's a claim. `time` only inside the fold.
 */
function CIRunSentence({ run, time = false }: { run: CIRun; time?: boolean }) {
  const intl = useIntl();
  const { label } = ciOutcomePresentation(ciRunOutcome(run));
  return (
    <FormattedMessage
      id="gitTimeline.ci.runSentence"
      defaultMessage="<name>{workflow}</name> {outcome}{hasCommit, select, yes { on <mono>{commit}</mono>} other {}}{hasTime, select, yes { · {time}} other {}} · reported by {actor}"
      values={{
        name: (chunks: ReactNode[]) => <span className="font-medium text-foreground/90">{chunks}</span>,
        mono: (chunks: ReactNode[]) => <span className="font-mono">{chunks}</span>,
        workflow: ciWorkflowName(run),
        outcome: intl.formatMessage(label),
        hasCommit: run.commit ? "yes" : "no",
        commit: run.commit?.slice(0, 7) ?? "",
        hasTime: time ? "yes" : "no",
        time: shortTimeAgo(run.createdAt),
        actor: <ActorName pubkey={run.author} className="text-xs" />,
      }}
    />
  );
}

function CIOutcomeIcon({ outcome, className }: { outcome: string; className?: string }) {
  const { Icon, tone } = ciOutcomePresentation(outcome);
  return <Icon className={cn("size-3.5 shrink-0", tone, outcome === "in_progress" && "animate-spin", className)} />;
}

function loggedJobs(run: CIRun): CIRunJob[] {
  return run.jobs.filter((job) => job.result?.logs || job.result?.event.content?.trim());
}

function CIRunLine({ run }: { run: CIRun }) {
  const logged = loggedJobs(run);
  return (
    <NoticeRow
      icon={<CIOutcomeIcon outcome={ciRunOutcome(run)} />}
      detail={logged.length > 0 ? <div>{logged.map((job) => <CIJobLog key={job.eventId} job={job} />)}</div> : undefined}
    >
      <CIRunSentence run={run} />
    </NoticeRow>
  );
}

function CIHistoryStrip({ runs }: { runs: readonly CIRun[] }) {
  const intl = useIntl();
  const shown = runs.slice(0, 12);
  return (
    <p className="mt-0.5 flex flex-wrap items-center gap-1 text-3xs text-muted-foreground/70">
      <span><FormattedMessage id="gitTimeline.ci.beforeThat" defaultMessage="before that" /></span>
      {shown.map((run) => {
        const outcome = ciRunOutcome(run);
        return (
          <span key={run.id} title={[run.commit?.slice(0, 7), intl.formatMessage(ciOutcomePresentation(outcome).label), shortTimeAgo(run.createdAt)].filter(Boolean).join(" · ")}>
            <CIOutcomeIcon outcome={outcome} className="size-3" />
          </span>
        );
      })}
      {runs.length > shown.length && <span>+{runs.length - shown.length}</span>}
    </p>
  );
}

function CIWorkflowDetail({ group }: { group: CIWorkflowGroup }) {
  const logged = loggedJobs(group.latest);
  return (
    <div className="min-w-0">
      <p className="flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
        <CIOutcomeIcon outcome={ciRunOutcome(group.latest)} className="mt-1" />
        <span className="min-w-0"><CIRunSentence run={group.latest} time /></span>
      </p>
      {group.runs.length > 1 && <CIHistoryStrip runs={group.runs.slice(1)} />}
      {logged.map((job) => <CIJobLog key={job.eventId} job={job} />)}
    </div>
  );
}

/** A stretch of CI runs folded to each workflow's current state; runs open on click. */
function CIGroupRow({ entries }: { entries: readonly Extract<GitChannelTimelineEntry, { type: "git-ci-run" }>[] }) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const runs = useMemo(() => entries.map((entry) => entry.activity.run), [entries]);
  const groups = useMemo(() => groupCIRunsByWorkflow(runs), [runs]);

  if (runs.length === 1) return <CIRunLine run={runs[0]} />;

  const only = groups.length === 1 ? groups[0] : undefined;
  return (
    <NoticeRow
      icon={<CIOutcomeIcon outcome={ciGroupsOutcome(groups)} />}
      onClick={() => setOpen((previous) => !previous)}
      label={open
        ? intl.formatMessage({ id: "gitTimeline.ci.hideRuns", defaultMessage: "Hide CI runs" })
        : intl.formatMessage({ id: "gitTimeline.ci.showRuns", defaultMessage: "Show CI runs" })}
      detail={open ? <div className="mt-1 space-y-2 border-l border-border pl-2.5">{groups.map((group) => <CIWorkflowDetail key={group.name} group={group} />)}</div> : undefined}
    >
      {only
        ? <FormattedMessage
            id="gitTimeline.ci.workflowLatest"
            defaultMessage="<name>{workflow}</name> {outcome} · latest of {count, plural, one {# run} other {# runs}}"
            values={{
              name: (chunks: ReactNode[]) => <span className="font-medium text-foreground/90">{chunks}</span>,
              workflow: only.name,
              outcome: intl.formatMessage(ciOutcomePresentation(ciRunOutcome(only.latest)).label),
              count: only.runs.length,
            }}
          />
        : <FormattedMessage
            id="gitTimeline.ci.groupSummary"
            defaultMessage="<name>CI</name> · {count, plural, one {# run} other {# runs}} · {summary}"
            values={{
              name: (chunks: ReactNode[]) => <span className="font-medium text-foreground/90">{chunks}</span>,
              count: runs.length,
              summary: ciSummary(intl, groups),
            }}
          />}
    </NoticeRow>
  );
}

/** "2 passing, 1 failing", or the workflow count when none has an outcome yet. */
function ciSummary(intl: IntlShape, groups: readonly CIWorkflowGroup[]): string {
  const counts = ciGroupsCounts(groups);
  const parts = [
    counts.failing > 0 ? intl.formatMessage({ id: "gitTimeline.ci.failingCount", defaultMessage: "{count, plural, other {# failing}}" }, { count: counts.failing }) : undefined,
    counts.running > 0 ? intl.formatMessage({ id: "gitTimeline.ci.runningCount", defaultMessage: "{count, plural, other {# running}}" }, { count: counts.running }) : undefined,
    counts.passing > 0 ? intl.formatMessage({ id: "gitTimeline.ci.passingCount", defaultMessage: "{count, plural, other {# passing}}" }, { count: counts.passing }) : undefined,
  ].filter((part): part is string => part !== undefined);
  if (parts.length === 0) {
    return intl.formatMessage({ id: "gitTimeline.ci.workflowCount", defaultMessage: "{count, plural, one {# workflow} other {# workflows}}" }, { count: groups.length });
  }
  return intl.formatList(parts, { type: "unit", style: "short" });
}

function ActorName({ pubkey, className }: { pubkey: string; className?: string }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return <span className={cn("font-semibold text-foreground", className ?? "text-sm")}>{name}</span>;
}

const STATUS_ACTIONS = defineMessages({
  reopen: { id: "gitTimeline.status.reopen", defaultMessage: "Reopen" },
  markOpen: { id: "gitTimeline.status.markOpen", defaultMessage: "Mark open" },
  markResolved: { id: "gitTimeline.status.markResolved", defaultMessage: "Mark resolved" },
  markMerged: { id: "gitTimeline.status.markMerged", defaultMessage: "Mark merged" },
  markDraft: { id: "gitTimeline.status.markDraft", defaultMessage: "Mark draft" },
  close: { id: "gitTimeline.status.close", defaultMessage: "Close" },
});

function statusOptions(status: GitTicketStatus, ticket: GitTicket): Array<{ label: MessageDescriptor; kind: GitStatusKind }> {
  if (status === "closed" || status === "merged" || status === "resolved") {
    return [{ label: STATUS_ACTIONS.reopen, kind: GIT_STATUS_OPEN_KIND }];
  }
  const options: Array<{ label: MessageDescriptor; kind: GitStatusKind }> = [];
  if (status === "draft") options.push({ label: STATUS_ACTIONS.markOpen, kind: GIT_STATUS_OPEN_KIND });
  options.push({ label: ticket.kind === GIT_ISSUE_KIND ? STATUS_ACTIONS.markResolved : STATUS_ACTIONS.markMerged, kind: GIT_STATUS_APPLIED_KIND });
  if (status === "open" && ticket.kind !== GIT_ISSUE_KIND) options.push({ label: STATUS_ACTIONS.markDraft, kind: GIT_STATUS_DRAFT_KIND });
  options.push({ label: STATUS_ACTIONS.close, kind: GIT_STATUS_CLOSED_KIND });
  return options;
}

function TicketStatusControls({ ticket, status, onSet }: { ticket: GitTicket; status: GitTicketStatus; onSet: NonNullable<TicketPanelActions["onSetStatus"]> }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {statusOptions(status, ticket).map(({ label, kind }) => (
        <Button
          key={kind}
          variant="secondary"
          size="sm"
          className="h-7 px-2.5 text-xs"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            onSet(ticket, kind)
              .catch((error) => toast({ title: t({ id: "gitTimeline.status.updateFailed", defaultMessage: "Couldn't update status" }), description: error instanceof Error ? error.message : undefined, variant: "destructive" }))
              .finally(() => setBusy(false));
          }}
        >
          <FormattedMessage {...label} />
        </Button>
      ))}
    </div>
  );
}


function TicketHeader({ ticket, status, actions }: { ticket: GitTicket; status: GitTicketStatus; actions?: TicketPanelActions }) {
  const workshopUrl = useMemo(() => gitworkshopTicketUrl(ticket), [ticket]);
  const intl = useIntl();
  const repository = ticket.repositoryAddress?.identifier
    ?? intl.formatMessage({ id: "gitTimeline.unknownRepository", defaultMessage: "Unknown repository" });
  return (
    <div className="px-3 pb-2">
      <div className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        <TicketIcon ticket={ticket} />
        <span className="truncate">
          <FormattedMessage
            id="gitTimeline.ticketInRepository"
            defaultMessage="{type} · {repository}"
            values={{ type: intl.formatMessage(ticketType(ticket)), repository }}
          />
        </span>
      </div>
      <h2 className="mt-1 text-lg font-semibold leading-snug break-words">{ticket.subject}</h2>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <span className="capitalize">
          <FormattedMessage
            id="gitTimeline.status"
            defaultMessage="{status, select, open {open} draft {draft} closed {closed} merged {merged} resolved {resolved} other {{status}}}"
            values={{ status }}
          />
        </span>
        {workshopUrl && (
          <a href={workshopUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-foreground hover:underline">
            <ExternalLink className="size-3" />
            gitworkshop
          </a>
        )}
      </div>
      {actions?.canSetStatus && actions.onSetStatus && <TicketStatusControls ticket={ticket} status={status} onSet={actions.onSetStatus} />}
    </div>
  );
}

/** The composer's own `h`; everything else it derives (imeta, emoji, mentions) belongs on the comment too. */
function commentTags(tags: string[][]): string[][] {
  return tags.filter((tag) => tag[0] !== "h");
}

function failed(title: string) {
  return (error: unknown) => toast({ title, description: error instanceof Error ? error.message : undefined, variant: "destructive" });
}

function TicketThread({ ticket, members, activities, open, onClose, onExpandChange, actions }: { ticket: GitTicket; members: ReadonlySet<string>; activities: readonly GitTimelineActivity[]; open: boolean; onClose: () => void; onExpandChange: (expanded: boolean) => void; actions?: TicketPanelActions }) {
  const { comments, status } = useMemo(() => {
    const comments: GitComment[] = [];
    let latestStatus: Extract<GitTimelineActivity, { type: "status-change" }> | undefined;
    for (const activity of activities) {
      if (activity.type === "ci-run" || activity.ticket.id !== ticket.id) continue;
      if (activity.type === "comment") comments.push(activity.comment);
      else if (activity.type === "status-change" && (!latestStatus || activity.createdAt > latestStatus.createdAt || (activity.createdAt === latestStatus.createdAt && activity.status.event.id < latestStatus.status.event.id))) latestStatus = activity;
    }
    comments.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return { comments, status: gitStatusFromKind(latestStatus?.status.kind, ticket.kind) };
  }, [activities, ticket.id, ticket.kind]);

  const onComment = actions?.onComment;
  const onEditComment = actions?.onEditComment;
  const onDeleteComment = actions?.onDeleteComment;
  const transport = useMemo<ChatTransport>(() => {
    const replies: ChatMsg[] = comments.map((comment) => comment.event);
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    return {
      messages: [],
      isLoading: false,
      canWrite: Boolean(onComment),
      canModerate: false,
      threadRepliesFor: () => replies,
      sendThreadReply: onComment
        ? async (_root, content, tags) => { await onComment(ticket, content, commentTags(tags)); }
        : undefined,
      editMessage: onEditComment
        ? async (original, content) => {
            const comment = byId.get(original.id);
            if (comment) await onEditComment(ticket, comment, content);
          }
        : undefined,
      deleteMessage: onDeleteComment
        ? (event) => {
            const comment = byId.get(event.id);
            if (comment) onDeleteComment(ticket, comment).catch(failed(t({ id: "gitTimeline.deleteCommentFailed", defaultMessage: "Couldn't delete comment" })));
          }
        : undefined,
    };
  }, [comments, ticket, onComment, onEditComment, onDeleteComment]);
  const mentionPubkeys = useMemo(() => [...members], [members]);
  const intl = useIntl();

  return (
    <ThreadPanel
      root={ticket.event}
      transport={transport}
      relayUrl="dm"
      groupId={`git:${ticket.id}`}
      canWrite={Boolean(onComment)}
      mentionPubkeys={mentionPubkeys}
      open={open}
      onClose={onClose}
      onExpandChange={onExpandChange}
      title={intl.formatMessage(ticketType(ticket))}
      rootHeader={<TicketHeader ticket={ticket} status={status} actions={actions} />}
      rootReadOnly
      documentMarkdown
      // Repository discussion is public, unlike the community around it.
      placeholder={intl.formatMessage(
        {
          id: "gitTimeline.commentPlaceholder",
          defaultMessage: "{type, select, issue {Comment publicly on this issue…} other {Comment publicly on this pull request…}}",
        },
        { type: ticket.type },
      )}
      readOnlyNotice={intl.formatMessage(
        {
          id: "gitTimeline.signInToComment",
          defaultMessage: "{type, select, issue {Sign in to comment on this issue.} other {Sign in to comment on this pull request.}}",
        },
        { type: ticket.type },
      )}
    />
  );
}

/** A work item's NIP-22 discussion, in the shared thread panel. */
export function TicketSidePanel({ ticket, members, activities, onClose, onExpandChange, actions }: { ticket: GitTicket | undefined; members: ReadonlySet<string>; activities: readonly GitTimelineActivity[]; onClose: () => void; onExpandChange?: (expanded: boolean) => void; actions?: TicketPanelActions }) {
  // Outlives `ticket` through the slide-out, as `useThreadPanel`'s `lastThreadRoot`.
  const [lastTicket, setLastTicket] = useState(ticket);
  useEffect(() => {
    if (ticket) {
      setLastTicket(ticket);
      return;
    }
    const timer = setTimeout(() => setLastTicket(undefined), 200);
    return () => clearTimeout(timer);
  }, [ticket]);
  const [expanded, setExpanded] = useState(false);
  const handleExpandChange = useCallback((next: boolean) => {
    setExpanded(next);
    onExpandChange?.(next);
  }, [onExpandChange]);
  const shown = ticket ?? lastTicket;

  return (
    <ThreadPanelSlot open={Boolean(ticket)} expanded={expanded}>
      {shown && (
        <TicketThread
          key={shown.id}
          ticket={shown}
          members={members}
          activities={activities}
          open={Boolean(ticket)}
          onClose={onClose}
          onExpandChange={handleExpandChange}
          actions={actions}
        />
      )}
    </ThreadPanelSlot>
  );
}
