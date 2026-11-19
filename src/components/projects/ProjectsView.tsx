import { CircleDot, Copy, ExternalLink, FolderGit2, GitMerge, GitPullRequest, LayoutGrid, List, MessageCircle, Users, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DisplayName } from "@/components/DisplayName";
import { SearchField } from "@/components/ui/search-field";
import { UserAvatar } from "@/components/UserAvatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAuthor } from "@/hooks/useAuthor";
import { useScopedDisplayName } from "@/hooks/useScopedDisplayName";
import { writeClipboardText } from "@/lib/clipboard";
import { relativeTime } from "@/lib/formatTime";
import { toast } from "@/hooks/useToast";
import { common, defineMessage, defineMessages, FormattedMessage, t, useIntl, type MessageDescriptor } from "@/i18n";
import { cn } from "@/lib/utils";

import {
  activityByDay,
  projectPeople,
  repoMatchesQuery,
  repoSummaries,
  sortProjectWorkItems,
  workItemActivityAt,
  workItemMatchesQuery,
  type ProjectRepo,
  type ProjectRepoSummary,
  type ProjectSort,
  type ProjectWorkItem,
  type ProjectWorkKind,
} from "@/components/projects/projectData";

type Filter = "all" | "repositories" | "prs" | "issues";
type ViewMode = "grid" | "list";

function useName(pubkey: string): string {
  const author = useAuthor(pubkey);
  return useScopedDisplayName(pubkey, author.data?.metadata);
}

function AuthorName({ pubkey }: { pubkey: string }) {
  const name = useName(pubkey);
  return (
    <span className="font-medium text-foreground/80">
      <DisplayName pubkey={pubkey} name={name} />
    </span>
  );
}

/** The avatar with the person's name on hover. */
function PersonAvatar({ pubkey, size = "size-7", frame }: { pubkey: string; size?: string; frame?: boolean }) {
  const author = useAuthor(pubkey);
  const name = useScopedDisplayName(pubkey, author.data?.metadata);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <UserAvatar
            pubkey={pubkey}
            metadata={author.data?.metadata}
            imeta={author.data?.imeta?.picture}
            name={name}
            className={cn(size, "border border-border/60")}
            fallbackClassName="text-3xs"
            frame={frame}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <DisplayName pubkey={pubkey} name={name} />
      </TooltipContent>
    </Tooltip>
  );
}

function PeopleStack({ pubkeys }: { pubkeys: string[] }) {
  const visible = pubkeys.slice(0, 5);
  const remaining = pubkeys.length - visible.length;
  if (visible.length === 0) return null;
  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((pk, i) => (
        <span key={pk} className="relative inline-flex ring-2 ring-card rounded-full" style={{ zIndex: visible.length - i }}>
          <PersonAvatar pubkey={pk} size="size-6" frame={false} />
        </span>
      ))}
      {remaining > 0 && (
        <span className="relative z-0 flex h-6 min-w-6 items-center justify-center rounded-full bg-muted px-1 text-3xs font-semibold text-muted-foreground ring-2 ring-card">
          +{remaining}
        </span>
      )}
    </div>
  );
}

// Contribution graph: last 26 weeks.

const DAYS_PER_WEEK = 7;
const LEVEL_CLASSES = [
  "bg-muted/40",
  "bg-primary/25",
  "bg-primary/50",
  "bg-primary/75",
  "bg-primary",
];
const LEVEL_LABELS = [
  defineMessage({ id: "projectsView.level.none", defaultMessage: "No activity" }),
  defineMessage({ id: "projectsView.level.1", defaultMessage: "1–2 events" }),
  defineMessage({ id: "projectsView.level.2", defaultMessage: "3–5 events" }),
  defineMessage({ id: "projectsView.level.3", defaultMessage: "6–9 events" }),
  defineMessage({ id: "projectsView.level.4", defaultMessage: "10+ events" }),
];

function graphDayKey(date: Date) {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function levelFor(count: number) {
  if (count <= 0) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

function buildWeeks(today: Date, weekCount: number) {
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - today.getDay() - (weekCount - 1) * DAYS_PER_WEEK,
  );
  return Array.from({ length: weekCount }, (_, w) =>
    Array.from({ length: DAYS_PER_WEEK }, (_, d) => {
      const date = new Date(start);
      date.setDate(start.getDate() + w * DAYS_PER_WEEK + d);
      return date;
    }),
  );
}

const MIN_LABEL_GAP = 3;
function monthLabels(weeks: Date[][], locale: string) {
  let lastLabeled = -MIN_LABEL_GAP;
  return weeks.map((week, index) => {
    const isNewMonth = index === 0 || week[0].getMonth() !== weeks[index - 1][0].getMonth();
    if (!isNewMonth || index - lastLabeled < MIN_LABEL_GAP) return "";
    lastLabeled = index;
    return week[0].toLocaleDateString(locale, { month: "short" });
  });
}

function ContributionLegend() {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-3xs text-muted-foreground">
        <FormattedMessage id="projectsView.less" defaultMessage="Less" />
      </span>
      {LEVEL_CLASSES.map((levelClass, level) => (
        <Tooltip key={levelClass}>
          <TooltipTrigger asChild>
            <span className={cn("size-2.5 rounded", levelClass)} />
          </TooltipTrigger>
          <TooltipContent>
            <FormattedMessage {...LEVEL_LABELS[level]} />
          </TooltipContent>
        </Tooltip>
      ))}
      <span className="text-3xs text-muted-foreground">
        <FormattedMessage id="projectsView.more" defaultMessage="More" />
      </span>
    </div>
  );
}

