import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import { ArrowLeft, Bug, FlaskConical, Minus, Package, Plus, RefreshCw, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { parseChangelog } from "@/lib/changelog";
import type { ChangelogCategory, ChangelogEntry } from "@/lib/changelog";
import { useBackOrHome } from "@/hooks/useBackOrHome";
import { useReleases } from "@/hooks/useReleases";
import { RELEASE_KIND } from "@/lib/releases";
import { common, defineMessages, FormattedMessage, useIntl, type MessageDescriptor } from "@/i18n";

const REPO_URL = "https://gitworkshop.dev/soapbox.pub/relay.ngit.dev/armada";

/** GitWorkshop's page for a version's NIP-82 release, or the release list until it resolves. */
function useReleaseUrl(version: string): string {
  const { data: releases } = useReleases();
  const release = releases?.find((r) => r.version === version);
  if (!release) return `${REPO_URL}/releases`;
  return `${REPO_URL}/releases/${nip19.neventEncode({ id: release.id, author: release.pubkey, kind: RELEASE_KIND })}`;
}

/** Per-category icon + color used as inline list bullets. */
const CATEGORY_STYLES: Record<ChangelogCategory, { icon: typeof Plus; colorClass: string }> = {
  Added:      { icon: Plus,        colorClass: "text-emerald-600 dark:text-emerald-400" },
  Changed:    { icon: RefreshCw,   colorClass: "text-blue-600 dark:text-blue-400" },
  Deprecated: { icon: Package,     colorClass: "text-orange-600 dark:text-orange-400" },
  Removed:    { icon: Minus,       colorClass: "text-red-600 dark:text-red-400" },
  Fixed:      { icon: Bug,         colorClass: "text-amber-600 dark:text-amber-400" },
  Security:   { icon: ShieldAlert, colorClass: "text-purple-600 dark:text-purple-400" },
};

const CATEGORY_LABELS: Record<ChangelogCategory, MessageDescriptor> = defineMessages({
  Added: { id: "changelogPage.category.added", defaultMessage: "Added" },
  Changed: { id: "changelogPage.category.changed", defaultMessage: "Changed" },
  Deprecated: { id: "changelogPage.category.deprecated", defaultMessage: "Deprecated" },
  Removed: { id: "changelogPage.category.removed", defaultMessage: "Removed" },
  Fixed: { id: "changelogPage.category.fixed", defaultMessage: "Fixed" },
  Security: { id: "changelogPage.category.security", defaultMessage: "Security" },
});

/** Format "2026-03-26" as a readable date string. */
function formatDate(raw: string, locale: string): string {
  const date = new Date(raw + "T00:00:00");
  if (isNaN(date.getTime())) return raw;
  return date.toLocaleDateString(locale, { year: "numeric", month: "long", day: "numeric" });
}

const commitSha = import.meta.env.COMMIT_SHA;
// GitWorkshop resolves only full SHAs (a short one is looked up as a ref name).
const fullCommitSha = import.meta.env.COMMIT_SHA_FULL;
const commitTag = import.meta.env.COMMIT_TAG;
const buildDate = import.meta.env.BUILD_DATE;
const isPreRelease = !commitTag;

export function ChangelogPage() {
  const intl = useIntl();
  const back = useBackOrHome();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    fetch("/CHANGELOG.md")
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText);
        return res.text();
      })
      .then(setContent)
      .catch(() => setError(true));
  }, []);

  const entries = useMemo(() => (content ? parseChangelog(content) : []), [content]);
  const latestVersion = entries[0]?.version;

  return (
    <main className="flex-1 min-w-0 flex flex-col safe-area-top">
      <header className="relative h-12 touch:h-[3.25rem] mx-gutter mt-1 sidebar:mt-3 w-[calc(100%-2*var(--gutter))] max-w-2xl sm:mx-auto px-2 sidebar:px-3 flex items-center gap-1.5 shrink-0 clip-corner-lg bg-chrome">
        <Button variant="ghost" size="icon" className="size-9 shrink-0" aria-label={intl.formatMessage(common.back)} onClick={back}>
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="font-semibold truncate leading-tight">
          <FormattedMessage id="changelogPage.title" defaultMessage="Changelog" />
        </h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto safe-area-bottom">
        <div className="max-w-2xl mx-auto px-4 sm:px-6 pb-16 pt-3 space-y-4">
          {error ? (
            <p className="text-sm text-muted-foreground pt-4">
              <FormattedMessage id="changelogPage.loadFailed" defaultMessage="Failed to load changelog." />
            </p>
          ) : content === null ? (
            <ChangelogSkeleton />
          ) : entries.length === 0 ? (
            <p className="text-sm text-muted-foreground pt-4">
              <FormattedMessage id="changelogPage.empty" defaultMessage="No releases yet." />
            </p>
          ) : (
            <>
              {isPreRelease && latestVersion && <PreReleaseBanner latestVersion={latestVersion} />}

              <LatestRelease entry={entries[0]} />

              {entries.length > 1 && (
                <>
                  <div className="flex items-center gap-3 pt-4 pb-1">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      <FormattedMessage id="changelogPage.pastReleases" defaultMessage="Past releases" />
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  {entries.slice(1).map((entry) => (
                    <ChangelogEntryCard key={entry.version} entry={entry} />
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}

/** Hero treatment for the most recent release — no card, centered version + date. */
function LatestRelease({ entry }: { entry: ChangelogEntry }) {
  const intl = useIntl();
  const contentRef = useRef<HTMLUListElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const releaseUrl = useReleaseUrl(entry.version);

  const measure = useCallback(() => {
    const el = contentRef.current;
    if (el) setOverflows(el.scrollHeight > ENTRY_MAX_HEIGHT);
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return (
    <div className="pt-2 pb-1 px-4">
      <a
        href={releaseUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="block text-center text-2xl font-bold tracking-tight hover:underline"
      >
        v{entry.version}
      </a>
      <a
        href={releaseUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
      >
        {formatDate(entry.date, intl.locale)}
      </a>

      <div className="relative mt-4">
        <ul
          ref={contentRef}
          style={!expanded && overflows ? { maxHeight: ENTRY_MAX_HEIGHT, overflow: "hidden" } : undefined}
          className="space-y-2.5"
        >
          {entry.summary && (
            <li className="text-base text-foreground/90 leading-relaxed">
              {entry.summary}
            </li>
          )}
          {entry.sections.flatMap((section) => {
            const style = CATEGORY_STYLES[section.category] ?? CATEGORY_STYLES.Changed;
            const Icon = style.icon;

            return section.items.map((item, i) => (
              <li key={`${section.category}-${i}`} className="flex gap-2 text-base text-foreground/90">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Icon className={`size-4 shrink-0 mt-1 cursor-default ${style.colorClass}`} />
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {CATEGORY_LABELS[section.category] ? intl.formatMessage(CATEGORY_LABELS[section.category]) : section.category}
                  </TooltipContent>
                </Tooltip>
                <span>{item}</span>
              </li>
            ));
          })}
        </ul>
        {!expanded && overflows && (
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-background to-transparent pointer-events-none" />
        )}
      </div>

      {overflows && (
        <button
          className="w-full text-sm text-primary hover:underline mt-1"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <FormattedMessage id="changelogPage.showLess" defaultMessage="Show less" />
          ) : (
            <FormattedMessage id="changelogPage.readMore" defaultMessage="Read more" />
          )}
        </button>
      )}

    </div>
  );
}

const ENTRY_MAX_HEIGHT = 240; // px — entries taller than this get a "Read more" button

/** A single changelog release card with truncation for long entries. */
function ChangelogEntryCard({ entry }: { entry: ChangelogEntry }) {
  const intl = useIntl();
  const contentRef = useRef<HTMLUListElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const releaseUrl = useReleaseUrl(entry.version);

  const measure = useCallback(() => {
    const el = contentRef.current;
    if (el) setOverflows(el.scrollHeight > ENTRY_MAX_HEIGHT);
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  return (
    <div className="clip-hairline-lg [--edge:var(--border)/0.5] p-px overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <a
          href={releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-sm hover:underline"
        >
          v{entry.version}
        </a>
        <a
          href={releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors ml-auto"
        >
          <span>{formatDate(entry.date, intl.locale)}</span>
        </a>
      </div>

      <div className="relative">
        <ul
          ref={contentRef}
          style={!expanded && overflows ? { maxHeight: ENTRY_MAX_HEIGHT, overflow: "hidden" } : undefined}
          className="px-4 py-3 space-y-2.5"
        >
          {entry.summary && (
            <li className="text-sm text-foreground/90 leading-relaxed">
              {entry.summary}
            </li>
          )}
          {entry.sections.flatMap((section) => {
            const style = CATEGORY_STYLES[section.category] ?? CATEGORY_STYLES.Changed;
            const Icon = style.icon;

            return section.items.map((item, i) => (
              <li key={`${section.category}-${i}`} className="flex gap-2 text-sm text-foreground/90">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Icon className={`size-3.5 shrink-0 mt-[3px] cursor-default ${style.colorClass}`} />
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    {CATEGORY_LABELS[section.category] ? intl.formatMessage(CATEGORY_LABELS[section.category]) : section.category}
                  </TooltipContent>
                </Tooltip>
                <span>{item}</span>
              </li>
            ));
          })}
        </ul>
        {!expanded && overflows && (
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-background to-transparent pointer-events-none" />
        )}
      </div>

      {overflows && (
        <button
           className="w-full text-sm text-primary hover:underline py-2"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <FormattedMessage id="changelogPage.showLess" defaultMessage="Show less" />
          ) : (
            <FormattedMessage id="changelogPage.readMore" defaultMessage="Read more" />
          )}
        </button>
      )}
    </div>
  );
}

/** Banner shown at the top of the changelog for untagged (pre-release) builds. */
function PreReleaseBanner({ latestVersion }: { latestVersion: string }) {
  const intl = useIntl();
  return (
    <div className="clip-hairline-lg [--edge:var(--warning)/0.5] [--fill:var(--warning)/0.05] [--fill-hover:var(--warning)/0.05] px-4 py-3 space-y-1.5">
      <div className="flex items-center gap-2">
        <FlaskConical className="size-4 text-warning shrink-0" />
        <span className="text-sm font-medium text-warning">
          <FormattedMessage id="changelogPage.preRelease.title" defaultMessage="Pre-release build" />
        </span>
        {commitSha && buildDate && (
          <a
            href={fullCommitSha ? `${REPO_URL}/commit/${fullCommitSha}` : `${REPO_URL}/commits`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-2xs text-warning/70 hover:text-warning transition-colors"
          >
            {formatDate(buildDate.split("T")[0], intl.locale)}
          </a>
        )}
      </div>
      <p className="text-xs text-warning/80">
        <FormattedMessage
          id="changelogPage.preRelease.description"
          defaultMessage="This build contains changes not yet included in a release. <link>View unreleased changes</link>"
          values={{
            link: (chunks) => (
              <a
                href={`${REPO_URL}/compare/v${latestVersion}...${fullCommitSha || "main"}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-warning transition-colors"
              >
                {chunks}
              </a>
            ),
          }}
        />
      </p>
    </div>
  );
}

function ChangelogSkeleton() {
  return (
    <div className="space-y-4 pt-1">
      {[1, 2].map((i) => (
        <div key={i} className="clip-hairline-lg [--edge:var(--border)/0.5] p-px overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
            <Skeleton className="size-4 rounded" />
            <Skeleton className="h-4 w-16" />
            <div className="ml-auto flex items-center gap-1.5">
              <Skeleton className="size-3.5 rounded" />
              <Skeleton className="h-3 w-24" />
            </div>
          </div>
          <div className="px-4 py-3 space-y-2">
            <Skeleton className="h-4 w-16 rounded-full" />
            <Skeleton className="h-4 w-full ml-3" />
            <Skeleton className="h-4 w-4/5 ml-3" />
            <Skeleton className="h-4 w-3/5 ml-3" />
          </div>
        </div>
      ))}
    </div>
  );
}