function ContributionGraph({ data }: { data: Record<string, number> }) {
  const intl = useIntl();
  const today = new Date();
  const weeks = buildWeeks(today, 26);
  const labels = monthLabels(weeks, intl.locale);
  const gridTemplateColumns = `repeat(${weeks.length}, minmax(0, 1fr))`;
  const todayKey = graphDayKey(today);
  return (
    <div className="space-y-2">
      <div className="grid gap-1" style={{ gridTemplateColumns }}>
        {labels.map((label, index) => (
          <span
            className="overflow-visible whitespace-nowrap text-3xs font-medium text-muted-foreground"
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed-size grid
            key={index}
          >
            {label}
          </span>
        ))}
      </div>
      <div className="grid grid-flow-col grid-rows-7 gap-1" style={{ gridTemplateColumns }}>
        {weeks.map((week) =>
          week.map((day) => {
            const key = graphDayKey(day);
            if (key > todayKey) {
              return <span aria-hidden key={key} className="aspect-square rounded-[22%] border border-border/40" />;
            }
            const count = data[key] ?? 0;
            const dateLabel = day.toLocaleDateString(intl.locale, { month: "short", day: "numeric" });
            return (
              <Tooltip key={key}>
                <TooltipTrigger asChild>
                  <span className={cn("aspect-square w-full rounded-[22%]", LEVEL_CLASSES[levelFor(count)])} />
                </TooltipTrigger>
                <TooltipContent>
                  {count > 0 ? (
                    <FormattedMessage
                      id="projectsView.dayEvents"
                      defaultMessage="{count, plural, one {# event} other {# events}} · {date}"
                      values={{ count, date: dateLabel }}
                    />
                  ) : (
                    <FormattedMessage
                      id="projectsView.dayNoActivity"
                      defaultMessage="No activity · {date}"
                      values={{ date: dateLabel }}
                    />
                  )}
                </TooltipContent>
              </Tooltip>
            );
          }),
        )}
      </div>
    </div>
  );
}

const WORK_VISUALS: Record<ProjectWorkKind, { icon: typeof CircleDot; badge: string; icclass: string }> = {
  issue: { icon: CircleDot, badge: "bg-orange-500/10", icclass: "text-orange-500" },
  pr: { icon: GitPullRequest, badge: "bg-success/10", icclass: "text-success" },
  patch: { icon: GitMerge, badge: "bg-primary/10", icclass: "text-primary" },
};

function WorkItemIcon({ kind, className }: { kind: ProjectWorkKind; className?: string }) {
  const v = WORK_VISUALS[kind];
  const Icon = v.icon;
  return (
    <span className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-full ring-1 ring-border/60", v.badge, className)}>
      <Icon className={cn("size-3", v.icclass)} />
    </span>
  );
}

const STATUS_STYLES: Record<ProjectWorkItem["status"], string> = {
  open: "bg-success/15 text-success",
  merged: "bg-primary/15 text-primary",
  resolved: "bg-primary/15 text-primary",
  closed: "bg-destructive/15 text-destructive",
  draft: "bg-muted text-muted-foreground",
};

const STATUS_LABELS: Record<ProjectWorkItem["status"], MessageDescriptor> = defineMessages({
  open: { id: "projectsView.status.open", defaultMessage: "open" },
  merged: { id: "projectsView.status.merged", defaultMessage: "merged" },
  resolved: { id: "projectsView.status.resolved", defaultMessage: "resolved" },
  closed: { id: "projectsView.status.closed", defaultMessage: "closed" },
  draft: { id: "projectsView.status.draft", defaultMessage: "draft" },
});

function StatusChip({ status }: { status: ProjectWorkItem["status"] }) {
  return (
    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-3xs font-medium capitalize", STATUS_STYLES[status])}>
      <FormattedMessage {...STATUS_LABELS[status]} />
    </span>
  );
}

function WorkItemRow({ item, repoName, onOpen, onLabelClick }: { item: ProjectWorkItem; repoName?: string; onOpen?: () => void; onLabelClick?: (label: string) => void }) {
  const Comp = onOpen ? "button" : "article";
  const labels = item.labels ?? [];
  // Rows are ordered by last activity, so show that date.
  const activityAt = workItemActivityAt(item);
  const bumped = activityAt > item.createdAt;
  return (
    <Comp
      {...(onOpen ? { type: "button" as const, onClick: onOpen } : {})}
      className={cn(
        "flex min-w-0 items-center justify-between gap-3 p-3 transition-colors hover:bg-foreground/[0.03]",
        onOpen && "w-full text-left",
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <WorkItemIcon kind={item.kind} />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate text-sm font-semibold leading-5 text-foreground">{item.title}</p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-4 text-muted-foreground">
            {repoName && <span className="truncate">{repoName}</span>}
            {repoName && <span aria-hidden>·</span>}
            {bumped ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <FormattedMessage
                      id="projectsView.updatedAgo"
                      defaultMessage="updated {time}"
                      values={{ time: relativeTime(activityAt) }}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <FormattedMessage
                    id="projectsView.openedAgo"
                    defaultMessage="Opened {time}"
                    values={{ time: relativeTime(item.createdAt) }}
                  />
                </TooltipContent>
              </Tooltip>
            ) : (
              <span>{relativeTime(item.createdAt)}</span>
            )}
            <span aria-hidden>·</span>
            <span>
              <FormattedMessage
                id="projectsView.byAuthor"
                defaultMessage="by {name}"
                values={{ name: <AuthorName pubkey={item.author} /> }}
              />
            </span>
            {labels.slice(0, 3).map((label) => (
              // Plain spans: the row is already a button, so no nested controls.
              <span
                key={label}
                onClick={onLabelClick ? (e) => { e.stopPropagation(); onLabelClick(label); } : undefined}
                className={cn(
                  "rounded-full border border-border/60 px-1.5 py-px text-3xs",
                  onLabelClick && "cursor-pointer transition-colors hover:border-primary/50 hover:text-foreground",
                )}
              >
                {label}
              </span>
            ))}
            {labels.length > 3 && <span className="text-3xs">+{labels.length - 3}</span>}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {(item.commentCount ?? 0) > 0 && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <MessageCircle className="size-3.5" />
            {item.commentCount}
          </span>
        )}
        <StatusChip status={item.status} />
      </div>
    </Comp>
  );
}

function RepoIcon() {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/40">
      <FolderGit2 className="size-[1.125rem] text-muted-foreground" />
    </span>
  );
}

function CloneButton({ url }: { url: string }) {
  const intl = useIntl();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 touch:size-11 text-muted-foreground hover:text-foreground"
          aria-label={intl.formatMessage({ id: "projectsView.copyCloneUrl", defaultMessage: "Copy clone URL" })}
          onClick={() =>
            writeClipboardText(url).then(
              () => toast({ title: t({ id: "projectsView.cloneUrlCopied", defaultMessage: "Clone URL copied" }) }),
              () => undefined,
            )}
        >
          <Copy className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <FormattedMessage id="projectsView.copyCloneUrl" defaultMessage="Copy clone URL" />
      </TooltipContent>
    </Tooltip>
  );
}

function safeWeb(webUrl?: string): string | null {
  if (!webUrl) return null;
  try {
    return /^https?:$/.test(new URL(webUrl).protocol) ? webUrl : null;
  } catch {
    return null;
  }
}

const PR_COUNT = defineMessage({
  id: "projectsView.prCount",
  defaultMessage: "{count, plural, one {# PR} other {# PRs}}",
});
const ISSUE_COUNT = defineMessage({
  id: "projectsView.issueCount",
  defaultMessage: "{count, plural, one {# issue} other {# issues}}",
});

function ActivityBar({ summary }: { summary: ProjectRepoSummary }) {
  const items = [
    { count: summary.prCount, bar: "bg-primary", label: PR_COUNT },
    { count: summary.issueCount, bar: "bg-orange-500", label: ISSUE_COUNT },
  ];
  const total = items.reduce((s, i) => s + i.count, 0);
  return (
    <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted/60">
      {total > 0
        ? items.filter((i) => i.count > 0).map((i) => (
            <Tooltip key={i.bar}>
              <TooltipTrigger asChild>
                <div className={cn("h-full", i.bar)} style={{ width: `${(i.count / total) * 100}%` }} />
              </TooltipTrigger>
              <TooltipContent>
                <span className="flex items-center gap-1.5">
                  <span className={cn("size-2 rounded-full", i.bar)} />
                  <FormattedMessage {...i.label} values={{ count: i.count }} />
                </span>
              </TooltipContent>
            </Tooltip>
          ))
        : null}
    </div>
  );
}

const statNumber = (chunks: React.ReactNode[]) => <span className="font-medium text-foreground">{chunks}</span>;

function StatsRow({ summary }: { summary: ProjectRepoSummary }) {
  return (
    <div className="flex items-center gap-x-3 text-xs leading-4 text-muted-foreground">
      <span className="flex items-center gap-1">
        <GitPullRequest className="size-3.5 shrink-0 text-primary" />
        <FormattedMessage
          id="projectsView.statsPrs"
          defaultMessage="{count, plural, one {<n>#</n> PR} other {<n>#</n> PRs}}"
          values={{ count: summary.prCount, n: statNumber }}
        />
      </span>
      <span className="flex items-center gap-1">
        <CircleDot className="size-3.5 shrink-0 text-orange-500" />
        <FormattedMessage
          id="projectsView.statsIssues"
          defaultMessage="{count, plural, one {<n>#</n> issue} other {<n>#</n> issues}}"
          values={{ count: summary.issueCount, n: statNumber }}
        />
      </span>
    </div>
  );
}

const SHOW_REPO_ACTIVITY = defineMessage({ id: "projectsView.showRepoActivity", defaultMessage: "Show {name} activity" });
const VIEW_ON_WEB = defineMessage({ id: "projectsView.viewOnWeb", defaultMessage: "View on web" });
const REPO_FALLBACK_DESCRIPTION = defineMessage({
  id: "projectsView.repoFallbackDescription",
  defaultMessage: "A shared space for git work.",
});

function RepoCard({ repo, summary, people, selected, onOpen }: {
  repo: ProjectRepo;
  summary: ProjectRepoSummary;
  people: string[];
  selected?: boolean;
  onOpen?: () => void;
}) {
  const intl = useIntl();
  const web = safeWeb(repo.webUrl);
  return (
    <Card
      className={cn(
        "relative flex min-h-44 flex-col overflow-hidden clip-corner-lg border-0 bg-card shadow-none transition-colors",
        onOpen && "hover:bg-foreground/[0.02]",
        selected && "ring-1 ring-primary/60",
      )}
    >
      {/* Full-card overlay, not a wrapping button: the card holds controls that can't nest in one. */}
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={intl.formatMessage(SHOW_REPO_ACTIVITY, { name: repo.name })}
          aria-pressed={selected}
          className="absolute inset-0 z-0 cursor-pointer rounded-[inherit] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      )}
      <div className="flex min-w-0 items-center justify-between gap-3 px-4 pt-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <RepoIcon />
          <div className="min-w-0 flex-1">
            <span className="block min-w-0 truncate text-sm font-semibold text-foreground">{repo.name}</span>
            {repo.subtitle && <span className="block min-w-0 truncate text-xs text-muted-foreground">{repo.subtitle}</span>}
          </div>
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-1">
          <span className="whitespace-nowrap text-xs text-muted-foreground/70">{relativeTime(repo.createdAt)}</span>
          {web && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="size-7 touch:size-11 text-muted-foreground hover:text-foreground" asChild>
                  <a href={web} target="_blank" rel="noopener noreferrer" aria-label={intl.formatMessage(VIEW_ON_WEB)}>
                    <ExternalLink className="size-3.5" />
                  </a>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <FormattedMessage {...VIEW_ON_WEB} />
              </TooltipContent>
            </Tooltip>
          )}
          {repo.cloneUrls[0] && <CloneButton url={repo.cloneUrls[0]} />}
        </div>
      </div>

      <p className="line-clamp-2 min-h-10 px-4 py-2 text-sm text-muted-foreground">
        {repo.description || <FormattedMessage {...REPO_FALLBACK_DESCRIPTION} />}
      </p>

      <div className="relative z-10 flex w-fit items-center px-4 pb-1">
        <PeopleStack pubkeys={people} />
      </div>

      <div className="mt-auto">
        <div className="flex min-w-0 items-center px-4 pb-2 pt-1">
          <StatsRow summary={summary} />
        </div>
        <div className="relative z-10 px-4 pb-3">
          <ActivityBar summary={summary} />
        </div>
      </div>
    </Card>
  );
}

/** Columns stack (not viewport breakpoints) so a narrow pane doesn't crush the repo name. */
function RepoRow({ repo, summary, people, selected, onOpen }: {
  repo: ProjectRepo;
  summary: ProjectRepoSummary;
  people: string[];
  selected?: boolean;
  onOpen?: () => void;
}) {
  const intl = useIntl();
  const web = safeWeb(repo.webUrl);
  return (
    <div
      className={cn(
        "relative flex min-w-0 items-start gap-2.5 px-3 py-2.5 transition-colors",
        onOpen && "hover:bg-foreground/[0.03]",
        selected && "bg-primary/[0.06]",
      )}
    >
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          aria-label={intl.formatMessage(SHOW_REPO_ACTIVITY, { name: repo.name })}
          aria-pressed={selected}
          className="absolute inset-0 z-0 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        />
      )}
      <RepoIcon />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">{repo.name}</span>
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground/70">{relativeTime(repo.createdAt)}</span>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {repo.subtitle ? `${repo.subtitle} · ` : ""}
          {repo.description || <FormattedMessage {...REPO_FALLBACK_DESCRIPTION} />}
        </p>
        <div className="relative z-10 flex w-fit flex-wrap items-center gap-x-3 gap-y-1">
          <StatsRow summary={summary} />
          <div className="w-20 shrink-0"><ActivityBar summary={summary} /></div>
          <PeopleStack pubkeys={people} />
        </div>
      </div>
      <div className="relative z-10 flex shrink-0 items-center">
        {web && (
          <Button variant="ghost" size="icon" className="size-7 touch:size-11 text-muted-foreground hover:text-foreground" asChild>
            <a href={web} target="_blank" rel="noopener noreferrer" aria-label={intl.formatMessage(VIEW_ON_WEB)}>
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
        )}
        {repo.cloneUrls[0] && <CloneButton url={repo.cloneUrls[0]} />}
      </div>
    </div>
  );
}

const TABS: Array<{ label: MessageDescriptor; value: Filter }> = [
  { label: defineMessage({ id: "projectsView.tab.overview", defaultMessage: "Overview" }), value: "all" },
  { label: defineMessage({ id: "projectsView.tab.repositories", defaultMessage: "Repositories" }), value: "repositories" },
  { label: defineMessage({ id: "projectsView.tab.pullRequests", defaultMessage: "Pull Requests" }), value: "prs" },
  { label: defineMessage({ id: "projectsView.tab.issues", defaultMessage: "Issues" }), value: "issues" },
];

function Tabs({ filter, onChange }: { filter: Filter; onChange: (f: Filter) => void }) {
  return (
    <div className="flex h-[3.25rem] items-stretch gap-1 overflow-x-auto border-b border-border/60 scrollbar-none [&::-webkit-scrollbar]:hidden">
      {TABS.map((tab) => {
        const active = filter === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            onClick={() => onChange(tab.value)}
            aria-pressed={active}
            className={cn(
              "relative shrink-0 px-3 text-base leading-5 tracking-tight transition-colors",
              "after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:bg-current after:transition-opacity after:content-['']",
              active
                ? "font-semibold text-foreground after:opacity-100"
                : "text-muted-foreground hover:text-foreground after:opacity-0 hover:after:opacity-100",
            )}
          >
            <FormattedMessage {...tab.label} />
          </button>
        );
      })}
    </div>
  );
}

function StatPill({ count, icon: Icon, label, onClick }: {
  count: number;
  icon: typeof FolderGit2;
  label: string;
  onClick?: () => void;
}) {
  const Comp = onClick ? "button" : "div";
  return (
    <Comp
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className={cn(
        "flex flex-col clip-corner-lg bg-card px-3.5 py-3 text-left",
        onClick && "transition-colors hover:bg-foreground/[0.03]",
      )}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className="size-3.5 text-muted-foreground/70" />
      </span>
      <span className="mt-auto pt-4 text-4xl font-semibold leading-none tracking-tight text-foreground">{count}</span>
    </Comp>
  );
}

function Overview({
  repos,
  items,
  people,
  onSelect,
  onOpenItem,
  onLabelClick,
}: {
  repos: ProjectRepo[];
  items: ProjectWorkItem[];
  people: string[];
  onSelect: (f: Filter) => void;
  onOpenItem?: (item: ProjectWorkItem) => void;
  /** The overview can't show a label filter, so the click names a tab. */
  onLabelClick?: (label: string, target: Filter) => void;
}) {
  const intl = useIntl();
  const graph = useMemo(() => activityByDay(repos, items), [repos, items]);
  const prCount = items.filter((i) => i.kind !== "issue").length;
  const issueCount = items.filter((i) => i.kind === "issue").length;
  const repoNameByCoord = useMemo(() => new Map(repos.map((r) => [r.coord, r.name])), [repos]);
  const feed = useMemo(() => sortProjectWorkItems(items, "updated").slice(0, 20), [items]);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr))]">
        <StatPill
          count={repos.length}
          icon={FolderGit2}
          label={intl.formatMessage({ id: "projectsView.statRepositories", defaultMessage: "Repositories" })}
          onClick={() => onSelect("repositories")}
        />
        <StatPill
          count={prCount}
          icon={GitPullRequest}
          label={intl.formatMessage({ id: "projectsView.statPullRequests", defaultMessage: "Pull requests" })}
          onClick={() => onSelect("prs")}
        />
        <StatPill
          count={issueCount}
          icon={CircleDot}
          label={intl.formatMessage({ id: "projectsView.statIssues", defaultMessage: "Issues" })}
          onClick={() => onSelect("issues")}
        />
        <StatPill count={people.length} icon={Users} label={intl.formatMessage({ id: "projectsView.people", defaultMessage: "People" })} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section className="min-w-0 space-y-3">
          <h3 className="text-base font-semibold text-foreground">
            <FormattedMessage id="projectsView.recentActivity" defaultMessage="Recent activity" />
          </h3>
          {feed.length > 0 ? (
            <div className="clip-corner-lg bg-card divide-y divide-border/60">
              {feed.map((item) => (
                <WorkItemRow
                  key={item.id}
                  item={item}
                  repoName={item.repoCoord ? repoNameByCoord.get(item.repoCoord) : undefined}
                  onOpen={onOpenItem && (() => onOpenItem(item))}
                  onLabelClick={onLabelClick && ((label) => onLabelClick(label, item.kind === "issue" ? "issues" : "prs"))}
                />
              ))}
            </div>
          ) : (
            <p className="clip-hairline-lg [--fill-hover:var(--background)/0.4] px-4 py-10 text-center text-sm text-muted-foreground">
              <FormattedMessage id="projectsView.noActivity" defaultMessage="No activity yet." />
            </p>
          )}
        </section>

        <div className="min-w-0 space-y-6">
          <section className="space-y-3">
            <h3 className="text-base font-semibold text-foreground">
              <FormattedMessage id="projectsView.people" defaultMessage="People" />
            </h3>
            {people.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {people.slice(0, 18).map((pk) => <PersonAvatar key={pk} pubkey={pk} />)}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                <FormattedMessage id="projectsView.noPeople" defaultMessage="No people yet." />
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-base font-semibold text-foreground">
              <FormattedMessage id="projectsView.contributionActivity" defaultMessage="Contribution activity" />
            </h3>
            <ContributionGraph data={graph} />
            <ContributionLegend />
          </section>
        </div>
      </div>
    </div>
  );
}

// Width-derived columns: the view renders in panes narrower than the viewport.
const CARD_GRID = "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(20rem,1fr))]";

function CardsSkeleton() {
  return (
    <div className={CARD_GRID}>
      {["a", "b", "c", "d"].map((k) => <Skeleton key={k} className="h-44 w-full" />)}
    </div>
  );
}

function FilteredOutNotice({ onShowAll }: { onShowAll: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
      <p className="text-sm text-muted-foreground">
        <FormattedMessage id="projectsView.nothingMatches" defaultMessage="Nothing matches the current filters." />
      </p>
      <Button variant="outline" size="sm" onClick={onShowAll}>
        <FormattedMessage id="projectsView.showAll" defaultMessage="Show all" />
      </Button>
    </div>
  );
}

function FilterChip({ label, clearLabel, onClear }: { label: string; clearLabel: string; onClear: () => void }) {
  return (
    <Button variant="secondary" size="sm" className="h-7 max-w-48 gap-1 px-2 text-xs" aria-label={clearLabel} onClick={onClear}>
      <span className="truncate">{label}</span>
      <X className="size-3 shrink-0" />
    </Button>
  );
}

function EmptyState({ icon: Icon, title, hint }: { icon: typeof FolderGit2; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-20 text-center">
      <Icon className="size-10 text-muted-foreground/40" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

const STATUS_FILTER_LABELS = defineMessages({
  open: { id: "projectsView.statusFilter.open", defaultMessage: "open" },
  closed: { id: "projectsView.statusFilter.closed", defaultMessage: "closed" },
  all: { id: "projectsView.statusFilter.all", defaultMessage: "all" },
});

/** Shared presentational Projects surface; callers supply repos and work items. */
export function ProjectsView({
  repos,
  items: workItems,
  isLoading,
  intro,
  emptyHint,
  headerExtra,
  onOpenItem,
}: {
  repos: ProjectRepo[];
  items: ProjectWorkItem[];
  isLoading: boolean;
  intro?: string;
  emptyHint?: string;
  headerExtra?: React.ReactNode;
  onOpenItem?: (item: ProjectWorkItem) => void;
}) {
  const intl = useIntl();
  const [filter, setFilter] = useState<Filter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [sort, setSort] = useState<ProjectSort>("updated");
  const [statusFilter, setStatusFilter] = useState<"open" | "closed" | "all">("open");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // A repo detached while scoped falls back to the whole workspace.
  const activeRepo = useMemo(
    () => (repoFilter && repos.some((repo) => repo.coord === repoFilter) ? repoFilter : null),
    [repoFilter, repos],
  );
  const activeRepoName = useMemo(
    () => repos.find((repo) => repo.coord === activeRepo)?.name,
    [repos, activeRepo],
  );
  const items = useMemo(
    () => (activeRepo ? workItems.filter((item) => item.repoCoord === activeRepo) : workItems),
    [workItems, activeRepo],
  );
  const scopedRepos = useMemo(
    () => (activeRepo ? repos.filter((repo) => repo.coord === activeRepo) : repos),
    [repos, activeRepo],
  );

  // Workspace-wide so repo cards keep real counts while scoped.
  const summaries = useMemo(() => repoSummaries(workItems), [workItems]);
  const people = useMemo(() => projectPeople(scopedRepos, items), [scopedRepos, items]);
  const repoNameByCoord = useMemo(() => new Map(repos.map((r) => [r.coord, r.name])), [repos]);

  const visibleRepos = useMemo(() => {
    const list = repos.filter((repo) => repoMatchesQuery(repo, query));
    return sort === "name"
      ? list.sort((a, b) => a.name.localeCompare(b.name))
      : list.sort((a, b) => b.createdAt - a.createdAt);
  }, [repos, sort, query]);

  const prs = useMemo(() => items.filter((i) => i.kind !== "issue"), [items]);
  const issues = useMemo(() => items.filter((i) => i.kind === "issue"), [items]);
  // Judged workspace-wide: a scope hiding every PR is a filter, not an empty tracker.
  const anyPrs = useMemo(() => workItems.some((item) => item.kind !== "issue"), [workItems]);
  const anyIssues = useMemo(() => workItems.some((item) => item.kind === "issue"), [workItems]);
  // Drafts count as open.
  const matchesFilters = useCallback((item: ProjectWorkItem) => {
    const unresolved = item.status === "open" || item.status === "draft";
    if (statusFilter === "open" && !unresolved) return false;
    if (statusFilter === "closed" && unresolved) return false;
    if (labelFilter && !(item.labels ?? []).includes(labelFilter)) return false;
    const repoName = item.repoCoord ? repoNameByCoord.get(item.repoCoord) : undefined;
    return workItemMatchesQuery(item, query, repoName);
  }, [statusFilter, labelFilter, query, repoNameByCoord]);
  const filteredPrs = useMemo(() => sortProjectWorkItems(prs.filter(matchesFilters), sort), [prs, matchesFilters, sort]);
  const filteredIssues = useMemo(() => sortProjectWorkItems(issues.filter(matchesFilters), sort), [issues, matchesFilters, sort]);
  const toggleLabel = useCallback((label: string) => setLabelFilter((current) => (current === label ? null : label)), []);
  // From the overview, open the matching tab with the status gate released.
  const openLabel = useCallback((label: string, target: Filter) => {
    setLabelFilter(label);
    setStatusFilter("all");
    setFilter(target);
  }, []);
  const openRepo = useCallback((coord: string) => {
    setRepoFilter((current) => (current === coord ? null : coord));
    setFilter("all");
  }, []);
  const showAll = useCallback(() => {
    setStatusFilter("all");
    setLabelFilter(null);
    setRepoFilter(null);
    setQuery("");
  }, []);

  // "/" focuses search, except in editable targets or open dialogs.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || /^(input|textarea|select)$/i.test(target?.tagName ?? "")) return;
      if (document.querySelector("[role='dialog']")) return;
      const input = searchRef.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  const summaryOf = (coord: string): ProjectRepoSummary => summaries.get(coord) ?? { prCount: 0, issueCount: 0 };
  const peopleOf = (repo: ProjectRepo): string[] => [...new Set([repo.owner, ...repo.contributors])];

  const loading = isLoading;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground sm:text-sm">
          {intro ?? (
            <FormattedMessage
              id="projectsView.defaultIntro"
              defaultMessage="Browse this workspace's repositories and activity."
            />
          )}
        </p>
        {headerExtra}
      </div>

      {/* flex-wrap so controls drop to their own line when tabs stop fitting (no breakpoint can detect this in a narrow pane). */}
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
        <Tabs filter={filter} onChange={setFilter} />
        {(filter !== "all" || activeRepo) && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {activeRepo && (
              <FilterChip
                label={activeRepoName ?? activeRepo}
                clearLabel={intl.formatMessage({ id: "projectsView.showEveryRepository", defaultMessage: "Show every repository" })}
                onClear={() => setRepoFilter(null)}
              />
            )}
            {(filter === "prs" || filter === "issues") && labelFilter && (
              <FilterChip
                label={labelFilter}
                clearLabel={intl.formatMessage({ id: "projectsView.clearLabelFilter", defaultMessage: "Clear the label filter" })}
                onClear={() => setLabelFilter(null)}
              />
            )}
            {filter !== "all" && (
              <SearchField
                ref={searchRef}
                value={query}
                onChange={setQuery}
                placeholder={intl.formatMessage(common.search)}
                className="h-8 w-44 touch:h-10"
              />
            )}
            {(filter === "prs" || filter === "issues") && (
              <div className="flex items-center rounded-lg bg-muted/40 p-0.5">
                {(["open", "closed", "all"] as const).map((value) => (
                  <Button
                    key={value}
                    variant={statusFilter === value ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 px-2 text-xs capitalize"
                    aria-pressed={statusFilter === value}
                    onClick={() => setStatusFilter(value)}
                  >
                    <FormattedMessage {...STATUS_FILTER_LABELS[value]} />
                  </Button>
                ))}
              </div>
            )}
            {filter !== "all" && (
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as ProjectSort)}
                aria-label={intl.formatMessage({ id: "projectsView.sort", defaultMessage: "Sort" })}
                className="h-8 clip-corner-lg bg-transparent px-2 text-xs text-foreground outline-none hover:bg-foreground/5 focus:ring-1 focus:ring-ring"
              >
                <option value="updated">{intl.formatMessage({ id: "projectsView.sortRecent", defaultMessage: "Recent" })}</option>
                <option value="name">{intl.formatMessage({ id: "projectsView.sortName", defaultMessage: "Name" })}</option>
              </select>
            )}
            {filter === "repositories" && (
              <div className="flex items-center rounded-lg bg-muted/40 p-0.5">
                <Button
                  variant={viewMode === "grid" ? "secondary" : "ghost"}
                  size="icon"
                  className="size-7 touch:size-11"
                  aria-label={intl.formatMessage({ id: "projectsView.gridLayout", defaultMessage: "Grid layout" })}
                  aria-pressed={viewMode === "grid"}
                  onClick={() => setViewMode("grid")}
                >
                  <LayoutGrid className="size-3.5" />
                </Button>
                <Button
                  variant={viewMode === "list" ? "secondary" : "ghost"}
                  size="icon"
                  className="size-7 touch:size-11"
                  aria-label={intl.formatMessage({ id: "projectsView.listLayout", defaultMessage: "List layout" })}
                  aria-pressed={viewMode === "list"}
                  onClick={() => setViewMode("list")}
                >
                  <List className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="pt-6">
        {loading ? (
          <CardsSkeleton />
        ) : repos.length === 0 ? (
          <EmptyState
            icon={FolderGit2}
            title={intl.formatMessage({ id: "projectsView.noProjects", defaultMessage: "No projects yet" })}
            hint={
              emptyHint
              ?? intl.formatMessage({ id: "projectsView.defaultEmptyHint", defaultMessage: "Repositories pushed to this workspace will appear here." })
            }
          />
        ) : filter === "all" ? (
          <Overview repos={scopedRepos} items={items} people={people} onSelect={setFilter} onOpenItem={onOpenItem} onLabelClick={openLabel} />
        ) : filter === "repositories" ? (
          visibleRepos.length === 0 ? (
            <FilteredOutNotice onShowAll={showAll} />
          ) : viewMode === "grid" ? (
            <div className={CARD_GRID}>
              {visibleRepos.map((repo) => (
                <RepoCard
                  key={repo.coord}
                  repo={repo}
                  summary={summaryOf(repo.coord)}
                  people={peopleOf(repo)}
                  selected={repo.coord === activeRepo}
                  onOpen={() => openRepo(repo.coord)}
                />
              ))}
            </div>
          ) : (
            <div className="clip-corner-lg bg-card divide-y divide-border/60">
              {visibleRepos.map((repo) => (
                <RepoRow
                  key={repo.coord}
                  repo={repo}
                  summary={summaryOf(repo.coord)}
                  people={peopleOf(repo)}
                  selected={repo.coord === activeRepo}
                  onOpen={() => openRepo(repo.coord)}
                />
              ))}
            </div>
          )
        ) : filter === "prs" ? (
          filteredPrs.length > 0 ? (
            <div className="clip-corner-lg bg-card divide-y divide-border/60">
              {filteredPrs.map((item) => (
                <WorkItemRow
                  key={item.id}
                  item={item}
                  repoName={item.repoCoord ? repoNameByCoord.get(item.repoCoord) : undefined}
                  onOpen={onOpenItem && (() => onOpenItem(item))}
                  onLabelClick={toggleLabel}
                />
              ))}
            </div>
          ) : anyPrs ? (
            <FilteredOutNotice onShowAll={showAll} />
          ) : (
            <EmptyState
              icon={GitPullRequest}
              title={intl.formatMessage({ id: "projectsView.noPullRequests", defaultMessage: "No pull requests" })}
              hint={intl.formatMessage({ id: "projectsView.noPullRequestsHint", defaultMessage: "Patches and PRs opened on this workspace will appear here." })}
            />
          )
        ) : filteredIssues.length > 0 ? (
          <div className="clip-corner-lg bg-card divide-y divide-border/60">
            {filteredIssues.map((item) => (
              <WorkItemRow
                key={item.id}
                item={item}
                repoName={item.repoCoord ? repoNameByCoord.get(item.repoCoord) : undefined}
                onOpen={onOpenItem && (() => onOpenItem(item))}
                onLabelClick={toggleLabel}
              />
            ))}
          </div>
        ) : anyIssues ? (
          <FilteredOutNotice onShowAll={showAll} />
        ) : (
          <EmptyState
            icon={CircleDot}
            title={intl.formatMessage({ id: "projectsView.noIssues", defaultMessage: "No issues" })}
            hint={intl.formatMessage({ id: "projectsView.noIssuesHint", defaultMessage: "Issues opened on this workspace will appear here." })}
          />
        )}
      </div>
    </div>
  );
}
